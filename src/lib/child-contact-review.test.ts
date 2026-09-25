import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { updateEncryptedPrivateState } from './private-vault-store';
import { LocalSigningBackend } from './signing-backend';
import { purgeAllUserData } from './db';
import { openChildContactRequest, sealChildContactRequest, storeChildContactRequest, transitionChildContactReceipt, type ChildContactRequest, type ChildRequestScope } from './child-contact-requests';
import { cancelChildContactExchange, childContactPlanSettled, loadChildContactReview, reviewChildContactRequest, type ChildContactExchangePlan } from './child-contact-review';

const child = new LocalSigningBackend('05'.repeat(32)), endpoint = new LocalSigningBackend('04'.repeat(32));
const scope: ChildRequestScope = { guardian: '1'.repeat(64), child: '2'.repeat(64), endpoint: endpoint.activePublicKeyHex, client: child.activePublicKeyHex, personas: ['3'.repeat(64)] };
const now = 1800000000, key = 'child-review-test', current = () => true;
const request = (id = 'a'.repeat(32)): ChildContactRequest => ({ v: 1, id, guardian: scope.guardian, endpoint: scope.endpoint, client: scope.client,
  persona: scope.personas[0], revision: 1, createdAt: now, expiresAt: now + 600,
  invite: { v: 1, recipient: '6'.repeat(64), secret: '7'.repeat(64), relays: ['wss://invite.example/'] } });
async function receive(r: ChildContactRequest, fingerprint = 'f'.repeat(64)) {
  const opened = (await openChildContactRequest(await sealChildContactRequest(r, child), { scope, endpoint, now, isCurrent: current }))!;
  return storeChildContactRequest({ scope, key, request: opened.request, fingerprint, now, isCurrent: current });
}

beforeEach(async () => { vi.restoreAllMocks(); await purgeAllUserData(); });

it('persists one approval as one stable exchange plan and resumes it idempotently', async () => {
  const r = request(); await receive(r);
  const mayConnect = vi.fn(async () => true);
  const first = await reviewChildContactRequest({ scope, key, requestId: r.id, fingerprint: 'f'.repeat(64), decision: 'approve', now, isCurrent: current, mayConnect });
  const second = await reviewChildContactRequest({ scope, key, requestId: r.id, fingerprint: 'f'.repeat(64), decision: 'approve', now: now + 1, isCurrent: current, mayConnect });
  expect(second.exchangeId).toBe(first.exchangeId);
  expect((await loadChildContactReview(scope, key, current))).toHaveLength(1);
  expect(mayConnect).toHaveBeenCalledTimes(2);
  await expect(reviewChildContactRequest({ scope, key, requestId: r.id, fingerprint: 'e'.repeat(64), decision: 'approve', now, isCurrent: current, mayConnect })).rejects.toThrow('review');
});

it('requires fresh policy before approval and keeps denial terminal', async () => {
  const r = request(); await receive(r);
  await expect(reviewChildContactRequest({ scope, key, requestId: r.id, fingerprint: 'f'.repeat(64), decision: 'approve', now, isCurrent: current, mayConnect: () => false })).rejects.toThrow('policy');
  const denied = await reviewChildContactRequest({ scope, key, requestId: r.id, fingerprint: 'f'.repeat(64), decision: 'deny', now, isCurrent: current, mayConnect: () => false });
  expect(denied.status).toBe('denied');
  await expect(reviewChildContactRequest({ scope, key, requestId: r.id, fingerprint: 'f'.repeat(64), decision: 'approve', now, isCurrent: current, mayConnect: () => true })).rejects.toThrow('reviewed');
});

