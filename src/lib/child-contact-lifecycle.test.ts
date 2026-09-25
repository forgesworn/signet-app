import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from 'signet-protocol';
import { LocalSigningBackend } from './signing-backend';
import { purgeAllUserData } from './db';
import { updateEncryptedPrivateState } from './private-vault-store';
import { loadChildContactInbox, openChildContactRequest, sealChildContactRequest, storeChildContactRequest, transitionChildContactReceipt,
  type ChildContactRequest, type ChildRequestReceipt, type ChildRequestScope } from './child-contact-requests';
import { loadChildContactReview, type ChildContactExchangePlan } from './child-contact-review';
import { executeChildContactPlan, loadChildContactExecutions } from './child-contact-execution';
import { deliverPendingChildContactReplies, loadChildContactReplyOutbox } from './child-contact-reply-delivery';
import { loadChildContactOutbox, openChildContactReply, type ChildContactReply, type ChildContactReplyStatus } from './child-contact-exchange';
import { CHILD_EXCHANGE_ABANDON_AFTER, childExchangeAuthority, cancelChildContactRequest, childContactRequestHistory, decideChildContactRequest, guardianChildContactHistory,
  loadChildContactLifecycle, reconcileChildContactReplies, sendChildContactReply, submitChildContactRequest } from './child-contact-lifecycle';

const child = new LocalSigningBackend('05'.repeat(32)), endpoint = new LocalSigningBackend('04'.repeat(32));
const scope: ChildRequestScope = { guardian: '1'.repeat(64), child: '2'.repeat(64), endpoint: endpoint.activePublicKeyHex, client: child.activePublicKeyHex, personas: ['3'.repeat(64)] };
const now = 1800000000, key = 'child-lifecycle-test', current = () => true, id = 'a'.repeat(32);
const request = (): ChildContactRequest => ({ v: 1, id, guardian: scope.guardian, endpoint: scope.endpoint, client: scope.client,
  persona: scope.personas[0], revision: 1, createdAt: now, expiresAt: now + 600,
  invite: { v: 1, recipient: '6'.repeat(64), secret: '7'.repeat(64), relays: ['wss://invite.example/'] } });
async function receive() {
  const opened = (await openChildContactRequest(await sealChildContactRequest(request(), child), { scope, endpoint, now, isCurrent: current }))!;
  await storeChildContactRequest({ scope, key, request: opened.request, fingerprint: 'f'.repeat(64), now, isCurrent: current });
}
const status = async (at = now + 1) => (await loadChildContactInbox(scope, key, at, current)).find(r => r.id === id)?.status;
const transport = (publish = vi.fn(async (_event: NostrEvent, _relays: string[]) => true), mayDeliver = vi.fn(async () => true)) =>
  ({ transport: endpoint, relays: ['wss://relay.example'], publish, mayDeliver });
const decide = (decision: 'approve' | 'deny', extra: Partial<Parameters<typeof decideChildContactRequest>[0]> = {}) =>
  decideChildContactRequest({ scope, key, requestId: id, fingerprint: 'f'.repeat(64), decision, now: () => now + 1, isCurrent: current,
    mayConnect: () => true, execute: vi.fn(async () => {}), abandon: vi.fn(async () => {}), reply: vi.fn(async () => {}), ...extra });
async function stuckPlan(): Promise<ChildContactExchangePlan> {
  await receive();
  let plan!: ChildContactExchangePlan;
  // The signer attempt is reserved but its result is never recorded.
  await expect(decide('approve', { execute: async p => { plan = p;
    await executeChildContactPlan({ scope, key, requestId: id, now: now + 1, isCurrent: current, mayConnect: () => true,
      sign: async () => { throw new Error('Signer went away'); } }); } })).rejects.toThrow('Signer went away');
  return plan;
}
beforeEach(async () => { vi.restoreAllMocks(); await purgeAllUserData(); });

