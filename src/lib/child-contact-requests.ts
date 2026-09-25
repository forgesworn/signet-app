import { verifyEvent } from 'nostr-tools/pure';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { parseContactInvite, type ContactInvite } from '@forgesworn/signet-contacts';
import type { NostrEvent } from 'signet-protocol';
import type { DecryptingSigningBackend } from './signing-backend';
import { updateEncryptedPrivateState } from './private-vault-store';
import { getDb } from './db';
import { decryptSecret } from './crypto-store';

const HEX = /^[0-9a-f]{64}$/, ID = /^[0-9a-f]{32}$/;
const PREFIX = 'signet:child-contact-request:v1:';
const TTL = 600, MAX_BYTES = 12000, LIVE_LIMIT = 32, RECEIPT_LIMIT = 1024;
const stamp = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 253402300799;
export interface ChildContactRequest {
  v: 1; id: string; guardian: string; endpoint: string; client: string; persona: string;
  revision: number; createdAt: number; expiresAt: number; invite: ContactInvite;
}
export interface ChildRequestScope { guardian: string; child: string; endpoint: string; client: string; personas: string[] }
function validScope(scope: ChildRequestScope) {
  if (![scope.guardian, scope.child, scope.endpoint, scope.client].every(k => typeof k === 'string' && HEX.test(k))
    || !Array.isArray(scope.personas) || scope.personas.length > 32 || !scope.personas.every(k => typeof k === 'string' && HEX.test(k))
    || new Set(scope.personas).size !== scope.personas.length) throw new Error('Invalid child request scope');
}
export function parseChildContactRequest(raw: string): ChildContactRequest | null {
  if (new TextEncoder().encode(raw).length > MAX_BYTES) return null;
  try {
    const r = JSON.parse(raw);
    if (!r || r.v !== 1 || typeof r.id !== 'string' || !ID.test(r.id)
      || ![r.guardian, r.endpoint, r.client, r.persona].every(k => typeof k === 'string' && HEX.test(k))
      || !stamp(r.revision) || r.revision < 1 || !stamp(r.createdAt) || !stamp(r.expiresAt)
      || r.expiresAt <= r.createdAt || r.expiresAt - r.createdAt > TTL) return null;
    const invite = parseContactInvite(JSON.stringify(r.invite));
    if (!invite || invite.recipient === r.persona || (invite.expiresAt !== undefined && r.expiresAt > invite.expiresAt)) return null;
    return { v: 1, id: r.id, guardian: r.guardian, endpoint: r.endpoint, client: r.client, persona: r.persona,
      revision: r.revision, createdAt: r.createdAt, expiresAt: r.expiresAt, invite };
  } catch { return null; }
}
export function childContactRequestInScope(r: Pick<ChildContactRequest, 'guardian' | 'endpoint' | 'client' | 'persona'>, scope: ChildRequestScope) {
  return r.guardian === scope.guardian && r.endpoint === scope.endpoint && r.client === scope.client && scope.personas.includes(r.persona);
}
export async function sealChildContactRequest(request: ChildContactRequest, transport: DecryptingSigningBackend): Promise<NostrEvent> {
  const r = parseChildContactRequest(JSON.stringify(request));
  if (!r || transport.activePublicKeyHex !== r.client) throw new Error('Invalid child contact request');
  const content = await transport.nip44Encrypt(r.endpoint, JSON.stringify(r));
  return transport.signEvent({ pubkey: r.client, kind: 30078, created_at: r.createdAt,
    tags: [['d', PREFIX + r.id]], content });
}
/** Expected author is the live pairing's transport key, never a supplied persona.
 * Only endpoint transport decryption is used. No child identity signer is exposed. */
export async function openChildContactRequest(event: NostrEvent, options: {
  scope: ChildRequestScope; endpoint: DecryptingSigningBackend; now: number; isCurrent(): boolean;
}): Promise<{ request: ChildContactRequest; fingerprint: string } | null> {
  try {
    const scope = structuredClone(options.scope); validScope(scope);
    if (!options.isCurrent() || !stamp(options.now) || options.endpoint.activePublicKeyHex !== scope.endpoint
      || event.pubkey !== scope.client || event.kind !== 30078 || !stamp(event.created_at)
      || event.created_at > options.now + 300 || event.created_at + TTL <= options.now
      || event.tags.length !== 1 || event.tags[0].length !== 2 || event.tags[0][0] !== 'd'
      || !event.tags[0][1].startsWith(PREFIX) || !ID.test(event.tags[0][1].slice(PREFIX.length))
      || typeof event.content !== 'string' || event.content.length > 20000
      || !verifyEvent({ id: event.id, sig: event.sig, pubkey: event.pubkey, kind: event.kind, created_at: event.created_at,
        tags: event.tags.map(t => [...t]), content: event.content })) return null;
    const raw = await options.endpoint.nip44Decrypt(scope.client, event.content);
    const request = parseChildContactRequest(raw);
    if (!options.isCurrent() || !request || !childContactRequestInScope(request, scope) || request.createdAt !== event.created_at
      || request.expiresAt <= options.now || event.tags[0][1] !== PREFIX + request.id) return null;
    return { request, fingerprint: bytesToHex(sha256(new TextEncoder().encode(raw))) };
  } catch { return null; }
}

