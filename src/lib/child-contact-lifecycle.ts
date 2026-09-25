import type { NostrEvent } from 'signet-protocol';
import type { ContactInvite } from '@forgesworn/signet-contacts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import type { DecryptingSigningBackend } from './signing-backend';
import { loadChildContactInbox, parseChildContactRequest, sealChildContactRequest, transitionChildContactReceipt,
  type ChildContactRequest, type ChildRequestReceipt, type ChildRequestScope, type ChildRequestStatus } from './child-contact-requests';
import { CHILD_REPLY_FOR_RECEIPT, cancelChildContactExchange, loadChildContactReview, reviewChildContactRequest, type ChildContactExchangePlan } from './child-contact-review';
import { cancelChildContactExecution, loadChildContactExecutions, type ChildContactExecution } from './child-contact-execution';
import { deliverChildContactReply, loadChildContactReplyOutbox, queueChildContactReply, type ChildContactReplyOutboxEntry } from './child-contact-reply-delivery';
import { attachChildContactRequestEvent, queueChildContactRequest, sealChildContactReply,
  type ChildContactReply, type ChildContactReplyStatus } from './child-contact-exchange';

const REPLY_TTL = 600;
const CHILD_REQUEST_TTL = 600;

export interface ChildReplyTransport {
  /** The dependant's pinned endpoint key. Never a guardian identity signer. */
  transport: DecryptingSigningBackend; relays: string[];
  /** Re-checked before signing and again immediately before publication. */
  mayDeliver(): boolean | Promise<boolean>;
  publish(event: NostrEvent, relays: string[]): Promise<boolean>;
}

/** Seal with the transport key, persist in the durable outbox, then deliver.
 * Returns false when withheld or the relay did not acknowledge; a queued
 * entry stays pending for a later retry with the same signed event. */
export async function sendChildContactReply(options: ChildReplyTransport & {
  scope: ChildRequestScope; key: string; plan: ChildContactExchangePlan; status: ChildContactReplyStatus;
  now: number; isCurrent(): boolean; exchangeId?: string; contactId?: string; replaceUnreconciled?: boolean;
}): Promise<boolean> {
  const o = options;
  const check = () => { if (!o.isCurrent()) throw new Error('Child reply session changed'); };
  if (!await o.mayDeliver()) return false;
  check();
  const previous = (await loadChildContactReplyOutbox(o.scope, o.key, o.isCurrent)).find(row => row.requestId === o.plan.requestId);
  const now = Math.max(o.now, (previous?.event.created_at ?? 0) + 1);
  const reply: ChildContactReply = { v: 1, requestId: o.plan.requestId, guardian: o.scope.guardian, endpoint: o.scope.endpoint,
    client: o.scope.client, persona: o.plan.persona, revision: o.plan.request.revision, createdAt: now, expiresAt: now + REPLY_TTL,
    status: o.status, ...(o.status === 'completed' ? { exchangeId: o.exchangeId, contactId: o.contactId } : {}) };
  const event = await sealChildContactReply(reply, o.transport);
  check();
  await queueChildContactReply({ scope: o.scope, key: o.key, requestId: o.plan.requestId, event, reply, relays: o.relays, now,
    isCurrent: o.isCurrent, replaceUnreconciled: o.replaceUnreconciled });
  try {
    return await deliverChildContactReply({ scope: o.scope, key: o.key, id: o.plan.requestId, now, isCurrent: o.isCurrent,
      mayDeliver: o.mayDeliver, publish: o.publish });
  } catch (cause) {
    // Queued before the check failed: it stays pending, withheld, never re-signed.
    check(); if (cause instanceof Error && /policy changed/.test(cause.message)) return false; throw cause;
  }
}

/** D1 order: persist the review plan, (approval only) execute the exchange,
 * compare-and-swap the receipt out of pending, then queue the reply. */