it('denies in order: plan persisted, receipt swapped, then the reply queued; it never returns to pending', async () => {
  await receive();
  const order: string[] = [];
  const reply = vi.fn(async (plan: ChildContactExchangePlan, replyStatus: string) => {
    order.push(`reply:${replyStatus}`);
    expect((await loadChildContactReview(scope, key, current))[0]).toMatchObject({ requestId: plan.requestId, status: 'denied' });
    expect(await status()).toBe('denied');
  });
  const execute = vi.fn(async () => {});
  await decide('deny', { reply, execute, mayConnect: () => { throw new Error('Denial must not check contact policy'); } });
  expect(order).toEqual(['reply:denied']); expect(execute).not.toHaveBeenCalled();
  expect(await status(now + 2)).toBe('denied');
  await storeChildContactRequest({ scope, key, request: request(), fingerprint: 'f'.repeat(64), now: now + 3, isCurrent: current });
  expect(await status(now + 3)).toBe('denied');
  await expect(decide('deny')).rejects.toThrow('no longer reviewable');
});

it('approves in order: plan, execution while still pending, receipt swapped, then the pending reply', async () => {
  await receive();
  const order: string[] = [];
  await decide('approve', {
    execute: async () => { order.push('execute'); expect(await loadChildContactReview(scope, key, current)).toHaveLength(1); expect(await status()).toBe('pending'); },
    reply: async (_plan, replyStatus) => { order.push(`reply:${replyStatus}`); expect(await status()).toBe('approved'); },
  });
  expect(order).toEqual(['execute', 'reply:pending']);
  expect((await loadChildContactLifecycle(scope, key, now + 2, current)).receipts[0].status).toBe('approved');
});

it('withdraws a signed exchange when the receipt expired while the signer waited', async () => {
  await receive();
  const abandon = vi.fn(async () => {}), reply = vi.fn(async () => {});
  let clock = now + 1;
  await expect(decide('approve', { now: () => clock, execute: async () => { clock = now + 700; }, abandon, reply })).rejects.toThrow('already expired');
  expect(abandon).toHaveBeenCalledTimes(1); expect(reply).not.toHaveBeenCalled();
  expect((await loadChildContactReview(scope, key, current))[0].status).toBe('cancelled');
});

it('signs a denial with the transport key into the durable outbox and retries a relay failure without re-signing', async () => {
  await receive();
  const sign = vi.spyOn(endpoint, 'signEvent');
  const publish = vi.fn(async (_event: NostrEvent, _relays: string[]) => false);
  await decide('deny', { reply: (plan, s) => sendChildContactReply({ scope, key, plan, status: s, now: now + 2, isCurrent: current, ...transport(publish) }).then(() => {}) });
  expect(sign).toHaveBeenCalledTimes(1);
  const [entry] = await loadChildContactReplyOutbox(scope, key, current);
  expect(entry.event.pubkey).toBe(endpoint.activePublicKeyHex);
  expect(entry.reply?.status).toBe('denied'); expect(entry.acknowledgedAt).toBeUndefined();
  const opened = await openChildContactReply(entry.event, { scope, client: child, now: now + 3, isCurrent: current });
  expect(opened?.reply).toMatchObject({ requestId: id, status: 'denied' });
  publish.mockResolvedValue(true);
  expect(await deliverPendingChildContactReplies({ scope, key, now: now + 4, isCurrent: current, mayDeliver: () => true, publish })).toBe(1);
  expect(sign).toHaveBeenCalledTimes(1);
  expect(publish.mock.calls.map(call => call[0].id)).toEqual([entry.event.id, entry.event.id]);
  expect((await loadChildContactReplyOutbox(scope, key, current))[0].acknowledgedAt).toBe(now + 4);
});

it('withholds a denial when the pairing no longer covers the request, before signing', async () => {
  await receive();
  const sign = vi.spyOn(endpoint, 'signEvent');
  const publish = vi.fn(async () => true);
  await decide('deny', { reply: (plan, s) => sendChildContactReply({ scope, key, plan, status: s, now: now + 2, isCurrent: current,
    ...transport(publish, vi.fn(async () => false)) }).then(() => {}) });
  expect(sign).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
  expect(await loadChildContactReplyOutbox(scope, key, current)).toEqual([]);
  expect(await status()).toBe('denied');
});

