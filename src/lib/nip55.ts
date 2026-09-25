/**
 * NIP-55, the Android signer intent, on the web side of the MySignet APK.
 *
 * The native shell receives `nostrsigner:` intents and content-provider
 * queries from other apps on the phone (Amethyst, KithMoot, anything
 * Amber-shaped) and hands each one here as a plain record. This module is
 * the pure part: what a request means, whether it is well-formed, and what
 * to do with it before any key is touched. The decision table mirrors
 * Cambium's `IntentGate` / `ProviderGate`, so an app gets the same
 * behaviour from either ForgeSworn signer on the same phone
 * (internal design notes, 14 July 2026 convergence note).
 *
 * Nothing in here knows about React, Capacitor or the keystore.
 */
import { nip19 } from 'nostr-tools';
import type { UnsignedEvent } from 'signet-protocol';

export type Nip55Method = 'get_public_key' | 'sign_event' | 'nip44_encrypt' | 'nip44_decrypt';

/** What the native shell lifts off an intent or a provider query. */
export interface NativeNip55Request {
  /** The shell's handle for this request; the answer carries it back. */
  id: string;
  /** The calling app's package name, when Android could tell us. */
  callerPackage: string | null;
  /** The calling app's name as the phone shows it, when the shell could look it up. */
  callerLabel?: string | null;
  type: string;
  /** The `nostrsigner:<payload>` part, or the provider's first projection column. */
  payload: string | null;
  /** The other party's key, for the encrypt / decrypt methods. */
  peerPubkey: string | null;
  /** `current_user`: which of the person's keys the app means. npub or hex. */
  currentUser: string | null;
  /** `get_public_key` only: the raw JSON `permissions` extra. */
  permissions: string | null;
  /** True when this came through the content provider, which cannot show a screen. */
  viaProvider: boolean;
}

export interface ParsedNip55 {
  method: Nip55Method;
  /** `sign_event`: the template, as the app sent it. */
  template?: UnsignedEvent;
  /** The crypto methods: the other party, hex. */
  peer?: string;
  /** The crypto methods: what to encrypt or decrypt. */
  payload?: string;
  /** Hex, when the app named a key. */
  currentUser?: string;
  /** `get_public_key`: what the app says it will ask for, display only. */
  permissions: string[];
}

/** What this phone remembers about one calling app. */
export interface Nip55Grant {
  /** The key the person chose for this app. */
  pubkey: string;
  /** Sign without asking, for this app and this key. */
  allowAlways: boolean;
  /** Refuse without asking. */
  denyAlways: boolean;
  grantedAt: number;
  /** The app's name as the phone showed it when the person decided; absent for grants made before it was recorded. */
  label?: string;
}

export type Nip55Grants = Record<string, Nip55Grant>;

export const NIP55_GRANTS_KEY = 'signet.nip55.grants';

const HEX64 = /^[0-9a-f]{64}$/i;
const MAX_PAYLOAD = 256 * 1024;

/** A key as hex from hex or npub, lowercased; null for anything else. */
export function pubkeyHexFrom(value: string | null | undefined): string | null {
  if (!value) return null;
  const clean = value.trim();
  if (HEX64.test(clean)) return clean.toLowerCase();
  try {
    const decoded = nip19.decode(clean);
    if (decoded.type === 'npub') return decoded.data.toLowerCase();
  } catch { /* not bech32 */ }
  return null;
}

/** The form native Amber-shaped clients expect back from `get_public_key`. */
export function npubOf(pubkeyHex: string): string {
  return nip19.npubEncode(pubkeyHex);
}

/**
 * Validates a raw request. Null means malformed: an unknown method, a
 * missing payload, a template that is not an event. The template's
 * `created_at` is filled in when absent, as Amber does; `pubkey` is left
 * for the signer to set, because which key signs is decided here, not by
 * the app.
 */
export function parseNip55Request(raw: NativeNip55Request): ParsedNip55 | null {
  const method = raw.type?.toLowerCase();
  const currentUser = pubkeyHexFrom(raw.currentUser) ?? undefined;
  if (raw.currentUser && !currentUser) return null;
  if (raw.payload !== null && raw.payload.length > MAX_PAYLOAD) return null;
  switch (method) {
    case 'get_public_key':
      return { method, currentUser, permissions: parsePermissions(raw.permissions) };
    case 'sign_event': {
      const template = parseTemplate(raw.payload);
      if (!template) return null;
      return { method, template, currentUser, permissions: [] };
    }
    case 'nip44_encrypt':
    case 'nip44_decrypt': {
      const peer = pubkeyHexFrom(raw.peerPubkey);
      const payload = raw.payload?.trim();
      if (!peer || !payload) return null;
      return { method, peer, payload, currentUser, permissions: [] };
    }
    default:
      return null;
  }
}

