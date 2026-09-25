import { beforeEach, expect, it, vi } from 'vitest';
import { LocalSigningBackend } from './signing-backend';
import { purgeAllUserData } from './db';
import { openChildContactRequest, sealChildContactRequest, storeChildContactRequest, type ChildContactRequest, type ChildRequestScope } from './child-contact-requests';
import { reviewChildContactRequest } from './child-contact-review';
import { executeChildContactPlan, loadChildContactExecutions } from './child-contact-execution';
import * as privateState from './private-vault-store';

const child = new LocalSigningBackend('05'.repeat(32)), endpoint = new LocalSigningBackend('04'.repeat(32));
const scope: ChildRequestScope = { guardian: '1'.repeat(64), child: '2'.repeat(64), endpoint: endpoint.activePublicKeyHex, client: child.activePublicKeyHex, personas: ['3'.repeat(64)] };
const now = 1800000000, key = 'child-execution-test', current = () => true;
const request = (): ChildContactRequest => ({ v: 1, id: 'a'.repeat(32), guardian: scope.guardian, endpoint: scope.endpoint, client: scope.client, persona: scope.personas[0], revision: 1, createdAt: now, expiresAt: now + 600,
  invite: { v: 1, recipient: '6'.repeat(64), secret: '7'.repeat(64), relays: ['wss://invite.example/'] } });
async function approved() {
  const r = request(); const opened = (await openChildContactRequest(await sealChildContactRequest(r, child), { scope, endpoint, now, isCurrent: current }))!;
  await storeChildContactRequest({ scope, key, request: opened.request, fingerprint: 'f'.repeat(64), now, isCurrent: current });
  return reviewChildContactRequest({ scope, key, requestId: r.id, fingerprint: 'f'.repeat(64), decision: 'approve', now, isCurrent: current, mayConnect: () => true });
}
beforeEach(async () => { vi.restoreAllMocks(); await purgeAllUserData(); });

it('does not sign after losing reservation CAS to another tab', async () => {
  const plan = await approved();
  vi.spyOn(privateState, 'updateEncryptedPrivateState').mockImplementationOnce(async (_id, _key, change) => {
    await change(undefined); // This attempt loses the transaction race.
    return change({ v: 1, ...scope, executions: [{ v: 1, requestId: plan.requestId, exchangeId: plan.exchangeId,
      status: 'planned', createdAt: now, updatedAt: now }] });
  });
  const sign = vi.fn();
  await expect(executeChildContactPlan({ scope, key, requestId: plan.requestId, now, isCurrent: current, mayConnect: () => true, sign })).rejects.toThrow('reconciliation');
  expect(sign).not.toHaveBeenCalled();
});

it('persists intent before signing and reuses the signed result on retry', async () => {
  const plan = await approved(); const signer = vi.fn(async () => endpoint.signEvent({ pubkey: endpoint.activePublicKeyHex, kind: 30078, created_at: now, tags: [], content: 'signed' }));
  const first = await executeChildContactPlan({ scope, key, requestId: plan.requestId, now, isCurrent: current, mayConnect: () => true, sign: signer });
  const second = await executeChildContactPlan({ scope, key, requestId: plan.requestId, now: now + 1, isCurrent: current, mayConnect: () => true, sign: signer });
  expect(first.status).toBe('signed'); expect(second.event?.id).toBe(first.event?.id); expect(signer).toHaveBeenCalledTimes(1);
});

it('leaves a planned intent when policy changes after signing and refuses a second prompt', async () => {
  const plan = await approved(); let retracted = false; const signer = vi.fn(async () => { retracted = true; return endpoint.signEvent({ pubkey: endpoint.activePublicKeyHex, kind: 30078, created_at: now, tags: [], content: 'signed' }); });
  const mayConnect = () => !retracted;
  await expect(executeChildContactPlan({ scope, key, requestId: plan.requestId, now, isCurrent: current, mayConnect, sign: signer })).rejects.toThrow('policy');
  expect((await loadChildContactExecutions(scope, key, current))[0].status).toBe('planned');
  retracted = false;
  await expect(executeChildContactPlan({ scope, key, requestId: plan.requestId, now: now + 1, isCurrent: current, mayConnect, sign: signer })).rejects.toThrow('reconciliation');
  expect(signer).toHaveBeenCalledTimes(1);
});

it('does not attach a result after lock during signing', async () => {
  const plan = await approved(); let active = true;
  await expect(executeChildContactPlan({ scope, key, requestId: plan.requestId, now, isCurrent: () => active, mayConnect: () => true,
    sign: async () => { active = false; return endpoint.signEvent({ pubkey: endpoint.activePublicKeyHex, kind: 30078, created_at: now, tags: [], content: 'signed' }); } })).rejects.toThrow('session');
  expect((await loadChildContactExecutions(scope, key, () => true))[0].status).toBe('planned');
});