it('keeps a queued reply pending when the pairing goes away between queueing and publication', async () => {
  await receive();
  let live = true;
  const publish = vi.fn(async () => true);
  await decide('deny', { reply: (plan, s) => sendChildContactReply({ scope, key, plan, status: s, now: now + 2, isCurrent: current,
    ...transport(publish, vi.fn(async () => { const was = live; live = false; return was; })) }).then(() => {}) });
  expect(publish).not.toHaveBeenCalled();
  expect((await loadChildContactReplyOutbox(scope, key, current))[0].acknowledgedAt).toBeUndefined();
});

it('shows a stuck signer attempt and cancels it to expired with an expired reply', async () => {
  const plan = await stuckPlan();
  expect(await status()).toBe('pending');
  expect((await loadChildContactLifecycle(scope, key, now + 2, current)).stuck.map(p => p.requestId)).toEqual([id]);
  const cancelExchange = vi.fn(async () => {});
  const publish = vi.fn(async () => true);
  await cancelChildContactRequest({ scope, key, requestId: id, now: now + 3, isCurrent: current, cancelExchange, reply: transport(publish) });
  expect(cancelExchange).toHaveBeenCalledWith(expect.objectContaining({ exchangeId: plan.exchangeId }));
  expect(await status(now + 4)).toBe('expired');
  expect((await loadChildContactReview(scope, key, current))[0].status).toBe('cancelled');
  expect((await loadChildContactExecutions(scope, key, current))[0].status).toBe('cancelled');
  const [entry] = await loadChildContactReplyOutbox(scope, key, current);
  expect(entry.reply?.status).toBe('expired'); expect(entry.acknowledgedAt).toBe(now + 3);
  expect((await loadChildContactLifecycle(scope, key, now + 5, current)).stuck).toEqual([]);
  // Idempotent: a second cancel sends nothing more.
  await cancelChildContactRequest({ scope, key, requestId: id, now: now + 6, isCurrent: current, cancelExchange, reply: transport(publish) });
  expect(publish).toHaveBeenCalledTimes(1);
});

it('treats an outbox reply without transition metadata as stuck and lets Cancel replace it', async () => {
  await receive();
  let approved!: ChildContactExchangePlan;
  await decide('approve', { execute: async plan => { approved = plan;
    await executeChildContactPlan({ scope, key, requestId: id, now: now + 1, isCurrent: current, mayConnect: () => true,
      sign: () => endpoint.signEvent({ pubkey: endpoint.activePublicKeyHex, kind: 30078, created_at: now, tags: [], content: 'signed' }) }); },
    reply: (plan, s) => sendChildContactReply({ scope, key, plan, status: s, now: now + 2, isCurrent: current, ...transport() }).then(() => {}) });
  const rowId = `child-contact-reply-outbox:${scope.guardian}:${scope.child}:${scope.endpoint}:${scope.client}`;
  await updateEncryptedPrivateState<{ entries: Array<{ reply?: unknown }> }>(rowId, key, state => ({ ...state!, entries: state!.entries.map(({ reply: _r, ...e }) => e) }));
  expect((await loadChildContactLifecycle(scope, key, now + 3, current)).stuck.map(p => p.exchangeId)).toEqual([approved.exchangeId]);
  await cancelChildContactRequest({ scope, key, requestId: id, now: now + 4, isCurrent: current, reply: transport() });
  expect(await status(now + 5)).toBe('expired');
  expect((await loadChildContactReplyOutbox(scope, key, current))[0].reply?.status).toBe('expired');
});

it('cancels on re-pair without any reply', async () => {
  await stuckPlan();
  await cancelChildContactRequest({ scope, key, requestId: id, now: now + 3, isCurrent: current });
  expect(await status(now + 4)).toBe('expired');
  expect((await loadChildContactReview(scope, key, current))[0].status).toBe('cancelled');
  expect(await loadChildContactReplyOutbox(scope, key, current)).toEqual([]);
});

it('keeps a completed result when a late cancellation arrives', async () => {
  await receive();
  await decide('approve');
  await transitionChildContactReceipt({ scope, key, requestId: id, from: ['approved'], to: 'completed', now: now + 2, isCurrent: current });
  await cancelChildContactRequest({ scope, key, requestId: id, now: now + 3, isCurrent: current });
  expect(await status(now + 4)).toBe('completed');
});

