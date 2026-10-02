/**
 * Child sign asks and guardian verdicts (child-direct Heartwood pairing,
 * spec §7). Pure wire: no relay traffic. Ask = child client key -> rail
 * pubkey; verdict = rail key -> child client. Both are kind-30078, NIP-44,
 * size-bounded and strictly validated; anything off opens as null.
 * `createdAt` / `expiresAt` / `decidedAt` are unix seconds.
 */
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { getConversationKey, encrypt, decrypt } from 'nostr-tools/nip44';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import type { ChildRuleTarget } from '../types/child-rules';
import { inferScope, type Scope } from './scope-inference';
import { sanitizeDisplayName } from './text-sanitize';
import { TARGET_RE, SCOPE_RE } from './child-rules-wire';
import { childTargetsFor } from './child-gate';

export interface ChildSignAsk {
  v: 1; id: string; dependantId: string; persona: string; scope: string | null; kind: number;
  method: 'sign_event' | 'nip44_encrypt' | 'nip44_decrypt';
  target: ChildRuleTarget; targetLabel: string; template?: UnsignedEvent; createdAt: number; expiresAt: number;
  /** sha256 hex of JSON [pubkey, kind, tags, content] of the FULL template (present with `template`). */
  templateHash?: string;
  /** True when `template.content` is a prefix of a longer content. */
  contentTruncated?: boolean;
  /** Length in characters of the full content. */
  contentLength?: number;
  /** True when trailing tags were dropped to fit the 4 KB tag budget. */
  tagsTruncated?: boolean;
}
export interface ChildSignVerdict {
  v: 1; id: string; verdict: 'once' | 'always' | 'deny'; alwaysDeny?: boolean;
  reason?: 'device-unreachable' | 'expired'; ruleId?: string; decidedAt: number;
}

export const CHILD_SIGN_ASK_TTL_S = 600;
export const CHILD_SIGN_ASK_LIVE_LIMIT = 32;
const MAX_CONTENT = 16384, TEMPLATE_CONTENT_MAX = 4096, TEMPLATE_TAGS_BUDGET = 4096, MAX_TAGS = 64, MAX_TAG_ITEMS = 8, MAX_TAG_ITEM_LEN = 512;
const FUTURE_SKEW_S = 300;
const HEX64 = /^[0-9a-f]{64}$/, HEX32 = /^[0-9a-f]{32}$/;
const ASK_PREFIX = 'signet:child-sign-request:v1:', REPLY_PREFIX = 'signet:child-sign-reply:v1:';
const METHODS: readonly string[] = ['sign_event', 'nip44_encrypt', 'nip44_decrypt'];

const posInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

/** Hash the child forwards against: sha256 of JSON [pubkey, kind, tags, content]. */
export function templateHash(t: UnsignedEvent): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([t.pubkey, t.kind, t.tags, t.content]))));
}

/**
 * Fill the integrity fields from the FULL template and shrink it for display:
 * content to 4096 chars, tags to a 4 KB serialised budget (no silent drop:
 * `tagsTruncated`). Throws when the template does not belong to the persona.
 */
function prepareAsk(a: ChildSignAsk): ChildSignAsk {
  if (!a.template) return a;
  const t = a.template;
  if (t.pubkey !== a.persona) throw new Error('template pubkey must equal persona');
  if (!Array.isArray(t.tags) || typeof t.content !== 'string') throw new Error('Invalid template');
  const kept: string[][] = [];
  let tagsTruncated = false;
  for (const tag of t.tags) {
    if (!Array.isArray(tag) || !tag.every(x => typeof x === 'string')) throw new Error('Invalid template');
    const fits = kept.length < MAX_TAGS && tag.length <= MAX_TAG_ITEMS && tag.every(x => x.length <= MAX_TAG_ITEM_LEN)
      && JSON.stringify([...kept, tag]).length <= TEMPLATE_TAGS_BUDGET;
    if (!fits) { tagsTruncated = true; break; }
    kept.push([...tag]);
  }
  return {
    ...a,
    template: { ...t, tags: kept, content: t.content.slice(0, TEMPLATE_CONTENT_MAX) },
    templateHash: templateHash(t),
    contentTruncated: t.content.length > TEMPLATE_CONTENT_MAX,
    contentLength: t.content.length,
    tagsTruncated,
  };
}

function checkTemplate(raw: unknown, persona: string): UnsignedEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (!Number.isInteger(t.kind) || (t.kind as number) < 0 || (t.kind as number) > 65535) return null;
  if (typeof t.content !== 'string' || !Number.isSafeInteger(t.created_at) || (t.created_at as number) < 0) return null;
  if (!Array.isArray(t.tags) || t.tags.length > MAX_TAGS) return null;
  const tags: string[][] = [];
  for (const tag of t.tags) {
    if (!Array.isArray(tag) || tag.length > MAX_TAG_ITEMS || !tag.every(x => typeof x === 'string' && x.length <= MAX_TAG_ITEM_LEN)) return null;
    tags.push([...(tag as string[])]);
  }
  if (t.pubkey !== persona) return null;
  const pubkey = persona;
  return { kind: t.kind as number, pubkey, created_at: t.created_at as number, tags, content: t.content.slice(0, TEMPLATE_CONTENT_MAX) };
}

