/**
 * Child-direct activity and connected apps (spec §9.1, §9.2).
 *
 * Shapes the child's bunker produces (Task 11) and the rails (Task 12):
 * connected-apps record, gift-wrapped activity, unpaired notice, merged timeline.
 */
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { getConversationKey, encrypt, decrypt } from 'nostr-tools/nip44';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import { sealVaultPayload, openVaultPayload, MAX_ENVELOPE_CHARS } from './vault-envelope';
import { sanitizeDisplayName } from './text-sanitize';
import { giftWrap } from './relay-publish';
import { LocalSigningBackend } from './signing-backend';
import { unwrapWrappedRumorWithKey, type AuditEntry } from './audit-fetch';
import { AUDIT_EVENT_KIND } from './audit';
import { TARGET_RE } from './child-rules-wire';
import type { GuardianActingEntry } from './guardian-acting';


/** An app or site the child's phone has served (spec §9.1). Unix seconds. */
export interface ConnectedChildApp {
  /** NIP-46 client pubkey, `nip55:<package>`, or the site origin. */
  appId: string;
  kind: 'nip46' | 'nip55' | 'site';
  label: string;
  url?: string;
  /** Persona pubkey the app was served as. */
  persona: string;
  firstSeen: number;
  lastUsed: number;
}

/**
 * One decision of the child's gate (spec §9.2). `at` and `requestCreatedAt`
 * are unix seconds; `requestCreatedAt` is the forced NIP-46 request
 * `created_at` the Heartwood echoes in its C5 rumor (set on `signed` and
 * `approved`, i.e. whenever the request is forwarded).
 */
export interface ChildActivityEntry {
  persona: string;
  kind: number | null;
  method: string;
  outcome: 'signed' | 'denied' | 'asked' | 'approved' | 'blocked' | 'expired';
  appId: string;
  appLabel: string;
  target?: string;
  requestCreatedAt?: number;
  at: number;
}

// ── Rails ────────────────────────────────────────────────────────────────
/** Child → guardian connected-apps record (replaceable, child client → rail). */
export const CHILD_CONNECTED_APPS_D_TAG = 'signet:child-connected-apps:v1';
/** Guardian → child "this phone is unpaired" notice, authored by the rail key. */
export const CHILD_UNPAIRED_D_TAG = 'signet:child-unpaired:v1';
/** Entries a connected-apps record carries (most recently used). */
export const CONNECTED_APPS_MAX = 64;
/** A device-only signing older than this with no child record is flagged (spec §9.2). */
export const ACTIVITY_MISMATCH_AFTER_S = 600;
/** The device may bump a colliding `created_at` by a second; allow +0..+2 s. */
export const ACTIVITY_JOIN_WINDOW_S = 2;

const KIND = 30078;
const HEX64 = /^[0-9a-f]{64}$/;
const OUTCOMES: readonly ChildActivityEntry['outcome'][] = ['signed', 'denied', 'asked', 'approved', 'blocked', 'expired'];
const APP_KINDS: readonly ConnectedChildApp['kind'][] = ['nip46', 'nip55', 'site'];
const METHOD_RE = /^[a-z0-9_]{1,32}$/;
const APP_ID_RE = /^[^\s]{1,200}$/;
const posInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

function parseApp(raw: unknown): ConnectedChildApp | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.appId !== 'string' || !APP_ID_RE.test(a.appId)) return null;
  if (typeof a.kind !== 'string' || !APP_KINDS.includes(a.kind as ConnectedChildApp['kind'])) return null;
  if (typeof a.persona !== 'string' || !HEX64.test(a.persona)) return null;
  if (!posInt(a.firstSeen) || !posInt(a.lastUsed)) return null;
  const label = typeof a.label === 'string' ? sanitizeDisplayName(a.label, 100) : '';
  const out: ConnectedChildApp = {
    appId: a.appId, kind: a.kind as ConnectedChildApp['kind'], label: label || a.appId.slice(0, 16),
    persona: a.persona, firstSeen: a.firstSeen, lastUsed: a.lastUsed,
  };
  if (typeof a.url === 'string' && a.url.length <= 300 && /^https?:\/\/[^\s]+$/i.test(a.url)) out.url = a.url;
  return out;
}

/** The newest `CONNECTED_APPS_MAX` apps, most recently used first. */
function capApps(apps: ConnectedChildApp[]): ConnectedChildApp[] {
  return [...apps].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, CONNECTED_APPS_MAX);
}