export async function decideChildContactRequest(options: {
  scope: ChildRequestScope; key: string; requestId: string; fingerprint: string; decision: 'approve' | 'deny'; now(): number;
  isCurrent(): boolean; mayConnect(peer: string): boolean | Promise<boolean>;
  /** Sign and persist the exchange for an approved plan. Nothing may publish yet. */
  execute(plan: ChildContactExchangePlan): Promise<void>;
  /** Withdraw a persisted exchange whose receipt left pending meanwhile. */
  abandon(plan: ChildContactExchangePlan): Promise<void>;
  /** Queue and deliver the reply for the new receipt status. */
  reply(plan: ChildContactExchangePlan, status: 'pending' | 'denied'): Promise<void>;
}): Promise<ChildContactExchangePlan> {
  const o = options;
  const plan = await reviewChildContactRequest({ scope: o.scope, key: o.key, requestId: o.requestId, fingerprint: o.fingerprint,
    decision: o.decision, now: o.now(), isCurrent: o.isCurrent, mayConnect: o.mayConnect });
  if (plan.status === 'approved') await o.execute(plan);
  try {
    await transitionChildContactReceipt({ scope: o.scope, key: o.key, requestId: plan.requestId, from: ['pending'],
      to: plan.status === 'approved' ? 'approved' : 'denied', now: o.now(), isCurrent: o.isCurrent });
  } catch (cause) {
    if (plan.status === 'approved' && o.isCurrent()) {
      await o.abandon(plan);
      await cancelChildContactExchange({ scope: o.scope, key: o.key, requestId: plan.requestId, now: o.now(), isCurrent: o.isCurrent });
    }
    throw cause;
  }
  await o.reply(plan, plan.status === 'approved' ? 'pending' : 'denied');
  return plan;
}

/** A plan is stuck when either reconciliation state is reached (D3): a signer
 * attempt whose result was never recorded, or a queued reply without
 * transition metadata. Cancelled, denied and finished requests are not. */
export function stuckChildContactPlans(receipts: ChildRequestReceipt[], plans: ChildContactExchangePlan[],
  executions: ChildContactExecution[], replies: ChildContactReplyOutboxEntry[]): ChildContactExchangePlan[] {
  return plans.filter(plan => {
    if (plan.status !== 'approved') return false;
    const receipt = receipts.find(r => r.id === plan.requestId);
    if (receipt && (receipt.status === 'completed' || receipt.status === 'conflict' || receipt.status === 'denied')) return false;
    return executions.some(e => e.exchangeId === plan.exchangeId && e.status === 'planned')
      || replies.some(r => r.requestId === plan.requestId && !r.reply);
  });
}

/** An exchange lives at most 30 days from signing, and signing happens while
 * the request is live. Past this the peer can no longer answer. */
export const CHILD_EXCHANGE_ABANDON_AFTER = 31 * 86400;
/** Approved requests whose exchange can no longer complete. The invite service
 * reports an expired exchange directly; this backstop catches one it declined
 * or compacted first, so an unanswered approval never holds a live slot. */
export function abandonedChildContactPlans(receipts: ChildRequestReceipt[], plans: ChildContactExchangePlan[], now: number): ChildContactExchangePlan[] {
  return plans.filter(plan => plan.status === 'approved' && receipts.find(r => r.id === plan.requestId)?.status === 'approved'
    && plan.request.expiresAt + CHILD_EXCHANGE_ABANDON_AFTER <= now);
}
export interface ChildRequestLifecycle { receipts: ChildRequestReceipt[]; stuck: ChildContactExchangePlan[]; abandoned: ChildContactExchangePlan[] }
export async function loadChildContactLifecycle(scope: ChildRequestScope, key: string, now: number, current: () => boolean): Promise<ChildRequestLifecycle> {
  const receipts = await loadChildContactInbox(scope, key, now, current);
  const [plans, executions, replies] = [await loadChildContactReview(scope, key, current),
    await loadChildContactExecutions(scope, key, current), await loadChildContactReplyOutbox(scope, key, current)];
  return { receipts, stuck: stuckChildContactPlans(receipts, plans, executions, replies), abandoned: abandonedChildContactPlans(receipts, plans, now) };
}

/** Gate for the invite service (review finding 1): a child exchange may
 * publish or record only while its plan is approved and its receipt is
 * approved or completed. A pending receipt means the decision is still being
 * recorded; anything else withdraws the exchange. */
export async function childExchangeAuthority(options: { scope: ChildRequestScope; key: string; exchangeId: string; now: number; isCurrent(): boolean }): Promise<'go' | 'wait' | 'withdraw'> {
  const plan = (await loadChildContactReview(options.scope, options.key, options.isCurrent)).find(p => p.exchangeId === options.exchangeId);
  if (!plan || plan.status !== 'approved') return 'withdraw';
  const receipt = (await loadChildContactInbox(options.scope, options.key, options.now, options.isCurrent)).find(r => r.id === plan.requestId);
  if (receipt?.status === 'approved' || receipt?.status === 'completed') return 'go';
  return receipt?.status === 'pending' ? 'wait' : 'withdraw';
}

/** Explicit guardian Cancel (D3), expiry sweep of a stuck row, and re-pair
 * cancellation (D5, `reply` omitted: the old endpoint is gone). Idempotent. */