async function receiveAt(requestId: string, at: number) {
  const r = { ...request(), id: requestId, createdAt: at, expiresAt: at + 600 };
  const opened = (await openChildContactRequest(await sealChildContactRequest(r, child), { scope, endpoint, now: at, isCurrent: current }))!;
  await storeChildContactRequest({ scope, key, request: opened.request, fingerprint: 'f'.repeat(64), now: at, isCurrent: current });
}
const signed = () => endpoint.signEvent({ pubkey: endpoint.activePublicKeyHex, kind: 30078, created_at: now, tags: [], content: 'signed' });
const approveAndExecute = (requestId: string, at: number) => decideChildContactRequest({ scope, key, requestId, fingerprint: 'f'.repeat(64), decision: 'approve',
  now: () => at, isCurrent: current, mayConnect: () => true, abandon: vi.fn(async () => {}), reply: vi.fn(async () => {}),
  execute: async () => { await executeChildContactPlan({ scope, key, requestId, now: at, isCurrent: current, mayConnect: () => true, sign: signed }); } });

it('accepts a 33rd approval once earlier exchanges have completed', async () => {
  for (let i = 0; i < 32; i++) {
    const requestId = i.toString(16).padStart(32, '0');
    await receiveAt(requestId, now); await approveAndExecute(requestId, now);
  }
  await receiveAt('e'.repeat(32), now);
  await expect(approveAndExecute('e'.repeat(32), now)).rejects.toThrow('full');
  for (let i = 0; i < 32; i++) await transitionChildContactReceipt({ scope, key, requestId: i.toString(16).padStart(32, '0'), from: ['approved'], to: 'completed', now: now + 1, isCurrent: current });
  const later = now + 2000;
  await receiveAt('d'.repeat(32), later);
  await approveAndExecute('d'.repeat(32), later);
  expect((await loadChildContactExecutions(scope, key, current)).some(e => e.status === 'signed' && e.requestId === 'd'.repeat(32))).toBe(true);
  expect((await loadChildContactInbox(scope, key, later, current)).find(r => r.id === 'd'.repeat(32))?.status).toBe('approved');
}, 180000);

describe('reply reconciliation after a crash between receipt swap and reply', () => {
  const reconcile = (at: number, publish = vi.fn(async (_e: NostrEvent, _r: string[]) => true), live = true, contactId?: string) =>
    reconcileChildContactReplies({ scope, key, now: at, isCurrent: current, transport: async () => live ? transport(publish) : null,
      completedContactId: async () => contactId });
  it('queues a missing denial once and never duplicates it', async () => {
    await receive(); await decide('deny');
    expect(await loadChildContactReplyOutbox(scope, key, current)).toEqual([]);
    const publish = vi.fn(async (_e: NostrEvent, _r: string[]) => true);
    expect(await reconcile(now + 2, publish)).toBe(1);
    const [entry] = await loadChildContactReplyOutbox(scope, key, current);
    expect(entry.reply?.status).toBe('denied'); expect(entry.acknowledgedAt).toBe(now + 2);
    expect(await reconcile(now + 3, publish)).toBe(0);
    expect(publish).toHaveBeenCalledTimes(1);
  });
  it('does not duplicate a queued but undelivered reply', async () => {
    await receive();
    await decide('deny', { reply: (plan, s) => sendChildContactReply({ scope, key, plan, status: s, now: now + 2, isCurrent: current, ...transport(vi.fn(async () => false)) }).then(() => {}) });
    expect(await reconcile(now + 3)).toBe(0);
    expect(await loadChildContactReplyOutbox(scope, key, current)).toHaveLength(1);
  });
  it('withholds while the pairing is not live and outside the reply window', async () => {
    await receive(); await decide('deny');
    expect(await reconcile(now + 2, undefined, false)).toBe(0);
    expect(await reconcile(now + 1 + 600)).toBe(0);
    expect(await loadChildContactReplyOutbox(scope, key, current)).toEqual([]);
  });
  it('advances an acknowledged pending reply to the completed one the receipt calls for', async () => {
    await receive();
    await decide('approve', { reply: (plan, s) => sendChildContactReply({ scope, key, plan, status: s, now: now + 2, isCurrent: current, ...transport() }).then(() => {}) });
    await transitionChildContactReceipt({ scope, key, requestId: id, from: ['approved'], to: 'completed', now: now + 5, isCurrent: current });
    expect(await reconcile(now + 6, undefined, true, 'c'.repeat(32))).toBe(1);
    const [entry] = await loadChildContactReplyOutbox(scope, key, current);
    expect(entry.reply).toMatchObject({ status: 'completed', contactId: 'c'.repeat(32) });
  });
  it('queues the expired reply for a cancel that stopped before sending it', async () => {
    await stuckPlan();
    await cancelChildContactRequest({ scope, key, requestId: id, now: now + 3, isCurrent: current });
    expect(await reconcile(now + 4)).toBe(1);
    expect((await loadChildContactReplyOutbox(scope, key, current))[0].reply?.status).toBe('expired');
  });
});