it('cancels a stable plan and refuses a stale session', async () => {
  const r = request(); await receive(r);
  await reviewChildContactRequest({ scope, key, requestId: r.id, fingerprint: 'f'.repeat(64), decision: 'approve', now, isCurrent: current, mayConnect: () => true });
  const cancelled = await cancelChildContactExchange({ scope, key, requestId: r.id, now: now + 2, isCurrent: current });
  expect(cancelled.status).toBe('cancelled');
  let active = true;
  await expect(cancelChildContactExchange({ scope, key, requestId: r.id, now: now + 3, isCurrent: () => active })).resolves.toMatchObject({ status: 'cancelled' });
  active = false;
  await expect(loadChildContactReview(scope, key, () => active)).rejects.toThrow('session changed');
});

describe('compaction of settled plans', () => {
  const exchangeIdFor = (requestId: string) => bytesToHex(sha256(new TextEncoder().encode(`child-contact-exchange:v1:${scope.guardian}:${scope.child}:${requestId}`))).slice(0, 32);
  const stateId = `child-contact-review:${scope.guardian}:${scope.child}:${scope.endpoint}:${scope.client}`;
  it('counts only unsettled plans toward the live cap', async () => {
    for (let i = 0; i < 32; i++) {
      const r = request(i.toString(16).padStart(32, '0')); await receive(r);
      await reviewChildContactRequest({ scope, key, requestId: r.id, fingerprint: 'f'.repeat(64), decision: 'deny', now, isCurrent: current, mayConnect: () => true });
      await transitionChildContactReceipt({ scope, key, requestId: r.id, from: ['pending'], to: 'denied', now, isCurrent: current });
    }
    // Denied, but its reply is neither delivered nor expired: still live.
    const r = request('e'.repeat(32)); await receive(r);
    await expect(reviewChildContactRequest({ scope, key, requestId: r.id, fingerprint: 'f'.repeat(64), decision: 'deny', now, isCurrent: current, mayConnect: () => true })).rejects.toThrow('full');
    expect(childContactPlanSettled((await loadChildContactReview(scope, key, current))[0], { id: 'x', fingerprint: 'f'.repeat(64), revision: 1, status: 'pending', updatedAt: now }, undefined, now + 9999)).toBe(false);
  }, 120000);
  it('evicts the oldest settled plan at the retention bound and never an unsettled one', async () => {
    const live = request('d'.repeat(32)); await receive(live);
    await reviewChildContactRequest({ scope, key, requestId: live.id, fingerprint: 'f'.repeat(64), decision: 'approve', now, isCurrent: current, mayConnect: () => true });
    await updateEncryptedPrivateState<{ plans: ChildContactExchangePlan[] }>(stateId, key, state => {
      const [approved] = state!.plans;
      const settled = Array.from({ length: 1023 }, (_, i) => {
        const requestId = (i + 1).toString(16).padStart(32, '0');
        return { ...approved, requestId, exchangeId: exchangeIdFor(requestId), status: 'denied' as const, createdAt: now + 1 + i, updatedAt: now + 1 + i, request: { ...approved.request, id: requestId } };
      });
      return { ...state!, plans: [{ ...approved, updatedAt: now }, ...settled] };
    });
    const later = now + 2000;
    const next = { ...request('c'.repeat(32)), createdAt: later, expiresAt: later + 600 };
    const opened = (await openChildContactRequest(await sealChildContactRequest(next, child), { scope, endpoint, now: later, isCurrent: current }))!;
    await storeChildContactRequest({ scope, key, request: opened.request, fingerprint: 'f'.repeat(64), now: later, isCurrent: current });
    await reviewChildContactRequest({ scope, key, requestId: next.id, fingerprint: 'f'.repeat(64), decision: 'deny', now: now + 2000, isCurrent: current, mayConnect: () => true });
    const plans = await loadChildContactReview(scope, key, current);
    expect(plans).toHaveLength(1024);
    expect(plans.some(p => p.requestId === live.id)).toBe(true);
    expect(plans.some(p => p.requestId === (1).toString(16).padStart(32, '0'))).toBe(false);
    expect(plans.some(p => p.requestId === next.id)).toBe(true);
  }, 120000);
});