function checkAsk(raw: unknown): ChildSignAsk | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.id !== 'string' || !HEX32.test(o.id)) return null;
  if (typeof o.dependantId !== 'string' || !HEX64.test(o.dependantId)) return null;
  if (typeof o.persona !== 'string' || !HEX64.test(o.persona)) return null;
  if (o.scope !== null && (typeof o.scope !== 'string' || !SCOPE_RE.test(o.scope))) return null;
  if (!Number.isInteger(o.kind) || (o.kind as number) < 0 || (o.kind as number) > 65535) return null;
  if (typeof o.method !== 'string' || !METHODS.includes(o.method)) return null;
  if (typeof o.target !== 'string' || o.target === '*' || !TARGET_RE.test(o.target)) return null;
  if (typeof o.targetLabel !== 'string') return null;
  if (!posInt(o.createdAt) || !posInt(o.expiresAt) || o.expiresAt <= o.createdAt || o.expiresAt - o.createdAt > CHILD_SIGN_ASK_TTL_S) return null;
  const out: ChildSignAsk = {
    v: 1, id: o.id, dependantId: o.dependantId, persona: o.persona, scope: o.scope as string | null, kind: o.kind as number,
    method: o.method as ChildSignAsk['method'], target: o.target as ChildRuleTarget,
    targetLabel: sanitizeDisplayName(o.targetLabel, 100), createdAt: o.createdAt, expiresAt: o.expiresAt,
  };
  if (o.template !== undefined) {
    const t = checkTemplate(o.template, o.persona);
    if (!t) return null;
    out.template = t;
    if (typeof o.templateHash !== 'string' || !HEX64.test(o.templateHash)
      || typeof o.contentTruncated !== 'boolean' || typeof o.tagsTruncated !== 'boolean'
      || !Number.isSafeInteger(o.contentLength) || (o.contentLength as number) < t.content.length) return null;
    if (!o.contentTruncated && o.contentLength !== t.content.length) return null;
    out.templateHash = o.templateHash; out.contentTruncated = o.contentTruncated;
    out.contentLength = o.contentLength as number; out.tagsTruncated = o.tagsTruncated;
  }
  return out;
}

function validEnvelope(ev: NostrEvent, dTag: string, pTag: string): boolean {
  return !!ev && ev.kind === 30078 && typeof ev.content === 'string' && ev.content.length <= MAX_CONTENT
    && typeof ev.pubkey === 'string' && HEX64.test(ev.pubkey) && Array.isArray(ev.tags) && ev.tags.length === 2
    && ev.tags[0]?.length === 2 && ev.tags[0][0] === 'd' && ev.tags[0][1] === dTag
    && ev.tags[1]?.length === 2 && ev.tags[1][0] === 'p' && ev.tags[1][1] === pTag
    && verifyEvent({ id: ev.id, sig: ev.sig, pubkey: ev.pubkey, kind: ev.kind, created_at: ev.created_at,
      tags: ev.tags.map(t => [...t]), content: ev.content });
}

/** Persona known, not expired, template kind and inferred scope consistent with the claim. */
export function askInScope(a: ChildSignAsk, scope: { dependantId: string; personas: string[]; nowS: number }): boolean {
  if (a.dependantId !== scope.dependantId) return false;
  if (!scope.personas.some(p => p.toLowerCase() === a.persona)) return false;
  if (a.expiresAt <= scope.nowS || a.createdAt > scope.nowS + FUTURE_SKEW_S) return false;
  if (a.method === 'sign_event') {
    if (!a.template || a.template.kind !== a.kind) return false;
    if (a.template.pubkey !== a.persona) return false;
    if (inferScope(a.template) !== a.scope) return false;
    // With the whole template in hand the hash must match (a truncated one cannot be re-hashed here).
    if (!a.contentTruncated && !a.tagsTruncated && a.templateHash !== templateHash(a.template)) return false;
    // A site/peer target must be one the template itself yields; an app target cannot be re-derived.
    if (!a.target.startsWith('app:')) {
      if (a.tagsTruncated) return false;
      const appId = '';
      if (!childTargetsFor(a.template, a.scope as Scope | null, appId).includes(a.target)) return false;
    }
    return true;
  }
  // nip44 ask: no event, dm-private semantics, a peer target.
  return !a.template && a.scope === 'dm-private' && a.target.startsWith('peer:');
}

export async function buildAskEvent(a: ChildSignAsk, clientPrivateKey: string, railPubkey: string): Promise<NostrEvent> {
  if (!HEX64.test(railPubkey)) throw new Error('Invalid rail pubkey');
  const ask = checkAsk(prepareAsk(a));
  if (!ask) throw new Error('Invalid child sign ask');
  const sk = hexToBytes(clientPrivateKey);
  try {
    const ck = getConversationKey(sk, railPubkey);
    const content = encrypt(JSON.stringify(ask), ck);
    if (content.length > MAX_CONTENT) throw new Error('too-large');
    return finalizeEvent({ kind: 30078, created_at: ask.createdAt, tags: [['d', ASK_PREFIX + ask.id], ['p', railPubkey]], content }, sk) as unknown as NostrEvent;
  } finally { sk.fill(0); }
}

