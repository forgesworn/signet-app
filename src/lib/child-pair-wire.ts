/**
 * Child-direct pairing wire (spec §4 steps 1-4): the guardian's QR offer, the
 * child's pairing request, and the guardian's reply. Pure: no relay traffic.
 * Every relay/QR input is size-bounded, strictly typed and time-boxed.
 */
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { getConversationKey, encrypt, decrypt } from 'nostr-tools/nip44';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';
import type { AutonomyStage } from '../types/dependants';
import { isValidRelayUrl } from './relay-url';
import { sanitizeDisplayName } from './text-sanitize';
import { parseNostrConnectURI } from './nip46';

export interface ChildPairOffer { v: 2; rail: string; guardian: string; dependant: string; persona: string; name: string; relay: string; hwRelays: string[]; code: string; t: number; }
export interface ChildPairRequest { v: 1; code: string; nostrconnect: string; clientPubkey: string; createdAt: number; }
export interface ChildPairReply { v: 1; code: string; ok: boolean; reason?: string; personas: { pubkey: string; name: string; role: 'persona' | 'natural-person' | 'extra' }[]; stage: AutonomyStage; }

const HEX64 = /^[0-9a-f]{64}$/, HEX32 = /^[0-9a-f]{32}$/;
const MAX_URI_BYTES = 8192, MAX_CONTENT = 20000, MAX_HW_RELAYS = 8, MAX_PERSONAS = 32;
export const CHILD_PAIR_TTL_S = 600;
const FUTURE_SKEW_S = 300;
const REQ_PREFIX = 'signet:child-pair:v1:', REPLY_PREFIX = 'signet:child-pair-reply:v1:';
const STAGES: readonly string[] = ['full-control', 'request-approve', 'autonomous-alerts', 'autonomous-logging', 'full-autonomy'];
const ROLES: readonly string[] = ['persona', 'natural-person', 'extra'];

const fresh = (t: unknown, nowS: number): t is number =>
  Number.isSafeInteger(t) && (t as number) <= nowS + FUTURE_SKEW_S && (t as number) + CHILD_PAIR_TTL_S >= nowS;

/** Constant-time equality for equal-length strings; false on any length mismatch. */
function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function newPairCode(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

export function buildChildPairUri(o: ChildPairOffer): string {
  const p = new URLSearchParams();
  p.set('v', '2'); p.set('rail', o.rail); p.set('guardian', o.guardian); p.set('dependant', o.dependant);
  p.set('persona', o.persona); p.set('name', o.name); p.set('relay', o.relay);
  for (const r of o.hwRelays) p.append('hwrelay', r);
  p.set('code', o.code); p.set('t', String(o.t));
  return `signet-child:?${p.toString()}`;
}

export function parseChildPairUri(text: string, nowS: number): ChildPairOffer | null {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_URI_BYTES) return null;
  if (!text.startsWith('signet-child:?')) return null;
  try {
    const p = new URLSearchParams(text.slice('signet-child:?'.length));
    if (p.get('v') !== '2') return null;
    const one = (k: string) => { const a = p.getAll(k); return a.length === 1 ? a[0] : null; };
    const rail = one('rail'), guardian = one('guardian'), dependant = one('dependant'), persona = one('persona');
    const code = one('code'), relay = one('relay'), rawName = one('name'), tStr = one('t');
    if (!rail || !guardian || !dependant || !persona || !code || !relay || rawName === null || !tStr) return null;
    if (![rail, guardian, dependant, persona].every(k => HEX64.test(k)) || !HEX32.test(code)) return null;
    if (!/^\d{1,12}$/.test(tStr)) return null;
    const t = Number(tStr);
    if (!fresh(t, nowS)) return null;
    if (!isValidRelayUrl(relay) || relay.length > 300) return null;
    const hw = p.getAll('hwrelay');
    if (hw.length < 1 || hw.length > MAX_HW_RELAYS || new Set(hw).size !== hw.length
      || !hw.every(r => r.length <= 300 && isValidRelayUrl(r))) return null;
    const name = sanitizeDisplayName(rawName, 100);
    if (!name) return null;
    return { v: 2, rail, guardian, dependant, persona, name, relay, hwRelays: hw, code, t };
  } catch { return null; }
}

function checkRequest(r: unknown): ChildPairRequest | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  if (o.v !== 1 || typeof o.code !== 'string' || !HEX32.test(o.code) || typeof o.clientPubkey !== 'string' || !HEX64.test(o.clientPubkey)
    || typeof o.nostrconnect !== 'string' || !Number.isSafeInteger(o.createdAt)) return null;
  return { v: 1, code: o.code, nostrconnect: o.nostrconnect, clientPubkey: o.clientPubkey, createdAt: o.createdAt as number };
}

