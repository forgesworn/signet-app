import type { NostrEvent } from 'signet-protocol';
import { getDb } from './db';
import { decryptSecret } from './crypto-store';
import { updateEncryptedPrivateState } from './private-vault-store';
import { loadChildContactReview, loadSettledChildContactPlans, type ChildContactExchangePlan } from './child-contact-review';
import type { ChildRequestScope } from './child-contact-requests';

const HEX = /^[0-9a-f]{64}$/, ID = /^[0-9a-f]{32}$/;
const stamp = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 253402300799;
export type ChildContactExecutionStatus = 'planned' | 'signed' | 'cancelled';
export interface ChildContactExecution {
  v: 1; requestId: string; exchangeId: string; status: ChildContactExecutionStatus; createdAt: number; updatedAt: number; event?: NostrEvent;
}
interface ExecutionState { v: 1; guardian: string; child: string; endpoint: string; client: string; executions: ChildContactExecution[] }
function stateId(scope: ChildRequestScope) { return `child-contact-execution:${scope.guardian}:${scope.child}:${scope.endpoint}:${scope.client}`; }
function validScope(scope: ChildRequestScope) {
  if (![scope.guardian, scope.child, scope.endpoint, scope.client].every(k => typeof k === 'string' && HEX.test(k))) throw new Error('Invalid child execution scope');
}
function parseEvent(event: unknown): event is NostrEvent {
  const e = event as NostrEvent;
  return !!e && HEX.test(e.id) && HEX.test(e.pubkey) && Number.isSafeInteger(e.kind) && stamp(e.created_at)
    && Array.isArray(e.tags) && e.tags.every(t => Array.isArray(t) && t.every(v => typeof v === 'string'))
    && typeof e.content === 'string' && typeof e.sig === 'string' && /^[0-9a-f]{128}$/.test(e.sig);
}
function parseState(raw: ExecutionState, scope: ChildRequestScope): ExecutionState {
  if (!raw || raw.v !== 1 || raw.guardian !== scope.guardian || raw.child !== scope.child || raw.endpoint !== scope.endpoint || raw.client !== scope.client || !Array.isArray(raw.executions) || raw.executions.length > 32) throw new Error('Invalid child execution state');
  const executions = raw.executions.map(e => {
    if (!e || e.v !== 1 || !ID.test(e.requestId) || !ID.test(e.exchangeId) || !['planned', 'signed', 'cancelled'].includes(e.status) || !stamp(e.createdAt) || !stamp(e.updatedAt) || e.updatedAt < e.createdAt || (e.status === 'signed' ? !parseEvent(e.event) : e.event !== undefined)) throw new Error('Invalid child execution');
    return e;
  });
  if (new Set(executions.map(e => e.exchangeId)).size !== executions.length) throw new Error('Duplicate child execution');
  return { v: 1, guardian: scope.guardian, child: scope.child, endpoint: scope.endpoint, client: scope.client, executions };
}
export async function loadChildContactExecutions(scope: ChildRequestScope, key: string, current: () => boolean): Promise<ChildContactExecution[]> {
  scope = structuredClone(scope); validScope(scope); if (!current()) throw new Error('Child execution session changed');
  const row = await (await getDb()).get('privateVaultState', stateId(scope)); if (!row) return [];
  const state = parseState(JSON.parse(await decryptSecret(row.encrypted, key)), scope); if (!current()) throw new Error('Child execution session changed');
  return state.executions;
}