/** The receipt is the status of record (D1). `approved` and `completed` are
 * reached only through `transitionChildContactReceipt`; nothing returns a
 * receipt to `pending`. */
export type ChildRequestStatus = 'pending' | 'approved' | 'completed' | 'denied' | 'expired' | 'conflict';
const STATUSES: readonly ChildRequestStatus[] = ['pending', 'approved', 'completed', 'denied', 'expired', 'conflict'];
export interface ChildRequestReceipt {
  id: string; fingerprint: string; revision: number; status: ChildRequestStatus; updatedAt: number;
  /** Retained only while pending; terminal receipts keep no invite capability. */
  request?: ChildContactRequest;
}
interface Inbox { v: 1; guardian: string; child: string; endpoint: string; client: string; receipts: ChildRequestReceipt[] }
function rowId(scope: ChildRequestScope): string {
  validScope(scope);
  return `child-contact-inbox:${scope.guardian}:${scope.child}:${scope.endpoint}:${scope.client}`;
}
function empty(scope: ChildRequestScope): Inbox {
  return { v: 1, guardian: scope.guardian, child: scope.child, endpoint: scope.endpoint, client: scope.client, receipts: [] };
}
function parseInbox(raw: Inbox, scope: ChildRequestScope): Inbox {
  if (!raw || raw.v !== 1 || ['guardian', 'child', 'endpoint', 'client'].some(k => raw[k as keyof Inbox] !== scope[k as keyof ChildRequestScope])
    || !Array.isArray(raw.receipts) || raw.receipts.length > RECEIPT_LIMIT || new Set(raw.receipts.map(r => r?.id)).size !== raw.receipts.length
    || raw.receipts.filter(r => r.status === 'pending').length > LIVE_LIMIT) throw new Error('Invalid child request inbox');
  const receipts: ChildRequestReceipt[] = [];
  for (const r of raw.receipts) {
    if (!r || typeof r.id !== 'string' || !ID.test(r.id) || typeof r.fingerprint !== 'string' || !HEX.test(r.fingerprint) || !stamp(r.revision) || r.revision < 1 || !stamp(r.updatedAt)
      || !STATUSES.includes(r.status)) throw new Error('Invalid child request receipt');
    const request = r.request && parseChildContactRequest(JSON.stringify(r.request));
    if (r.status === 'pending' ? !request || request.id !== r.id || request.revision !== r.revision
      || request.guardian !== scope.guardian || request.endpoint !== scope.endpoint || request.client !== scope.client
      : r.request !== undefined) throw new Error('Invalid child request receipt');
    receipts.push({ id: r.id, fingerprint: r.fingerprint, revision: r.revision, status: r.status, updatedAt: r.updatedAt, ...(request ? { request } : {}) });
  }
  return { ...empty(scope), receipts };
}
function expire(inbox: Inbox, scope: ChildRequestScope, now: number): Inbox {
  return { ...inbox, receipts: inbox.receipts.map(r => r.status === 'pending' && (r.request!.expiresAt <= now || !scope.personas.includes(r.request!.persona))
    ? { id: r.id, fingerprint: r.fingerprint, revision: r.revision, status: 'expired', updatedAt: now } : r) };
}
export async function loadChildContactInbox(scope: ChildRequestScope, key: string, now: number, current: () => boolean): Promise<ChildRequestReceipt[]> {
  scope = structuredClone(scope);
  const check = () => { if (!current()) throw new Error('Child request session changed'); };
  check();
  if (!stamp(now)) throw new Error('Invalid request clock');
  const row = await (await getDb()).get('privateVaultState', rowId(scope));
  if (!row) return [];
  const raw = await decryptSecret(row.encrypted, key);
  if (new TextEncoder().encode(raw).length > 1024 * 1024) throw new Error('Child request inbox exceeds limit');
  const inbox = parseInbox(JSON.parse(raw), scope), expired = expire(inbox, scope, now);
  check();
  if (expired.receipts.every((r, i) => r.status === inbox.receipts[i].status)) return inbox.receipts;
  // Make expiry/slot withdrawal sticky, including across a clock rollback or
  // subsequent re-showing of the same persona. Never revive a reviewed prompt.
  const saved = await updateEncryptedPrivateState<Inbox>(rowId(scope), key, previous => {
    check();
    if (previous === undefined) throw new Error('Child request inbox changed');
    return expire(parseInbox(previous, scope), scope, now);
  }, check);
  check();
  return saved.receipts;
}
/** Call only with the authenticated result from openChildContactRequest and a
 * freshly revalidated pairing. No execution or approval is implied by storage.
 * Overflow is visible to the caller; replay receipts are never silently evicted. */