export async function openAskEvent(ev: NostrEvent, railPrivateKey: string, scope: { clientPubkey: string; dependantId: string; personas: string[]; nowS: number }): Promise<ChildSignAsk | null> {
  let sk: Uint8Array | null = null;
  try {
    if (!HEX64.test(scope.clientPubkey) || !HEX64.test(scope.dependantId)) return null;
    sk = hexToBytes(railPrivateKey);
    const railPub = getPublicKey(sk);
    if (!ev || ev.pubkey !== scope.clientPubkey || !Array.isArray(ev.tags) || ev.tags[0]?.[0] !== 'd'
      || typeof ev.tags[0][1] !== 'string' || !ev.tags[0][1].startsWith(ASK_PREFIX)) return null;
    if (!validEnvelope(ev, ev.tags[0][1], railPub)) return null;
    const ask = checkAsk(JSON.parse(decrypt(ev.content, getConversationKey(sk, ev.pubkey))));
    if (!ask || ev.tags[0][1] !== ASK_PREFIX + ask.id || ev.created_at !== ask.createdAt) return null;
    return askInScope(ask, scope) ? ask : null;
  } catch { return null; }
  finally { sk?.fill(0); }
}

function checkVerdict(raw: unknown): ChildSignVerdict | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.id !== 'string' || !HEX32.test(o.id)) return null;
  if (o.verdict !== 'once' && o.verdict !== 'always' && o.verdict !== 'deny') return null;
  if (!posInt(o.decidedAt)) return null;
  const out: ChildSignVerdict = { v: 1, id: o.id, verdict: o.verdict, decidedAt: o.decidedAt };
  if (o.alwaysDeny !== undefined) { if (typeof o.alwaysDeny !== 'boolean') return null; out.alwaysDeny = o.alwaysDeny; }
  if (o.reason !== undefined) {
    if (o.reason !== 'device-unreachable' && o.reason !== 'expired') return null;
    out.reason = o.reason;
  }
  if (o.ruleId !== undefined) { if (typeof o.ruleId !== 'string' || !HEX32.test(o.ruleId)) return null; out.ruleId = o.ruleId; }
  return out;
}

export async function buildVerdictEvent(v: ChildSignVerdict, railPrivateKey: string, clientPubkey: string): Promise<NostrEvent> {
  const verdict = checkVerdict(v);
  if (!verdict || !HEX64.test(clientPubkey)) throw new Error('Invalid child sign verdict');
  const sk = hexToBytes(railPrivateKey);
  try {
    const content = encrypt(JSON.stringify(verdict), getConversationKey(sk, clientPubkey));
    return finalizeEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000),
      tags: [['d', REPLY_PREFIX + verdict.id], ['p', clientPubkey]], content }, sk) as unknown as NostrEvent;
  } finally { sk.fill(0); }
}

export async function openVerdictEvent(ev: NostrEvent, clientPrivateKey: string, expect: { railPubkey: string; id: string }): Promise<ChildSignVerdict | null> {
  let sk: Uint8Array | null = null;
  try {
    if (!HEX64.test(expect.railPubkey) || !HEX32.test(expect.id)) return null;
    sk = hexToBytes(clientPrivateKey);
    const clientPub = getPublicKey(sk);
    if (!ev || ev.pubkey !== expect.railPubkey || !validEnvelope(ev, REPLY_PREFIX + expect.id, clientPub)) return null;
    const verdict = checkVerdict(JSON.parse(decrypt(ev.content, getConversationKey(sk, ev.pubkey))));
    return verdict && verdict.id === expect.id ? verdict : null;
  } catch { return null; }
  finally { sk?.fill(0); }
}

/**
 * A35: the guardian side reading a verdict the rail key already published
 * (another guardian device, or our own echo). The NIP-44 conversation key is
 * symmetric, so the rail private key + the child's client pubkey open it.
 */
export async function openRailVerdictEvent(ev: NostrEvent, railPrivateKey: string, expect: { clientPubkey: string }): Promise<ChildSignVerdict | null> {
  let sk: Uint8Array | null = null;
  try {
    if (!HEX64.test(expect.clientPubkey) || !ev || !Array.isArray(ev.tags)) return null;
    const d = ev.tags[0]?.[0] === 'd' ? ev.tags[0][1] : undefined;
    if (typeof d !== 'string' || !d.startsWith(REPLY_PREFIX)) return null;
    const id = d.slice(REPLY_PREFIX.length);
    if (!HEX32.test(id)) return null;
    sk = hexToBytes(railPrivateKey);
    if (ev.pubkey !== getPublicKey(sk) || !validEnvelope(ev, REPLY_PREFIX + id, expect.clientPubkey)) return null;
    const verdict = checkVerdict(JSON.parse(decrypt(ev.content, getConversationKey(sk, expect.clientPubkey))));
    return verdict && verdict.id === id ? verdict : null;
  } catch { return null; }
  finally { sk?.fill(0); }
}