describe('D6 — child submission', () => {
  const invite = { v: 1 as const, recipient: '6'.repeat(64), secret: '7'.repeat(64), relays: ['wss://invite.example/'] };

  it('rejects a persona outside the request scope — never the dormant real identity', async () => {
    const publish = vi.fn(async () => true);
    await expect(submitChildContactRequest({ scope, key, persona: '9'.repeat(64), invite, now, isCurrent: current,
      transport: child, relays: ['wss://relay.example'], publish })).rejects.toThrow('not available to ask with');
    expect(publish).not.toHaveBeenCalled();
  });

  it('queues, seals, attaches and publishes a fresh request the guardian can receive', async () => {
    const publish = vi.fn(async (_event: NostrEvent, _relays: string[]) => true);
    const result = await submitChildContactRequest({ scope, key, persona: scope.personas[0], invite, now, isCurrent: current,
      transport: child, relays: ['wss://relay.example'], publish });
    expect(result.published).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    const [entry] = await loadChildContactOutbox(scope, key, current);
    expect(entry.request.persona).toBe(scope.personas[0]);
    expect(entry.request.invite).toEqual(invite);
    expect(entry.event?.pubkey).toBe(scope.client);
    const opened = await openChildContactRequest(entry.event!, { scope, endpoint, now, isCurrent: current });
    expect(opened?.request.id).toBe(result.requestId);
  });

  it('surfaces queue overflow instead of silently dropping the ask', async () => {
    for (let i = 0; i < 32; i++) {
      await submitChildContactRequest({ scope, key, persona: scope.personas[0],
        invite: { ...invite, recipient: i.toString(16).padStart(64, '0') }, now: now + i, isCurrent: current,
        transport: child, relays: [], publish: async () => true });
    }
    await expect(submitChildContactRequest({ scope, key, persona: scope.personas[0], invite, now: now + 100, isCurrent: current,
      transport: child, relays: [], publish: async () => true })).rejects.toThrow('Child request outbox is full');
  }, 30000);
});

describe('D4 — read-only history caps and status labels', () => {
  const receiptAt = (rid: string, status: ChildRequestReceipt['status'], updatedAt: number): ChildRequestReceipt =>
    ({ id: rid, fingerprint: 'f'.repeat(64), revision: 1, status, updatedAt });

  it('caps guardian history at the 10 most recently updated terminal receipts and excludes pending', () => {
    const receipts: ChildRequestReceipt[] = [
      receiptAt('p'.repeat(32), 'pending', 1000),
      ...Array.from({ length: 15 }, (_, i) => receiptAt(i.toString(16).padStart(32, '0'), 'denied', i)),
    ];
    const history = guardianChildContactHistory(receipts);
    expect(history).toHaveLength(10);
    expect(history.every(r => r.status !== 'pending')).toBe(true);
    expect(history[0].updatedAt).toBe(14);
    expect(history[9].updatedAt).toBe(5);
  });

  const outboxEntry = (rid: string, createdAt: number) => ({
    request: { v: 1 as const, id: rid, guardian: scope.guardian, endpoint: scope.endpoint, client: scope.client,
      persona: scope.personas[0], revision: 1, createdAt, expiresAt: createdAt + 600,
      invite: { v: 1 as const, recipient: '6'.repeat(64), secret: '7'.repeat(64), relays: ['wss://invite.example/'] } },
    createdAt,
  });

  it('caps child history at the 20 most recently updated requests and labels a fresh ask as waiting', () => {
    const outbox = Array.from({ length: 25 }, (_, i) => outboxEntry(i.toString(16).padStart(32, '0'), i));
    const history = childContactRequestHistory(outbox, []);
    expect(history).toHaveLength(20);
    expect(history[0].status).toBe('waiting');
    expect(history[0].updatedAt).toBe(24);
  });

  it('distinguishes an in-progress approval (approved) from a finished exchange (added)', () => {
    const outbox = [outboxEntry('a'.repeat(32), 1)];
    const reply = (status: ChildContactReplyStatus): ChildContactReply => ({ v: 1, requestId: 'a'.repeat(32), guardian: scope.guardian,
      endpoint: scope.endpoint, client: scope.client, persona: scope.personas[0], revision: 1, createdAt: 2, expiresAt: 602, status,
      ...(status === 'completed' ? { exchangeId: 'e'.repeat(32) } : {}) });
    expect(childContactRequestHistory(outbox, [{ reply: reply('pending') }])[0].status).toBe('approved');
    expect(childContactRequestHistory(outbox, [{ reply: reply('completed') }])[0].status).toBe('added');
    expect(childContactRequestHistory(outbox, [{ reply: reply('denied') }])[0].status).toBe('declined');
    expect(childContactRequestHistory(outbox, [{ reply: reply('expired') }])[0].status).toBe('expired');
    expect(childContactRequestHistory(outbox, [{ reply: reply('conflict') }])[0].status).toBe('conflict');
  });
});