/**
 * The child's connected apps (spec §9.1), vault-sealed to the rail pubkey and
 * signed by the child's client key. Replaceable; the newest 64 by `lastUsed`.
 */
export async function buildConnectedAppsEvent(
  apps: ConnectedChildApp[], clientPrivateKey: string, railPubkey: string, nowS: number = Math.floor(Date.now() / 1000),
): Promise<NostrEvent> {
  if (!HEX64.test(railPubkey) || !Number.isSafeInteger(nowS)) throw new Error('Invalid connected apps target');
  const clean = capApps(apps.map(parseApp).filter((a): a is ConnectedChildApp => a !== null));
  const sk = hexToBytes(clientPrivateKey);
  try {
    const clientPub = getPublicKey(sk);
    const sealed = await sealVaultPayload(JSON.stringify({ v: 1, apps: clean, updatedAt: nowS }), {
      activePublicKeyHex: clientPub,
      nip44Encrypt: async (pub: string, text: string) => encrypt(text, getConversationKey(sk, pub)),
    }, { recipientPubkey: railPubkey });
    if (sealed === null) throw new Error('too-large');
    return finalizeEvent({
      kind: KIND, created_at: nowS,
      tags: [['d', CHILD_CONNECTED_APPS_D_TAG], ['p', railPubkey]], content: sealed,
    }, sk) as unknown as NostrEvent;
  } finally { sk.fill(0); }
}

/** NIP-44 is symmetric: the rail (reader) and the child (author, reading back its own) share one key. */
async function openConnectedApps(ev: NostrEvent, mySk: Uint8Array, peerPub: string, authorPub: string, railPub: string): Promise<ConnectedChildApp[] | null> {
  if (!ev || ev.pubkey !== authorPub || ev.kind !== KIND || typeof ev.content !== 'string'
    || ev.content.length > MAX_ENVELOPE_CHARS || !Array.isArray(ev.tags) || ev.tags.length !== 2
    || ev.tags[0]?.length !== 2 || ev.tags[0][0] !== 'd' || ev.tags[0][1] !== CHILD_CONNECTED_APPS_D_TAG
    || ev.tags[1]?.length !== 2 || ev.tags[1][0] !== 'p' || ev.tags[1][1] !== railPub) return null;
  if (!verifyEvent({ id: ev.id, sig: ev.sig, pubkey: ev.pubkey, kind: ev.kind, created_at: ev.created_at,
    tags: ev.tags.map(t => [...t]), content: ev.content })) return null;
  const plaintext = await openVaultPayload(ev.content, {
    nip44Decrypt: async (pub: string, text: string) => decrypt(text, getConversationKey(mySk, pub)),
  }, peerPub, { legacyFallback: false });
  if (plaintext === null) return null;
  const o = JSON.parse(plaintext) as Record<string, unknown>;
  if (!o || typeof o !== 'object' || o.v !== 1 || !Array.isArray(o.apps) || o.apps.length > CONNECTED_APPS_MAX) return null;
  return capApps(o.apps.map(parseApp).filter((a): a is ConnectedChildApp => a !== null));
}

/** Guardian side: open with the rail private key, author pinned to the child's client key. */
export async function openConnectedAppsEvent(ev: NostrEvent, railPrivateKey: string, clientPubkey: string): Promise<ConnectedChildApp[] | null> {
  let sk: Uint8Array | null = null;
  try {
    if (!HEX64.test(clientPubkey)) return null;
    sk = hexToBytes(railPrivateKey);
    return await openConnectedApps(ev, sk, clientPubkey, clientPubkey, getPublicKey(sk));
  } catch { return null; }
  finally { sk?.fill(0); }
}

/** Child side: read back our own record (to seed the list after a restart). */
export async function openOwnConnectedAppsEvent(ev: NostrEvent, clientPrivateKey: string, railPubkey: string): Promise<ConnectedChildApp[] | null> {
  let sk: Uint8Array | null = null;
  try {
    if (!HEX64.test(railPubkey)) return null;
    sk = hexToBytes(clientPrivateKey);
    return await openConnectedApps(ev, sk, railPubkey, getPublicKey(sk), railPubkey);
  } catch { return null; }
  finally { sk?.fill(0); }
}

/**
 * One gate decision as a kind-31000 rumor (the audit schema: `t:audit`, `d`,
 * `k`, `method`, `outcome`, plus `persona`, `app`, `app-label`, `target`,
 * `req-created-at`), sealed by the child's client key and gift-wrapped to the
 * rail pubkey (spec §9.2). Metadata only — never the event content.
 */
