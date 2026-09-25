import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { getDb } from './db';
import { decryptSecret } from './crypto-store';
import { updateEncryptedPrivateState } from './private-vault-store';
import { loadChildContactInbox, type ChildContactRequest, type ChildRequestReceipt, type ChildRequestScope, type ChildRequestStatus } from './child-contact-requests';
import { loadChildContactReplyOutbox, type ChildContactReplyOutboxEntry } from './child-contact-reply-delivery';
import type { ChildContactReplyStatus } from './child-contact-exchange';

const HEX = /^[0-9a-f]{64}$/, ID = /^[0-9a-f]{32}$/;
const stamp = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 253402300799;
/** Unsettled plans per pairing; settled plans are kept for idempotency within
 * the receipt-retention bound and evicted oldest-first beyond it. */
const LIVE_LIMIT = 32, RETAIN_LIMIT = 1024;
/** The reply each receipt status calls for; conflicts and pending need none. */
export const CHILD_REPLY_FOR_RECEIPT: Partial<Record<ChildRequestStatus, ChildContactReplyStatus>> = {
  approved: 'pending', completed: 'completed', denied: 'denied', expired: 'expired',
};
/** Settled: the receipt is final for this plan, and its matching reply was
 * delivered, has expired, or is not required (a cancel with no reply). An
 * approved plan settles only on completion or cancellation, so a pending or
 * stuck request is never settled. */
export function childContactPlanSettled(plan: ChildContactExchangePlan, receipt: ChildRequestReceipt | undefined,
  entry: ChildContactReplyOutboxEntry | undefined, now: number): boolean {
  if (receipt && !['denied', 'expired', 'completed', 'conflict'].includes(receipt.status)) return false;
  if (plan.status === 'approved' && receipt?.status !== 'completed') return false;
  const expected = receipt && CHILD_REPLY_FOR_RECEIPT[receipt.status];
  const matching = entry?.reply && entry.reply.status === expected ? entry : undefined;
  if (matching) return !!matching.acknowledgedAt || matching.reply!.expiresAt <= now;
  return !expected || plan.status === 'cancelled' || plan.request.expiresAt <= now;
}
async function settledRequestIds(scope: ChildRequestScope, key: string, plans: ChildContactExchangePlan[], now: number, current: () => boolean): Promise<Set<string>> {
  if (!plans.length) return new Set();
  const receipts = await loadChildContactInbox(scope, key, now, current);
  const replies = await loadChildContactReplyOutbox(scope, key, current);
  return new Set(plans.filter(p => childContactPlanSettled(p, receipts.find(r => r.id === p.requestId),
    replies.find(r => r.requestId === p.requestId), now)).map(p => p.requestId));
}
export async function loadSettledChildContactPlans(scope: ChildRequestScope, key: string, now: number, current: () => boolean): Promise<Set<string>> {
  return settledRequestIds(scope, key, await loadChildContactReview(scope, key, current), now, current);
}
export type ChildContactReviewStatus = 'approved' | 'denied' | 'cancelled';
export interface ChildContactExchangePlan {
  v: 1; requestId: string; fingerprint: string; guardian: string; child: string; endpoint: string; client: string; persona: string;
  peer: string; exchangeId: string; status: ChildContactReviewStatus; createdAt: number; updatedAt: number; nonce: string; replySecret: string;
  /** Encrypted at rest with the pairing vault key; never sent in a public tag. */
  request: ChildContactRequest;
}
interface ReviewState { v: 1; guardian: string; child: string; endpoint: string; client: string; plans: ChildContactExchangePlan[] }

function validScope(scope: ChildRequestScope) {
  if (![scope.guardian, scope.child, scope.endpoint, scope.client].every(k => typeof k === 'string' && HEX.test(k))
    || !Array.isArray(scope.personas) || scope.personas.length > 32 || !scope.personas.every(k => typeof k === 'string' && HEX.test(k))) throw new Error('Invalid child review scope');
}
function stateId(scope: ChildRequestScope) { validScope(scope); return `child-contact-review:${scope.guardian}:${scope.child}:${scope.endpoint}:${scope.client}`; }
function exchangeId(scope: ChildRequestScope, requestId: string) { return bytesToHex(sha256(new TextEncoder().encode(`child-contact-exchange:v1:${scope.guardian}:${scope.child}:${requestId}`))).slice(0, 32); }
function parseState(raw: ReviewState, scope: ChildRequestScope): ReviewState {
  if (!raw || raw.v !== 1 || raw.guardian !== scope.guardian || raw.child !== scope.child || raw.endpoint !== scope.endpoint || raw.client !== scope.client || !Array.isArray(raw.plans) || raw.plans.length > RETAIN_LIMIT) throw new Error('Invalid child review state');
  const plans = raw.plans.map(plan => {
    if (!plan || plan.v !== 1 || !ID.test(plan.requestId) || !HEX.test(plan.fingerprint) || !HEX.test(plan.guardian) || !HEX.test(plan.child)
      || !HEX.test(plan.endpoint) || !HEX.test(plan.client) || !HEX.test(plan.persona) || !HEX.test(plan.peer) || !ID.test(plan.exchangeId)
      || !HEX.test(plan.nonce) || !HEX.test(plan.replySecret)
      || !['approved', 'denied', 'cancelled'].includes(plan.status) || !stamp(plan.createdAt) || !stamp(plan.updatedAt) || plan.updatedAt < plan.createdAt) throw new Error('Invalid child review plan');
    if (plan.guardian !== scope.guardian || plan.child !== scope.child || plan.endpoint !== scope.endpoint || plan.client !== scope.client
      || exchangeId(scope, plan.requestId) !== plan.exchangeId || plan.request.id !== plan.requestId || plan.request.client !== scope.client
      || plan.request.guardian !== scope.guardian || plan.request.endpoint !== scope.endpoint || plan.request.persona !== plan.persona
      || plan.request.invite.recipient !== plan.peer) throw new Error('Invalid child review plan request');
    return plan;
  });
  if (new Set(plans.map(p => p.requestId)).size !== plans.length || new Set(plans.map(p => p.exchangeId)).size !== plans.length) throw new Error('Duplicate child review plan');
  return { v: 1, guardian: scope.guardian, child: scope.child, endpoint: scope.endpoint, client: scope.client, plans };
}