export async function buildChildPairRequestEvent(req: ChildPairRequest, clientPrivateKey: string, railPubkey: string): Promise<NostrEvent> {
  const r = checkRequest(req);
  if (!r || !HEX64.test(railPubkey)) throw new Error('Invalid child pair request');
  const sk = hexToBytes(clientPrivateKey);
  try {
    const content = encrypt(JSON.stringify(r), getConversationKey(sk, railPubkey));
    return finalizeEvent({ kind: 30078, created_at: r.createdAt, tags: [['d', REQ_PREFIX + r.code], ['p', railPubkey]], content }, sk) as unknown as NostrEvent;
  } finally { sk.fill(0); }
}

function validEnvelope(ev: NostrEvent, dTag: string, pTag: string): boolean {
  return !!ev && ev.kind === 30078 && typeof ev.content === 'string' && ev.content.length <= MAX_CONTENT
    && HEX64.test(ev.pubkey) && Array.isArray(ev.tags) && ev.tags.length === 2
    && ev.tags[0]?.length === 2 && ev.tags[0][0] === 'd' && ev.tags[0][1] === dTag
    && ev.tags[1]?.length === 2 && ev.tags[1][0] === 'p' && ev.tags[1][1] === pTag
    && verifyEvent({ id: ev.id, sig: ev.sig, pubkey: ev.pubkey, kind: ev.kind, created_at: ev.created_at,
      tags: ev.tags.map(t => [...t]), content: ev.content });
}

export async function openChildPairRequestEvent(ev: NostrEvent, railPrivateKey: string, expect: { code: string; nowS: number }): Promise<ChildPairRequest | null> {
  let sk: Uint8Array | null = null;
  try {
    if (!HEX32.test(expect.code)) return null;
    sk = hexToBytes(railPrivateKey);
    const railPub = getPublicKey(sk);
    if (!validEnvelope(ev, REQ_PREFIX + expect.code, railPub) || !fresh(ev.created_at, expect.nowS)) return null;
    const req = checkRequest(JSON.parse(decrypt(ev.content, getConversationKey(sk, ev.pubkey))));
    if (!req || req.clientPubkey !== ev.pubkey || !ctEqual(req.code, expect.code)
      || req.createdAt !== ev.created_at || !fresh(req.createdAt, expect.nowS)) return null;
    const nc = parseNostrConnectURI(req.nostrconnect);
    if (!nc || nc.clientPubkey !== req.clientPubkey || !nc.secret) return null;
    return req;
  } catch { return null; }
  finally { sk?.fill(0); }
}

function checkReply(r: unknown): ChildPairReply | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  if (o.v !== 1 || typeof o.code !== 'string' || !HEX32.test(o.code) || typeof o.ok !== 'boolean'
    || typeof o.stage !== 'string' || !STAGES.includes(o.stage)
    || !Array.isArray(o.personas) || o.personas.length > MAX_PERSONAS) return null;
  if (o.reason !== undefined && typeof o.reason !== 'string') return null;
  const personas: ChildPairReply['personas'] = [];
  for (const p of o.personas) {
    if (!p || typeof p !== 'object') return null;
    const q = p as Record<string, unknown>;
    if (typeof q.pubkey !== 'string' || !HEX64.test(q.pubkey) || typeof q.name !== 'string'
      || typeof q.role !== 'string' || !ROLES.includes(q.role)) return null;
    personas.push({ pubkey: q.pubkey, name: sanitizeDisplayName(q.name, 100), role: q.role as ChildPairReply['personas'][number]['role'] });
  }
  return { v: 1, code: o.code, ok: o.ok, ...(o.reason !== undefined ? { reason: sanitizeDisplayName(o.reason as string, 200) } : {}),
    personas, stage: o.stage as AutonomyStage };
}

export async function buildChildPairReplyEvent(r: ChildPairReply, railPrivateKey: string, clientPubkey: string): Promise<NostrEvent> {
  const reply = checkReply(r);
  if (!reply || !HEX64.test(clientPubkey)) throw new Error('Invalid child pair reply');
  const sk = hexToBytes(railPrivateKey);
  try {
    const content = encrypt(JSON.stringify(reply), getConversationKey(sk, clientPubkey));
    return finalizeEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000),
      tags: [['d', REPLY_PREFIX + reply.code], ['p', clientPubkey]], content }, sk) as unknown as NostrEvent;
  } finally { sk.fill(0); }
}

export async function openChildPairReplyEvent(ev: NostrEvent, clientPrivateKey: string, expect: { code: string; railPubkey: string }): Promise<ChildPairReply | null> {
  let sk: Uint8Array | null = null;
  try {
    if (!HEX32.test(expect.code) || !HEX64.test(expect.railPubkey)) return null;
    sk = hexToBytes(clientPrivateKey);
    const clientPub = getPublicKey(sk);
    if (ev.pubkey !== expect.railPubkey || !validEnvelope(ev, REPLY_PREFIX + expect.code, clientPub)) return null;
    const reply = checkReply(JSON.parse(decrypt(ev.content, getConversationKey(sk, ev.pubkey))));
    if (!reply || !ctEqual(reply.code, expect.code)) return null;
    return reply;
  } catch { return null; }
  finally { sk?.fill(0); }
}