export async function storeChildContactRequest(options: {
  scope: ChildRequestScope; key: string; request: ChildContactRequest; fingerprint: string; now: number; isCurrent(): boolean;
}): Promise<ChildRequestReceipt> {
  const o = { ...options, scope: structuredClone(options.scope), request: structuredClone(options.request) };
  const request = parseChildContactRequest(JSON.stringify(o.request));
  const check = () => { if (!o.isCurrent()) throw new Error('Child request session changed'); };
  if (!request || !childContactRequestInScope(request, o.scope) || !HEX.test(o.fingerprint) || !stamp(o.now)
    || request.createdAt > o.now + 300 || request.expiresAt <= o.now) throw new Error('Invalid current child request');
  check();
  const result = await updateEncryptedPrivateState<Inbox>(rowId(o.scope), o.key, previous => {
    check();
    const inbox = expire(parseInbox(previous === undefined ? empty(o.scope) : previous, o.scope), o.scope, o.now);
    const existing = inbox.receipts.find(r => r.id === request.id);
    if (existing) {
      if (existing.fingerprint === o.fingerprint || existing.status === 'conflict') return inbox;
      return { ...inbox, receipts: inbox.receipts.map(r => r.id === request.id
        ? { id: r.id, fingerprint: r.fingerprint, revision: r.revision, status: 'conflict', updatedAt: o.now } : r) };
    }
    if (inbox.receipts.length >= RECEIPT_LIMIT || inbox.receipts.filter(r => r.status === 'pending').length >= LIVE_LIMIT)
      throw new Error('Child request inbox is full');
    return { ...inbox, receipts: [...inbox.receipts, { id: request.id, fingerprint: o.fingerprint, revision: request.revision,
      status: 'pending', updatedAt: o.now, request }] };
  }, check);
  check();
  return result.receipts.find(r => r.id === request.id)!;
}

/** Compare-and-swap a receipt out of one of `from` into `to`. Idempotent when
 * the receipt already holds `to`; throws when it holds anything else, so a
 * caller never queues a reply that contradicts the status of record. */
export async function transitionChildContactReceipt(options: {
  scope: ChildRequestScope; key: string; requestId: string; from: readonly ChildRequestStatus[]; to: Exclude<ChildRequestStatus, 'pending'>;
  now: number; isCurrent(): boolean;
}): Promise<ChildRequestReceipt> {
  const o = { ...options, scope: structuredClone(options.scope) }; validScope(o.scope);
  if (!ID.test(o.requestId) || !stamp(o.now) || !STATUSES.includes(o.to) || (o.to as string) === 'pending') throw new Error('Invalid child receipt transition');
  const check = () => { if (!o.isCurrent()) throw new Error('Child request session changed'); };
  check();
  const saved = await updateEncryptedPrivateState<Inbox>(rowId(o.scope), o.key, previous => {
    check();
    if (previous === undefined) throw new Error('Child request receipt not found');
    const inbox = expire(parseInbox(previous, o.scope), o.scope, o.now);
    const receipt = inbox.receipts.find(r => r.id === o.requestId);
    if (!receipt) throw new Error('Child request receipt not found');
    if (receipt.status === o.to) return inbox;
    if (!o.from.includes(receipt.status)) throw new Error(`Child request is already ${receipt.status}`);
    return { ...inbox, receipts: inbox.receipts.map(r => r.id === o.requestId
      ? { id: r.id, fingerprint: r.fingerprint, revision: r.revision, status: o.to, updatedAt: Math.max(o.now, r.updatedAt) } : r) };
  }, check);
  check();
  return saved.receipts.find(r => r.id === o.requestId)!;
}
