import { verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'signet-protocol';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { DecryptingSigningBackend } from './signing-backend';
import { getDb } from './db';
import { updateEncryptedPrivateState } from './private-vault-store';
import { parseChildContactRequest, type ChildContactRequest, type ChildRequestScope } from './child-contact-requests';

const HEX = /^[0-9a-f]{64}$/, ID = /^[0-9a-f]{32}$/;
const REQUEST_PREFIX = 'signet:child-contact-request:v1:';
const REPLY_PREFIX = 'signet:child-contact-reply:v1:';
const TTL = 600;
const stamp = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 253402300799;

export type ChildContactReplyStatus = 'pending' | 'denied' | 'expired' | 'conflict' | 'completed';
export interface ChildContactReply {
  v: 1; requestId: string; guardian: string; endpoint: string; client: string; persona: string;
  revision: number; createdAt: number; expiresAt: number; status: ChildContactReplyStatus;
  exchangeId?: string; contactId?: string;
}

function validScope(scope: ChildRequestScope) {
  if (![scope.guardian, scope.child, scope.endpoint, scope.client].every(k => typeof k === 'string' && HEX.test(k))
    || !Array.isArray(scope.personas) || scope.personas.length > 32 || !scope.personas.every(k => typeof k === 'string' && HEX.test(k)))
    throw new Error('Invalid child exchange scope');
}

export function parseChildContactReply(raw: string): ChildContactReply | null {
  if (new TextEncoder().encode(raw).length > 4096) return null;
  try {
    const r = JSON.parse(raw);
    if (!r || r.v !== 1 || !ID.test(r.requestId) || ![r.guardian, r.endpoint, r.client, r.persona].every(k => typeof k === 'string' && HEX.test(k))
      || !stamp(r.revision) || r.revision < 1 || !stamp(r.createdAt) || !stamp(r.expiresAt) || r.expiresAt <= r.createdAt
      || r.expiresAt - r.createdAt > TTL || !['pending', 'denied', 'expired', 'conflict', 'completed'].includes(r.status)
      || (r.exchangeId !== undefined && !ID.test(r.exchangeId)) || (r.contactId !== undefined && !ID.test(r.contactId))
      || (r.status === 'completed' && r.exchangeId === undefined)
      || (r.status !== 'completed' && (r.exchangeId !== undefined || r.contactId !== undefined))) return null;
    return { v: 1, requestId: r.requestId, guardian: r.guardian, endpoint: r.endpoint, client: r.client, persona: r.persona,
      revision: r.revision, createdAt: r.createdAt, expiresAt: r.expiresAt, status: r.status,
      ...(r.exchangeId ? { exchangeId: r.exchangeId } : {}), ...(r.contactId ? { contactId: r.contactId } : {}) };
  } catch { return null; }
}

function eventShape(event: NostrEvent, dPrefix: string, author: string, recipient?: string) {
  return event.pubkey === author && event.kind === 30078 && (recipient === undefined ? event.tags.length === 1 : event.tags.length === 2)
    && event.tags.every(t => t.length === 2) && event.tags.some(t => t[0] === 'd' && t[1].startsWith(dPrefix))
    && (recipient === undefined || event.tags.some(t => t[0] === 'p' && t[1] === recipient))
    && typeof event.content === 'string' && event.content.length <= 20000;
}

export async function sealChildContactReply(reply: ChildContactReply, guardian: DecryptingSigningBackend): Promise<NostrEvent> {
  const parsed = parseChildContactReply(JSON.stringify(reply));
  if (!parsed || guardian.activePublicKeyHex !== parsed.endpoint) throw new Error('Invalid child contact reply');
  const content = await guardian.nip44Encrypt(parsed.client, JSON.stringify(parsed));
  return guardian.signEvent({ pubkey: parsed.endpoint, kind: 30078, created_at: parsed.createdAt,
    tags: [['d', REPLY_PREFIX + parsed.requestId], ['p', parsed.client]], content });
}

/** One request may advance from pending to one terminal result. Its request
 * revision and persona remain fixed; timestamps also order relay replacement. */
export function childContactReplyTransition(previous: ChildContactReply, next: ChildContactReply): 'same' | 'advance' | 'stale' {
  if (['requestId', 'guardian', 'endpoint', 'client', 'persona', 'revision'].some(k => previous[k as keyof ChildContactReply] !== next[k as keyof ChildContactReply])) throw new Error('Child reply scope conflict');
  if (next.createdAt < previous.createdAt) return 'stale';
  if (previous.status === next.status && previous.exchangeId === next.exchangeId && previous.contactId === next.contactId) return 'same';
  if (previous.status !== 'pending' || next.status === 'pending' || next.createdAt <= previous.createdAt) throw new Error('Child reply conflict');
  return 'advance';
}

export async function openChildContactReply(event: NostrEvent, options: {
  scope: ChildRequestScope; client: DecryptingSigningBackend; now: number; isCurrent(): boolean;
}): Promise<{ reply: ChildContactReply; fingerprint: string } | null> {
  try {
    const scope = structuredClone(options.scope); validScope(scope);
    if (!options.isCurrent() || !stamp(options.now) || options.client.activePublicKeyHex !== scope.client
      || !stamp(event.created_at) || event.created_at > options.now + 300 || event.created_at + TTL <= options.now
      || !eventShape(event, REPLY_PREFIX, scope.endpoint, scope.client) || !verifyEvent(event)) return null;
    const raw = await options.client.nip44Decrypt(scope.endpoint, event.content);
    const reply = parseChildContactReply(raw);
    if (!options.isCurrent() || !reply || reply.guardian !== scope.guardian || reply.endpoint !== scope.endpoint
      || reply.client !== scope.client || !scope.personas.includes(reply.persona) || reply.createdAt !== event.created_at
      || reply.expiresAt <= options.now || event.tags.some(t => t[0] === 'd' && t[1] !== REPLY_PREFIX + reply.requestId)) return null;
    return { reply, fingerprint: bytesToHex(sha256(new TextEncoder().encode(raw))) };
  } catch { return null; }
}

/** D4: exported so a read-only consumer (the child's own request history)
 * can type its state without reaching into this module's internals. */
export interface ChildContactOutboxEntry { request: ChildContactRequest; fingerprint: string; event?: NostrEvent; createdAt: number; }
type OutboxEntry = ChildContactOutboxEntry;
interface Outbox { v: 1; guardian: string; child: string; endpoint: string; client: string; entries: OutboxEntry[] }
function outboxId(scope: ChildRequestScope) { validScope(scope); return `child-contact-outbox:${scope.guardian}:${scope.child}:${scope.endpoint}:${scope.client}`; }
function parseOutbox(raw: Outbox, scope: ChildRequestScope): Outbox {
  if (!raw || raw.v !== 1 || raw.guardian !== scope.guardian || raw.child !== scope.child || raw.endpoint !== scope.endpoint || raw.client !== scope.client
    || !Array.isArray(raw.entries) || raw.entries.length > 32) throw new Error('Invalid child request outbox');
  const entries = raw.entries.map(e => {
    const request = parseChildContactRequest(JSON.stringify(e?.request));
    if (!request || request.client !== scope.client || request.guardian !== scope.guardian || !HEX.test(e.fingerprint) || !stamp(e.createdAt)) throw new Error('Invalid child request outbox entry');
    if (e.event !== undefined && (!eventShape(e.event, REQUEST_PREFIX, scope.client) || !verifyEvent(e.event)
      || e.event.tags.find(t => t[0] === 'd')?.[1] !== REQUEST_PREFIX + request.id || e.event.created_at !== request.createdAt)) throw new Error('Invalid child request outbox event');
    return { request, fingerprint: e.fingerprint, createdAt: e.createdAt, ...(e.event ? { event: e.event } : {}) };
  });
  if (new Set(entries.map(e => e.request.id)).size !== entries.length) throw new Error('Duplicate child request outbox entry');
  return { v: 1, guardian: scope.guardian, child: scope.child, endpoint: scope.endpoint, client: scope.client, entries };
}

export async function loadChildContactOutbox(scope: ChildRequestScope, key: string, current: () => boolean): Promise<OutboxEntry[]> {
  scope = structuredClone(scope); validScope(scope); if (!current()) throw new Error('Child exchange session changed');
  const row = await (await getDb()).get('privateVaultState', outboxId(scope));
  if (!row) return [];
  const loaded = parseOutbox(JSON.parse(await (await import('./crypto-store')).decryptSecret(row.encrypted, key)), scope);
  if (!current()) throw new Error('Child exchange session changed');
  return loaded.entries;
}

export function queueChildContactRequest(options: { scope: ChildRequestScope; key: string; request: ChildContactRequest; fingerprint: string; now: number; isCurrent(): boolean }): Promise<OutboxEntry> {
  const o = { ...options, scope: structuredClone(options.scope), request: structuredClone(options.request) };
  const request = parseChildContactRequest(JSON.stringify(o.request));
  if (!request || request.client !== o.scope.client || request.guardian !== o.scope.guardian || !HEX.test(o.fingerprint) || !stamp(o.now) || request.expiresAt <= o.now) return Promise.reject(new Error('Invalid child request outbox entry'));
  const check = () => { if (!o.isCurrent()) throw new Error('Child exchange session changed'); };
  check();
  return updateEncryptedPrivateState<Outbox>(outboxId(o.scope), o.key, previous => {
    check(); const box = parseOutbox(previous ?? { v: 1, guardian: o.scope.guardian, child: o.scope.child, endpoint: o.scope.endpoint, client: o.scope.client, entries: [] }, o.scope);
    const existing = box.entries.find(e => e.request.id === request.id);
    if (existing) { if (existing.fingerprint !== o.fingerprint) throw new Error('Child request outbox conflict'); return box; }
    if (box.entries.length >= 32) throw new Error('Child request outbox is full');
    return { ...box, entries: [...box.entries, { request, fingerprint: o.fingerprint, createdAt: o.now }] };
  }, check).then(box => box.entries.find(e => e.request.id === request.id)!);
}

export function attachChildContactRequestEvent(options: { scope: ChildRequestScope; key: string; requestId: string; event: NostrEvent; isCurrent(): boolean }): Promise<OutboxEntry> {
  const o = { ...options, scope: structuredClone(options.scope) }; validScope(o.scope);
  if (!ID.test(o.requestId) || !o.isCurrent() || !eventShape(o.event, REQUEST_PREFIX, o.scope.client) || !verifyEvent(o.event)) return Promise.reject(new Error('Invalid child request event'));
  const check = () => { if (!o.isCurrent()) throw new Error('Child exchange session changed'); };
  return updateEncryptedPrivateState<Outbox>(outboxId(o.scope), o.key, previous => {
    check(); const box = parseOutbox(previous ?? { v: 1, guardian: o.scope.guardian, child: o.scope.child, endpoint: o.scope.endpoint, client: o.scope.client, entries: [] }, o.scope);
    const entry = box.entries.find(e => e.request.id === o.requestId);
    if (!entry || o.event.created_at !== entry.request.createdAt || o.event.tags.find(t => t[0] === 'd')?.[1] !== REQUEST_PREFIX + o.requestId) throw new Error('Child request outbox entry changed');
    if (entry.event && entry.event.id !== o.event.id) throw new Error('Child request outbox event conflict');
    return { ...box, entries: box.entries.map(e => e.request.id === o.requestId ? { ...e, event: o.event } : e) };
  }, check).then(box => box.entries.find(e => e.request.id === o.requestId)!);
}
