import type { NostrEvent } from 'signet-protocol';
import { verifyEvent } from 'nostr-tools/pure';
import { getDb } from './db';
import { decryptSecret } from './crypto-store';
import { updateEncryptedPrivateState } from './private-vault-store';
import type { ChildRequestScope } from './child-contact-requests';
import { childContactReplyTransition, parseChildContactReply, type ChildContactReply } from './child-contact-exchange';

const HEX = /^[0-9a-f]{64}$/, ID = /^[0-9a-f]{32}$/;
const PREFIX = 'signet:child-contact-reply:v1:';
const stamp = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 253402300799;
export interface ChildContactReplyOutboxEntry { id: string; requestId: string; event: NostrEvent; reply?: ChildContactReply; relays: string[]; createdAt: number; acknowledgedAt?: number }
interface ReplyOutbox { v: 1; guardian: string; child: string; endpoint: string; client: string; entries: ChildContactReplyOutboxEntry[] }
function stateId(scope: ChildRequestScope) { return `child-contact-reply-outbox:${scope.guardian}:${scope.child}:${scope.endpoint}:${scope.client}`; }
function validScope(scope: ChildRequestScope) { if (![scope.guardian, scope.child, scope.endpoint, scope.client].every(k => typeof k === 'string' && HEX.test(k))) throw new Error('Invalid child reply scope'); }
function validEvent(event: NostrEvent, scope: ChildRequestScope) {
  const d = event.tags.find(t => t[0] === 'd')?.[1];
  return HEX.test(event.id) && event.pubkey === scope.endpoint && event.kind === 30078 && typeof event.content === 'string' && event.content.length <= 20000
    && Array.isArray(event.tags) && event.tags.length === 2 && event.tags.every(t => t.length === 2) && typeof d === 'string' && d.startsWith(PREFIX) && ID.test(d.slice(PREFIX.length))
    && event.tags.some(t => t[0] === 'p' && t[1] === scope.client) && verifyEvent(event);
}
function parseState(raw: ReplyOutbox, scope: ChildRequestScope): ReplyOutbox {
  if (!raw || raw.v !== 1 || raw.guardian !== scope.guardian || raw.child !== scope.child || raw.endpoint !== scope.endpoint || raw.client !== scope.client || !Array.isArray(raw.entries) || raw.entries.length > 32) throw new Error('Invalid child reply outbox');
  const entries = raw.entries.map(e => {
    if (!e || !ID.test(e.id) || e.id !== e.event?.tags.find(t => t[0] === 'd')?.[1]?.slice(PREFIX.length) || !validEvent(e.event, scope)
      || e.requestId !== e.id || !Array.isArray(e.relays) || e.relays.length > 32 || !e.relays.every(r => typeof r === 'string' && r.length <= 500)
      || !stamp(e.createdAt) || (e.acknowledgedAt !== undefined && !stamp(e.acknowledgedAt))) throw new Error('Invalid child reply outbox entry');
    if (e.reply !== undefined) {
      const reply = parseChildContactReply(JSON.stringify(e.reply));
      if (!reply || reply.requestId !== e.requestId || reply.guardian !== scope.guardian || reply.endpoint !== scope.endpoint
        || reply.client !== scope.client || reply.createdAt !== e.event.created_at) throw new Error('Invalid stored child reply payload');
    }
    return e;
  });
  if (new Set(entries.map(e => e.id)).size !== entries.length) throw new Error('Duplicate child reply outbox entry');
  return { v: 1, guardian: scope.guardian, child: scope.child, endpoint: scope.endpoint, client: scope.client, entries };
}
export async function loadChildContactReplyOutbox(scope: ChildRequestScope, key: string, current: () => boolean): Promise<ChildContactReplyOutboxEntry[]> {
  scope = structuredClone(scope); validScope(scope); if (!current()) throw new Error('Child reply session changed');
  const row = await (await getDb()).get('privateVaultState', stateId(scope)); if (!row) return [];
  const state = parseState(JSON.parse(await decryptSecret(row.encrypted, key)), scope); if (!current()) throw new Error('Child reply session changed'); return state.entries;
}
/** `replaceUnreconciled` is the explicit guardian Cancel (D3): only an
 * `expired` reply may replace an older entry that lacks transition metadata. */