export async function loadChildContactReview(scope: ChildRequestScope, key: string, current: () => boolean): Promise<ChildContactExchangePlan[]> {
  scope = structuredClone(scope); validScope(scope); if (!current()) throw new Error('Child review session changed');
  const row = await (await getDb()).get('privateVaultState', stateId(scope));
  if (!row) return [];
  const state = parseState(JSON.parse(await decryptSecret(row.encrypted, key)), scope);
  if (!current()) throw new Error('Child review session changed');
  return state.plans;
}

export async function reviewChildContactRequest(options: {
  scope: ChildRequestScope; key: string; requestId: string; fingerprint: string; decision: 'approve' | 'deny'; now: number;
  isCurrent(): boolean; mayConnect(peer: string): boolean | Promise<boolean>;
}): Promise<ChildContactExchangePlan> {
  const o = { ...options, scope: structuredClone(options.scope) }; validScope(o.scope);
  if (!ID.test(o.requestId) || !HEX.test(o.fingerprint) || !stamp(o.now)) throw new Error('Invalid child review decision');
  const check = () => { if (!o.isCurrent()) throw new Error('Child review session changed'); };
  check();
  const receipt = (await loadChildContactInbox(o.scope, o.key, o.now, o.isCurrent)).find(r => r.id === o.requestId);
  if (!receipt || receipt.status !== 'pending' || receipt.fingerprint !== o.fingerprint || !receipt.request) throw new Error('Child request is no longer reviewable');
  const request = structuredClone(receipt.request);
  if (request.expiresAt <= o.now || !o.scope.personas.includes(request.persona)) throw new Error('Child request expired or withdrawn');
  if (o.decision === 'approve' && !await o.mayConnect(request.invite.recipient)) throw new Error('The contact policy changed');
  check();
  const settled = await settledRequestIds(o.scope, o.key, await loadChildContactReview(o.scope, o.key, o.isCurrent), o.now, o.isCurrent);
  check();
  const plan: ChildContactExchangePlan = { v: 1, requestId: request.id, fingerprint: o.fingerprint, guardian: o.scope.guardian,
    child: o.scope.child, endpoint: o.scope.endpoint, client: o.scope.client, persona: request.persona, peer: request.invite.recipient,
    exchangeId: exchangeId(o.scope, request.id), status: o.decision === 'approve' ? 'approved' : 'denied', createdAt: o.now, updatedAt: o.now,
    nonce: bytesToHex(randomBytes(32)), replySecret: bytesToHex(randomBytes(32)), request };
  const saved = await updateEncryptedPrivateState<ReviewState>(stateId(o.scope), o.key, previous => {
    check(); const state = parseState(previous ?? { v: 1, guardian: o.scope.guardian, child: o.scope.child, endpoint: o.scope.endpoint, client: o.scope.client, plans: [] }, o.scope);
    const existing = state.plans.find(p => p.requestId === request.id);
    if (existing) {
      if (existing.fingerprint !== o.fingerprint) throw new Error('Child request review conflict');
      if (existing.status !== plan.status) throw new Error('Child request already reviewed');
      return state;
    }
    if (state.plans.filter(p => !settled.has(p.requestId)).length >= LIVE_LIMIT) throw new Error('Child review queue is full');
    let plans = state.plans;
    if (plans.length >= RETAIN_LIMIT) {
      const oldest = plans.filter(p => settled.has(p.requestId)).sort((a, b) => a.updatedAt - b.updatedAt || (a.requestId < b.requestId ? -1 : 1))[0];
      if (!oldest) throw new Error('Child review queue is full');
      plans = plans.filter(p => p !== oldest);
    }
    return { ...state, plans: [...plans, plan] };
  }, check);
  check();
  return saved.plans.find(p => p.requestId === request.id)!;
}

export async function cancelChildContactExchange(options: { scope: ChildRequestScope; key: string; requestId: string; now: number; isCurrent(): boolean }): Promise<ChildContactExchangePlan> {
  const o = { ...options, scope: structuredClone(options.scope) }; validScope(o.scope);
  if (!ID.test(o.requestId) || !stamp(o.now)) throw new Error('Invalid child exchange cancellation');
  const check = () => { if (!o.isCurrent()) throw new Error('Child review session changed'); };
  const saved = await updateEncryptedPrivateState<ReviewState>(stateId(o.scope), o.key, previous => {
    check(); const state = parseState(previous ?? { v: 1, guardian: o.scope.guardian, child: o.scope.child, endpoint: o.scope.endpoint, client: o.scope.client, plans: [] }, o.scope);
    const plan = state.plans.find(p => p.requestId === o.requestId);
    if (!plan) throw new Error('Child exchange plan not found');
    if (plan.status === 'cancelled') return state;
    return { ...state, plans: state.plans.map(p => p.requestId === o.requestId ? { ...p, status: 'cancelled' as const, updatedAt: o.now } : p) };
  }, check);
  check();
  return saved.plans.find(p => p.requestId === o.requestId)!;
}