/** Persist the execution intent before asking a local or hardware signer. */
export async function executeChildContactPlan(options: {
  scope: ChildRequestScope; key: string; requestId: string; now: number; isCurrent(): boolean;
  mayConnect(peer: string): boolean | Promise<boolean>;
  sign(plan: ChildContactExchangePlan): Promise<NostrEvent>;
}): Promise<ChildContactExecution> {
  const o = { ...options, scope: structuredClone(options.scope) }; validScope(o.scope);
  if (!ID.test(o.requestId) || !stamp(o.now)) throw new Error('Invalid child execution request');
  const check = () => { if (!o.isCurrent()) throw new Error('Child execution session changed'); };
  check();
  const plan = (await loadChildContactReview(o.scope, o.key, o.isCurrent)).find(p => p.requestId === o.requestId);
  if (!plan || plan.status !== 'approved') throw new Error('Child exchange is not approved');
  if (!await o.mayConnect(plan.peer)) throw new Error('The contact policy changed');
  check();
  // Executions of settled, cancelled or evicted plans can never sign again.
  const plans = await loadChildContactReview(o.scope, o.key, o.isCurrent);
  const settled = await loadSettledChildContactPlans(o.scope, o.key, o.now, o.isCurrent);
  const finished = (e: ChildContactExecution) => e.status === 'cancelled'
    || !plans.some(p => p.exchangeId === e.exchangeId && !settled.has(p.requestId));
  check();
  let inserted = false;
  const planned = await updateEncryptedPrivateState<ExecutionState>(stateId(o.scope), o.key, previous => {
    check(); const state = parseState(previous ?? { v: 1, guardian: o.scope.guardian, child: o.scope.child, endpoint: o.scope.endpoint, client: o.scope.client, executions: [] }, o.scope);
    const old = state.executions.find(e => e.exchangeId === plan.exchangeId);
    // The callback can run again after losing CAS to another tab. Only the
    // successful reservation may authorize a signer invocation.
    inserted = false;
    if (old) return state;
    const kept = state.executions.length >= 32 ? state.executions.filter(e => !finished(e)) : state.executions;
    if (kept.length >= 32) throw new Error('Child execution queue is full');
    inserted = true;
    return { ...state, executions: [...kept, { v: 1, requestId: plan.requestId, exchangeId: plan.exchangeId, status: 'planned', createdAt: o.now, updatedAt: o.now }] };
  }, check);
  const existing = planned.executions.find(e => e.exchangeId === plan.exchangeId)!;
  if (existing.status === 'signed') return existing;
  if (!inserted) throw new Error('Child exchange signer attempt needs reconciliation');
  const event = await o.sign(plan);
  check(); if (!parseEvent(event)) throw new Error('Invalid child exchange event');
  if (!await o.mayConnect(plan.peer)) throw new Error('The contact policy changed');
  check();
  const saved = await updateEncryptedPrivateState<ExecutionState>(stateId(o.scope), o.key, previous => {
    check(); const state = parseState(previous!, o.scope); const current = state.executions.find(e => e.exchangeId === plan.exchangeId);
    if (!current || current.status === 'cancelled') throw new Error('Child exchange execution changed');
    if (current.status === 'signed') return state;
    return { ...state, executions: state.executions.map(e => e.exchangeId === plan.exchangeId ? { ...e, status: 'signed' as const, updatedAt: o.now, event } : e) };
  }, check);
  check(); return saved.executions.find(e => e.exchangeId === plan.exchangeId)!;
}

export async function cancelChildContactExecution(options: { scope: ChildRequestScope; key: string; exchangeId: string; now: number; isCurrent(): boolean }): Promise<ChildContactExecution> {
  const o = { ...options, scope: structuredClone(options.scope) }; validScope(o.scope); if (!ID.test(o.exchangeId) || !stamp(o.now)) throw new Error('Invalid child execution cancellation');
  const check = () => { if (!o.isCurrent()) throw new Error('Child execution session changed'); };
  const saved = await updateEncryptedPrivateState<ExecutionState>(stateId(o.scope), o.key, previous => {
    check(); const state = parseState(previous ?? { v: 1, guardian: o.scope.guardian, child: o.scope.child, endpoint: o.scope.endpoint, client: o.scope.client, executions: [] }, o.scope);
    return { ...state, executions: state.executions.map(e => e.exchangeId === o.exchangeId && e.status === 'planned' ? { ...e, status: 'cancelled' as const, updatedAt: o.now } : e) };
  }, check);
  check(); const result = saved.executions.find(e => e.exchangeId === o.exchangeId); if (!result) throw new Error('Child execution not found'); return result;
}