function parseTemplate(payload: string | null): UnsignedEvent | null {
  if (!payload) return null;
  let json: unknown;
  try { json = JSON.parse(payload); } catch { return null; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const e = json as Record<string, unknown>;
  if (typeof e.kind !== 'number' || !Number.isInteger(e.kind) || e.kind < 0 || e.kind > 65535) return null;
  if (typeof e.content !== 'string') return null;
  const tags = e.tags === undefined ? [] : e.tags;
  if (!Array.isArray(tags) || !tags.every(t => Array.isArray(t) && t.every(x => typeof x === 'string'))) return null;
  const created = e.created_at === undefined ? Math.floor(Date.now() / 1000) : e.created_at;
  if (typeof created !== 'number' || !Number.isInteger(created) || created < 0) return null;
  if (e.pubkey !== undefined && pubkeyHexFrom(typeof e.pubkey === 'string' ? e.pubkey : null) === null) return null;
  return { kind: e.kind, content: e.content, tags: tags as string[][], created_at: created, pubkey: typeof e.pubkey === 'string' ? e.pubkey.toLowerCase() : '' } as UnsignedEvent;
}

/** `[{ "type": "sign_event", "kind": 1 }, { "type": "nip44_encrypt" }]` → `["sign_event:1", "nip44_encrypt"]`. Display only. */
export function parsePermissions(raw: string | null): string[] {
  if (!raw) return [];
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(json)) return [];
  const out: string[] = [];
  for (const item of json.slice(0, 64)) {
    if (!item || typeof item !== 'object') continue;
    const type = (item as Record<string, unknown>).type;
    const kind = (item as Record<string, unknown>).kind;
    if (typeof type !== 'string' || !type) continue;
    out.push(typeof kind === 'number' ? `${type}:${kind}` : type);
  }
  return out;
}

export function loadNip55Grants(storage: Pick<Storage, 'getItem'> = localStorage): Nip55Grants {
  try {
    const raw = storage.getItem(NIP55_GRANTS_KEY);
    if (!raw) return {};
    const json: unknown = JSON.parse(raw);
    if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
    const out: Nip55Grants = {};
    for (const [pkg, value] of Object.entries(json as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const g = value as Record<string, unknown>;
      const pubkey = pubkeyHexFrom(typeof g.pubkey === 'string' ? g.pubkey : null);
      if (!pubkey) continue;
      out[pkg] = { pubkey, allowAlways: g.allowAlways === true, denyAlways: g.denyAlways === true, grantedAt: typeof g.grantedAt === 'number' ? g.grantedAt : 0 };
      if (typeof g.label === 'string' && g.label.trim()) out[pkg].label = g.label.trim().slice(0, 40);
    }
    return out;
  } catch { return {}; }
}

export function saveNip55Grants(grants: Nip55Grants, storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage): void {
  try {
    if (Object.keys(grants).length === 0) storage.removeItem(NIP55_GRANTS_KEY);
    else storage.setItem(NIP55_GRANTS_KEY, JSON.stringify(grants));
  } catch { /* storage full or blocked: the grant lasts this session */ }
}

export type Nip55Plan =
  | { kind: 'reject'; reason: 'malformed' | 'denied' | 'unknown-identity' | 'no-identity' }
  /** Provider path only: nothing remembered says yes, so the app should ask by intent. */
  | { kind: 'defer' }
  | { kind: 'forward'; pubkey: string }
  | { kind: 'ask'; pubkey: string | null };

/**
 * The decision table, before any key is touched.
 *
 * - Malformed is rejected on either path.
 * - A caller the person refused for good is rejected without a screen.
 * - The key: what the app named, else what the person chose for this app
 *   before, else the only key there is. A named key this phone does not
 *   hold is rejected: signing under a different key by accident is worse
 *   than refusing.
 * - With a remembered "allow always" for that key, forward silently.
 * - Otherwise the provider cannot ask, so it defers and the app comes back
 *   by intent, which asks.
 */
export function planNip55(
  parsed: ParsedNip55 | null,
  viaProvider: boolean,
  grant: Nip55Grant | undefined,
  ownerPubkeys: string[],
  activePubkey: string | null,
): Nip55Plan {
  if (!parsed) return { kind: 'reject', reason: 'malformed' };
  if (grant?.denyAlways) return { kind: 'reject', reason: 'denied' };
  const owned = ownerPubkeys.map(p => p.toLowerCase());
  if (owned.length === 0) return viaProvider ? { kind: 'defer' } : { kind: 'reject', reason: 'no-identity' };
  const named = parsed.currentUser ?? null;
  if (named && !owned.includes(named)) return { kind: 'reject', reason: 'unknown-identity' };
  const remembered = grant && owned.includes(grant.pubkey) ? grant.pubkey : null;
  const identity = named ?? remembered ?? (owned.length === 1 ? owned[0] : (activePubkey && owned.includes(activePubkey.toLowerCase()) ? activePubkey.toLowerCase() : null));
  if (grant?.allowAlways && identity && grant.pubkey === identity) return { kind: 'forward', pubkey: identity };
  if (viaProvider) return { kind: 'defer' };
  return { kind: 'ask', pubkey: identity };
}

/** A line for the approval screen. */
export function describeNip55(parsed: ParsedNip55, describeTemplate: (t: UnsignedEvent) => string): string {
  switch (parsed.method) {
    case 'get_public_key': return 'know which key you are';
    case 'sign_event': return `sign a ${describeTemplate(parsed.template!)}`;
    case 'nip44_encrypt': return 'encrypt a message to someone';
    case 'nip44_decrypt': return 'read a message sent to you';
  }
}