export function queueChildContactReply(options: { scope: ChildRequestScope; key: string; requestId: string; event: NostrEvent; reply: ChildContactReply; relays: string[]; now: number; isCurrent(): boolean; replaceUnreconciled?: boolean }): Promise<ChildContactReplyOutboxEntry> {
  const o = { ...options, scope: structuredClone(options.scope) }; validScope(o.scope); if (!ID.test(o.requestId) || !stamp(o.now) || !validEvent(o.event, o.scope) || !o.relays.length || o.relays.length > 32) return Promise.reject(new Error('Invalid child reply outbox entry'));
  const check = () => { if (!o.isCurrent()) throw new Error('Child reply session changed'); };
  const reply = parseChildContactReply(JSON.stringify(o.reply));
  if (!reply || reply.requestId !== o.requestId || reply.guardian !== o.scope.guardian || reply.endpoint !== o.scope.endpoint
    || reply.client !== o.scope.client || !o.scope.personas.includes(reply.persona) || reply.createdAt !== o.event.created_at
    || o.event.tags.find(t => t[0] === 'd')?.[1] !== PREFIX + o.requestId) return Promise.reject(new Error('Invalid child reply payload'));
  return updateEncryptedPrivateState<ReplyOutbox>(stateId(o.scope), o.key, previous => {
    check(); const state = parseState(previous ?? { v: 1, guardian: o.scope.guardian, child: o.scope.child, endpoint: o.scope.endpoint, client: o.scope.client, entries: [] }, o.scope);
    const id = o.event.tags.find(t => t[0] === 'd')![1].slice(PREFIX.length), old = state.entries.find(e => e.id === id);
    if (old) {
      if (old.requestId !== o.requestId) throw new Error('Child reply outbox conflict');
      if (old.event.id === o.event.id) return state;
      // Older local entries lack transition metadata and require reconciliation.
      if (!old.reply && !(o.replaceUnreconciled && reply.status === 'expired')) throw new Error('Child reply needs reconciliation');
      if (old.reply && childContactReplyTransition(old.reply, reply) !== 'advance') return state;
      return { ...state, entries: state.entries.map(e => e.id === id
        ? { id, requestId: o.requestId, event: o.event, reply, relays: [...o.relays], createdAt: o.now } : e) };
    }
    // An expired reply can never be delivered; its request expired before it.
    const kept = state.entries.length >= 32 ? state.entries.filter(e => !e.reply || e.reply.expiresAt > o.now) : state.entries;
    if (kept.length >= 32) throw new Error('Child reply outbox is full');
    return { ...state, entries: [...kept, { id, requestId: o.requestId, event: o.event, reply, relays: [...o.relays], createdAt: o.now }] };
  }, check).then(state => state.entries.find(e => e.id === o.event.tags.find(t => t[0] === 'd')![1].slice(PREFIX.length))!);
}
export async function deliverChildContactReply(options: { scope: ChildRequestScope; key: string; id: string; now: number; isCurrent(): boolean; mayDeliver(): boolean | Promise<boolean>; publish(event: NostrEvent, relays: string[]): Promise<boolean> }): Promise<boolean> {
  const o = { ...options, scope: structuredClone(options.scope) }; validScope(o.scope); if (!ID.test(o.id) || !stamp(o.now)) throw new Error('Invalid child reply delivery');
  const check = () => { if (!o.isCurrent()) throw new Error('Child reply session changed'); };
  check(); const before = (await loadChildContactReplyOutbox(o.scope, o.key, o.isCurrent)).find(e => e.id === o.id); if (!before || before.acknowledgedAt) return false;
  if (!await o.mayDeliver()) throw new Error('Child reply policy changed'); check();
  const sent = await o.publish(before.event, before.relays); check(); if (!sent) return false;
  const saved = await updateEncryptedPrivateState<ReplyOutbox>(stateId(o.scope), o.key, previous => {
    check(); const state = parseState(previous!, o.scope); const current = state.entries.find(e => e.id === o.id);
    if (!current || current.acknowledgedAt || current.event.id !== before.event.id) throw new Error('Child reply outbox changed');
    return { ...state, entries: state.entries.map(e => e.id === o.id ? { ...e, acknowledgedAt: o.now } : e) };
  }, check); check(); return !!saved.entries.find(e => e.id === o.id)?.acknowledgedAt;
}

/** Retry every queued, unacknowledged reply with its stored signed event. A
 * relay failure leaves the entry pending; nothing is signed again here. */
export async function deliverPendingChildContactReplies(options: { scope: ChildRequestScope; key: string; now: number; isCurrent(): boolean;
  mayDeliver(entry: ChildContactReplyOutboxEntry): boolean | Promise<boolean>; publish(event: NostrEvent, relays: string[], entry: ChildContactReplyOutboxEntry): Promise<boolean> }): Promise<number> {
  let delivered = 0;
  for (const entry of await loadChildContactReplyOutbox(options.scope, options.key, options.isCurrent)) {
    if (entry.acknowledgedAt || !entry.reply || entry.reply.expiresAt <= options.now) continue;
    try {
      if (await deliverChildContactReply({ scope: options.scope, key: options.key, id: entry.id, now: options.now, isCurrent: options.isCurrent,
        mayDeliver: () => options.mayDeliver(entry), publish: (event, relays) => options.publish(event, relays, entry) })) delivered++;
    } catch (cause) { if (!options.isCurrent()) throw cause; /* Withheld now; the entry stays queued. */ }
  }
  return delivered;
}