export async function wrapChildActivity(e: ChildActivityEntry, clientPrivateKey: string, railPubkey: string): Promise<NostrEvent> {
  if (!HEX64.test(railPubkey) || !HEX64.test(e.persona) || !OUTCOMES.includes(e.outcome) || !posInt(e.at)
    || !METHOD_RE.test(e.method) || !APP_ID_RE.test(e.appId)) throw new Error('Invalid child activity');
  const backend = new LocalSigningBackend(clientPrivateKey);
  try {
    const tags: string[][] = [
      ['t', 'audit'],
      ['d', `${e.persona}:${e.at}:${bytesToHex(randomBytes(4))}`],
    ];
    if (e.kind !== null && Number.isInteger(e.kind) && e.kind >= 0 && e.kind <= 65535) tags.push(['k', String(e.kind)]);
    tags.push(['method', e.method], ['outcome', e.outcome], ['persona', e.persona], ['app', e.appId],
      ['app-label', sanitizeDisplayName(e.appLabel, 100)]);
    if (e.target && e.target.length <= 260 && TARGET_RE.test(e.target)) tags.push(['target', e.target]);
    if (posInt(e.requestCreatedAt)) tags.push(['req-created-at', String(e.requestCreatedAt)]);
    const rumor: UnsignedEvent = { kind: AUDIT_EVENT_KIND, pubkey: backend.activePublicKeyHex, created_at: e.at, tags, content: '' };
    return await giftWrap(rumor, railPubkey, backend);
  } finally { backend.destroy?.(); }
}

const CHILD_ACTIVITY_SPEC = { rumorKind: AUDIT_EVENT_KIND, requiredTag: ['t', ['audit']] as [string, string[]] };

/** Guardian side: unwrap with the rail private key, author pinned to the child's client key. */
export async function unwrapChildActivity(ev: NostrEvent, railPrivateKey: string, clientPubkey: string): Promise<ChildActivityEntry | null> {
  if (!HEX64.test(clientPubkey)) return null;
  if (!ev || typeof ev.content !== 'string' || ev.content.length > MAX_ENVELOPE_CHARS) return null;
  const rumor = await unwrapWrappedRumorWithKey(ev, railPrivateKey, clientPubkey, CHILD_ACTIVITY_SPEC);
  if (!rumor || rumor.content !== '' || !posInt(rumor.created_at)) return null;
  const tag = (k: string): string | undefined => rumor.tags.find(t => t[0] === k && typeof t[1] === 'string')?.[1];
  const persona = tag('persona');
  const outcome = tag('outcome') as ChildActivityEntry['outcome'] | undefined;
  const method = tag('method');
  const appId = tag('app');
  if (!persona || !HEX64.test(persona) || !outcome || !OUTCOMES.includes(outcome)) return null;
  if (!method || !METHOD_RE.test(method) || !appId || !APP_ID_RE.test(appId)) return null;
  let kind: number | null = null;
  const k = tag('k');
  if (k !== undefined) {
    if (!/^\d{1,5}$/.test(k) || Number(k) > 65535) return null;
    kind = Number(k);
  }
  const out: ChildActivityEntry = {
    persona, kind, method, outcome, appId,
    appLabel: sanitizeDisplayName(tag('app-label') ?? '', 100) || appId.slice(0, 16),
    at: rumor.created_at,
  };
  const target = tag('target');
  if (target && target.length <= 260 && TARGET_RE.test(target)) out.target = target;
  const req = tag('req-created-at');
  if (req && /^\d{1,12}$/.test(req) && posInt(Number(req))) out.requestCreatedAt = Number(req);
  return out;
}

// ── Unpaired notice ────────────────────────────────────────────────────────

/** Guardian → child: "this phone is unpaired" (spec §9.4), authored by the rail key, `p` = the client. */
export function buildUnpairedNotice(railPrivateKey: string, clientPubkey: string, nowS: number = Math.floor(Date.now() / 1000)): NostrEvent {
  if (!HEX64.test(clientPubkey) || !Number.isSafeInteger(nowS)) throw new Error('Invalid unpaired notice');
  const sk = hexToBytes(railPrivateKey);
  try {
    return finalizeEvent({
      kind: KIND, created_at: nowS,
      tags: [['d', CHILD_UNPAIRED_D_TAG], ['p', clientPubkey]],
      content: JSON.stringify({ v: 1, clientPubkey }),
    }, sk) as unknown as NostrEvent;
  } finally { sk.fill(0); }
}