export async function cancelChildContactRequest(options: {
  scope: ChildRequestScope; key: string; requestId: string; now: number; isCurrent(): boolean;
  /** Decline the matching invite-service exchange so nothing more is published. */
  cancelExchange?(plan: ChildContactExchangePlan): Promise<void>;
  reply?: ChildReplyTransport;
}): Promise<ChildContactExchangePlan | null> {
  const o = options;
  const plan = (await loadChildContactReview(o.scope, o.key, o.isCurrent)).find(p => p.requestId === o.requestId);
  if (!plan) return null;
  if (plan.status !== 'cancelled') await cancelChildContactExchange({ scope: o.scope, key: o.key, requestId: o.requestId, now: o.now, isCurrent: o.isCurrent });
  if ((await loadChildContactExecutions(o.scope, o.key, o.isCurrent)).some(e => e.exchangeId === plan.exchangeId && e.status === 'planned'))
    await cancelChildContactExecution({ scope: o.scope, key: o.key, exchangeId: plan.exchangeId, now: o.now, isCurrent: o.isCurrent });
  await o.cancelExchange?.(plan);
  const receipt = (await loadChildContactInbox(o.scope, o.key, o.now, o.isCurrent)).find(r => r.id === o.requestId);
  // A request that already finished keeps its result; only a live one expires.
  if (receipt && receipt.status !== 'pending' && receipt.status !== 'approved' && receipt.status !== 'expired') return plan;
  if (receipt) await transitionChildContactReceipt({ scope: o.scope, key: o.key, requestId: o.requestId, from: ['pending', 'approved'],
    to: 'expired', now: o.now, isCurrent: o.isCurrent });
  if (o.reply) {
    const sent = (await loadChildContactReplyOutbox(o.scope, o.key, o.isCurrent)).find(r => r.requestId === o.requestId);
    if (sent?.reply?.status !== 'expired')
      await sendChildContactReply({ ...o.reply, scope: o.scope, key: o.key, plan, status: 'expired', now: o.now, isCurrent: o.isCurrent, replaceUnreconciled: true });
  }
  return plan;
}

/** Which plan a terminal receipt belongs to; an expired receipt only follows
 * an explicit cancel (a stuck approved plan is left to the sweep). */
const RECEIPT_PLAN: Partial<Record<ChildRequestReceipt['status'], ChildContactExchangePlan['status']>> = {
  approved: 'approved', completed: 'approved', denied: 'denied', expired: 'cancelled',
};
/** Close the crash gap between a receipt swap and its reply (D1): queue the
 * reply the receipt calls for when none is in the outbox. Only transport-key
 * replies exist, so nothing asks an identity signer. The window is the reply
 * lifetime after the swap, which is also when an expired, compacted outbox
 * entry could have been removed, so a delivered reply is never duplicated. */
export async function reconcileChildContactReplies(options: {
  scope: ChildRequestScope; key: string; now: number; isCurrent(): boolean;
  /** Transport for a reply, or null while the pairing no longer covers it. */
  transport(plan: ChildContactExchangePlan, status: ChildContactReplyStatus): Promise<ChildReplyTransport | null>;
  completedContactId?(plan: ChildContactExchangePlan): Promise<string | undefined>;
}): Promise<number> {
  const o = options;
  const receipts = await loadChildContactInbox(o.scope, o.key, o.now, o.isCurrent);
  const plans = await loadChildContactReview(o.scope, o.key, o.isCurrent);
  const replies = await loadChildContactReplyOutbox(o.scope, o.key, o.isCurrent);
  let queued = 0;
  for (const plan of plans) {
    const receipt = receipts.find(r => r.id === plan.requestId);
    const status = receipt && CHILD_REPLY_FOR_RECEIPT[receipt.status];
    if (!receipt || !status || RECEIPT_PLAN[receipt.status] !== plan.status || receipt.updatedAt + REPLY_TTL <= o.now) continue;
    const entry = replies.find(r => r.requestId === plan.requestId);
    // Present already, or a legacy entry that needs the explicit Cancel.
    if (entry && (!entry.reply || entry.reply.status === status || entry.reply.status !== 'pending')) continue;
    const transport = await o.transport(plan, status);
    if (!transport || !o.isCurrent()) continue;
    const contactId = status === 'completed' ? await o.completedContactId?.(plan) : undefined;
    await sendChildContactReply({ ...transport, scope: o.scope, key: o.key, plan, status, now: o.now, isCurrent: o.isCurrent,
      ...(status === 'completed' ? { exchangeId: plan.exchangeId, ...(contactId ? { contactId } : {}) } : {}) });
    queued++;
  }
  return queued;
}