describe('approvals whose exchange never completes (review findings 1 and 2)', () => {
  it('lets an exchange proceed only once its receipt is approved', async () => {
    await receive();
    let exchangeId = '';
    const gate = () => childExchangeAuthority({ scope, key, exchangeId, now: now + 1, isCurrent: current });
    await decide('approve', { execute: async plan => { exchangeId = plan.exchangeId; expect(await gate()).toBe('wait'); } });
    expect(await gate()).toBe('go');
    await transitionChildContactReceipt({ scope, key, requestId: id, from: ['approved'], to: 'completed', now: now + 2, isCurrent: current });
    expect(await gate()).toBe('go');
    expect(await childExchangeAuthority({ scope, key, exchangeId: 'f'.repeat(32), now: now + 3, isCurrent: current })).toBe('withdraw');
  });
  it('withdraws when the receipt expired during a signer wait', async () => {
    await receive();
    let exchangeId = '';
    await expect(decide('approve', { now: () => now + 700, execute: async plan => { exchangeId = plan.exchangeId; } })).rejects.toThrow();
    expect(await childExchangeAuthority({ scope, key, exchangeId, now: now + 701, isCurrent: current })).toBe('withdraw');
  });
  it('sweeps 32 unanswered approvals to expired so a new request can be reviewed', async () => {
    for (let i = 0; i < 32; i++) {
      const requestId = i.toString(16).padStart(32, '0');
      await receiveAt(requestId, now);
      await decideChildContactRequest({ scope, key, requestId, fingerprint: 'f'.repeat(64), decision: 'approve', now: () => now, isCurrent: current,
        mayConnect: () => true, execute: vi.fn(async () => {}), abandon: vi.fn(async () => {}), reply: vi.fn(async () => {}) });
    }
    const later = now + 600 + CHILD_EXCHANGE_ABANDON_AFTER;
    await receiveAt('e'.repeat(32), later);
    const review = () => decide('deny', { requestId: 'e'.repeat(32), now: () => later });
    await expect(review()).rejects.toThrow('full');
    expect((await loadChildContactLifecycle(scope, key, later - 1, current)).abandoned).toEqual([]);
    const { abandoned } = await loadChildContactLifecycle(scope, key, later, current);
    expect(abandoned).toHaveLength(32);
    const publish = vi.fn(async (_e: NostrEvent, _r: string[]) => true);
    for (const plan of abandoned) await cancelChildContactRequest({ scope, key, requestId: plan.requestId, now: later, isCurrent: current, reply: transport(publish) });
    expect(publish).toHaveBeenCalledTimes(32);
    expect((await loadChildContactReplyOutbox(scope, key, current)).every(e => e.reply?.status === 'expired')).toBe(true);
    await review();
    expect((await loadChildContactInbox(scope, key, later, current)).find(r => r.id === 'e'.repeat(32))?.status).toBe('denied');
  }, 240000);
});