/** True only for a validly signed notice from `railPubkey` naming exactly `clientPubkey`. */
export function isUnpairedNotice(ev: NostrEvent, railPubkey: string, clientPubkey: string): boolean {
  try {
    if (!ev || ev.kind !== KIND || ev.pubkey !== railPubkey || !HEX64.test(railPubkey) || !HEX64.test(clientPubkey)) return false;
    if (!Array.isArray(ev.tags) || ev.tags.length !== 2 || typeof ev.content !== 'string' || ev.content.length > 1000) return false;
    if (ev.tags[0]?.[0] !== 'd' || ev.tags[0][1] !== CHILD_UNPAIRED_D_TAG || ev.tags[1]?.[0] !== 'p' || ev.tags[1][1] !== clientPubkey) return false;
    const body = JSON.parse(ev.content) as Record<string, unknown>;
    if (!body || body.v !== 1 || body.clientPubkey !== clientPubkey) return false;
    return verifyEvent({ id: ev.id, sig: ev.sig, pubkey: ev.pubkey, kind: ev.kind, created_at: ev.created_at,
      tags: ev.tags.map(t => [...t]), content: ev.content });
  } catch { return false; }
}

// ── Merged timeline ────────────────────────────────────────────────────────

export interface MergedActivityRow {
  entry: ChildActivityEntry | null;
  device: AuditEntry | null;
  mismatch: boolean;
  /** A48: the device record matches a signing the guardian's own phone made as this persona. */
  byGuardian?: boolean;
}

const DEVICE_SIGNED = new Set(['approved', 'auto-approved']);

type OpLike = Pick<ChildActivityEntry, 'persona' | 'kind' | 'method'>;

function sameOp(c: OpLike, d: AuditEntry): boolean {
  if (c.persona !== d.dependantPubkey) return false;
  if (c.kind !== null) return d.eventKind === c.kind;
  if (d.eventKind !== undefined) return false;
  return !d.method || d.method === c.method;
}

/**
 * Join the child's own records with the Heartwood's C5 records (spec §9.2) on
 * (persona, kind, forced request `created_at`). The device's `created_at` is
 * the request's, or bumped up to +2 s on a collision: each device record takes
 * the nearest unused child record in that window. A48: a device record no
 * child record claims is then matched the same way against the guardian's own
 * signings as the child (`guardian`) — shown "Signed by you", never flagged.
 * A device-only SIGNING older than 600 s is flagged; a child-only row
 * (denied/asked/blocked never reach the device) is shown as-is. Newest first.
 */
export function mergeActivity(child: ChildActivityEntry[], device: AuditEntry[], nowS: number, guardian: GuardianActingEntry[] = []): MergedActivityRow[] {
  const rows: MergedActivityRow[] = [];
  const used = new Set<number>();
  const usedGuardian = new Set<number>();
  const nearest = <T extends OpLike & { requestCreatedAt?: number }>(list: T[], taken: Set<number>, d: AuditEntry): number => {
    let best = -1, bestDelta = Infinity;
    list.forEach((c, i) => {
      if (taken.has(i) || c.requestCreatedAt === undefined || !sameOp(c, d)) return;
      const delta = d.createdAt - c.requestCreatedAt;
      if (delta < 0 || delta > ACTIVITY_JOIN_WINDOW_S) return;
      if (delta < bestDelta || (delta === bestDelta && c.requestCreatedAt < list[best].requestCreatedAt!)) { best = i; bestDelta = delta; }
    });
    return best;
  };
  const devices = [...device].sort((a, b) => a.createdAt - b.createdAt);
  for (const d of devices) {
    const best = nearest(child, used, d);
    if (best >= 0) {
      used.add(best);
      rows.push({ entry: child[best], device: d, mismatch: false });
      continue;
    }
    const mine = nearest(guardian, usedGuardian, d);
    if (mine >= 0) {
      usedGuardian.add(mine);
      rows.push({ entry: null, device: d, mismatch: false, byGuardian: true });
    } else {
      rows.push({ entry: null, device: d, mismatch: DEVICE_SIGNED.has(d.outcome) && nowS - d.createdAt > ACTIVITY_MISMATCH_AFTER_S });
    }
  }
  child.forEach((c, i) => { if (!used.has(i)) rows.push({ entry: c, device: null, mismatch: false }); });
  const when = (r: MergedActivityRow) => r.device?.createdAt ?? r.entry?.at ?? 0;
  return rows.sort((a, b) => when(b) - when(a));
}