/** D6: the child's own submission. Builds a fresh request for the scope's
 * persona — the caller must already have excluded a dormant real identity
 * from `scope.personas`; this only refuses a persona outside that set —
 * queues it durably BEFORE signing (a crash after signing never loses the
 * attempt), seals with the transport (pinned client) key, attaches the
 * signed event to the same outbox row, then publishes. Queue overflow
 * ('Child request outbox is full', the existing 32-live bound) is thrown,
 * not swallowed, so the caller shows it rather than silently dropping the
 * ask. */
export async function submitChildContactRequest(options: {
  scope: ChildRequestScope; key: string; persona: string; invite: ContactInvite; now: number; isCurrent(): boolean;
  transport: DecryptingSigningBackend; relays: string[]; publish(event: NostrEvent, relays: string[]): Promise<boolean>;
}): Promise<{ requestId: string; published: boolean }> {
  const o = options;
  if (!o.scope.personas.includes(o.persona)) throw new Error('This persona is not available to ask with');
  const check = () => { if (!o.isCurrent()) throw new Error('Child request session changed'); };
  check();
  const id = bytesToHex(randomBytes(16));
  const candidate: ChildContactRequest = { v: 1, id, guardian: o.scope.guardian, endpoint: o.scope.endpoint,
    client: o.scope.client, persona: o.persona, revision: 1, createdAt: o.now, expiresAt: o.now + CHILD_REQUEST_TTL, invite: o.invite };
  const request = parseChildContactRequest(JSON.stringify(candidate));
  if (!request) throw new Error('Unable to build this request');
  const fingerprint = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(request))));
  await queueChildContactRequest({ scope: o.scope, key: o.key, request, fingerprint, now: o.now, isCurrent: o.isCurrent });
  check();
  const event = await sealChildContactRequest(request, o.transport);
  check();
  await attachChildContactRequestEvent({ scope: o.scope, key: o.key, requestId: request.id, event, isCurrent: o.isCurrent });
  const published = await o.publish(event, o.relays);
  return { requestId: request.id, published };
}

/** D4 (guardian). Read-only over the existing receipt store: the 10 most
 * recently updated terminal receipts, no new store or retention bound. */
const TERMINAL_RECEIPT_STATUSES: readonly ChildRequestStatus[] = ['approved', 'completed', 'denied', 'expired', 'conflict'];
export function guardianChildContactHistory(receipts: readonly ChildRequestReceipt[]): ChildRequestReceipt[] {
  return receipts.filter(r => TERMINAL_RECEIPT_STATUSES.includes(r.status))
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
}
export const GUARDIAN_CHILD_HISTORY_LABEL: Record<Exclude<ChildRequestStatus, 'pending'>, string> = {
  approved: 'Approved', completed: 'Completed', denied: 'Denied', expired: 'Expired', conflict: 'Conflict',
};

/** D4 (child). The child's own history — merges the durable outgoing
 * outbox (every request this device has sent) with the reply inbox (the
 * guardian's latest known answer), capped to the 20 most recently updated.
 * Read-only; no new store, no new retention beyond the existing 32-live
 * outbox and 1024-row reply inbox. A `reply.status` of `'pending'` means
 * the guardian approved and the exchange is under way — shown to the child
 * as `'approved'`, distinct from `'added'` (the exchange completed). */
export type ChildContactAskStatus = 'waiting' | 'approved' | 'added' | 'declined' | 'expired' | 'conflict';
export interface ChildContactAskHistoryItem { requestId: string; updatedAt: number; status: ChildContactAskStatus; caption?: string }
const REPLY_TO_ASK_STATUS: Record<ChildContactReplyStatus, ChildContactAskStatus> = {
  pending: 'approved', denied: 'declined', expired: 'expired', conflict: 'conflict', completed: 'added',
};
export const CHILD_ASK_HISTORY_LABEL: Record<ChildContactAskStatus, string> = {
  waiting: 'Waiting', approved: 'Approved', added: 'Added', declined: 'Declined', expired: 'Expired', conflict: 'Conflict',
};
export function childContactRequestHistory(
  outbox: readonly { request: ChildContactRequest; createdAt: number }[],
  replies: readonly { reply: ChildContactReply }[],
): ChildContactAskHistoryItem[] {
  const byRequest = new Map(replies.map(r => [r.reply.requestId, r.reply]));
  return outbox.map(entry => {
    const reply = byRequest.get(entry.request.id);
    const updatedAt = reply ? Math.max(entry.createdAt, reply.createdAt) : entry.createdAt;
    return { requestId: entry.request.id, updatedAt, status: reply ? REPLY_TO_ASK_STATUS[reply.status] : 'waiting',
      ...(entry.request.invite.caption ? { caption: entry.request.invite.caption } : {}) };
  }).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
}
