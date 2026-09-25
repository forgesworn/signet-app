import { contactExchangeKey } from './contact-exchange-key';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';
import { ContactIdentityDecryptBudget, contactVerificationWords } from '@forgesworn/signet-contacts';
import { openContactMailboxWrap } from '@forgesworn/signet-contacts/adapters/invite-nostr-tools';
import { ContactInviteService } from './contact-invite-service';
import { recordContactArrival, updateContactInviteVault } from './contact-invite-store';
import { purgeAllUserData } from './db';
const publish = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./sync-relays', () => ({ publishToRelays: publish }));
const KEY = 'test exchange unlock';
function party(secret: string, directoryId: string, extra: Partial<ConstructorParameters<typeof ContactInviteService>[0]> = {}) {
  const sk = hexToBytes(secret), pubkey = getPublicKey(sk);
  const signer = { publicKey: pubkey, signEvent: vi.fn(async (event: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(event, sk)),
    decrypt: vi.fn(async (sender: string, ct: string) => nip44.v2.decrypt(ct, nip44.v2.utils.getConversationKey(sk, sender))) };
  const service = new ContactInviteService({ directoryId, encryptionKey: KEY, budget: new ContactIdentityDecryptBudget(),
    signer: async key => { if (key !== pubkey) throw new Error('Wrong identity'); return signer; },
    isCurrent: () => true, onChanged: vi.fn(), mayConnect: () => true, ...extra });
  return { pubkey, service, signer, directoryId };
}
beforeEach(async () => { await purgeAllUserData(); publish.mockReset().mockResolvedValue(true); });
it('persists and retries a child plan under its scoped exchange storage key', async () => {
  const pairing = { endpoint: 'e'.repeat(64), client: 'f'.repeat(64) };
  const a = party('01'.repeat(32), `dependant:${'a'.repeat(64)}`, { childPairing: async () => pairing }), b = party('02'.repeat(32), 'owner');
  const now = 1700000000;
  const invite = await b.service.create(b.pubkey, 'Child exchange', ['wss://relay.example'], 'single-use', now);
  const args = { identityPubkey: a.pubkey, exchangeId: 'a'.repeat(32), nonce: 'b'.repeat(64), replySecret: 'c'.repeat(64), invite: invite.invite, now: now + 1, pairing };
  const first = await a.service.requestChildPlan(args);
  const again = await a.service.requestChildPlan({ ...args, now: now + 2 });
  expect(again.id).toBe(first.id);
  expect(a.signer.signEvent).toHaveBeenCalledTimes(1);
  const state = await a.service.read();
  expect(state.exchanges).toHaveLength(1);
  expect(state.exchanges[0].request.id).toBe(args.exchangeId);
  expect(state.outbox[0].exchangeId).toBe(contactExchangeKey(state.exchanges[0].request));
  await a.service.flush(now + 3);
  expect(publish).toHaveBeenCalledTimes(1);
  expect((await a.service.read()).outbox[0].acknowledgedAt).toBe(now + 3);
});
it('persists each exchange step, opens on demand and completes matching words through the reply mailbox', async () => {
  const a = party('01'.repeat(32), 'owner'), b = party('02'.repeat(32), `dependant:${'b'.repeat(64)}`);
  const now = 1700000000;
  const invite = await b.service.create(b.pubkey, 'Conference', ['wss://relay.example'], 'single-use', now);
  await a.service.request(a.pubkey, invite.invite, now + 1);
  const first = await a.service.read();
  expect(publish).not.toHaveBeenCalled();
  expect(first.exchanges[0].nonce).toHaveLength(64);
  const requestPacket = openContactMailboxWrap(first.outbox[0].event, invite.invite.secret)!;
  await recordContactArrival(b.directoryId, KEY, { id: first.outbox[0].id, inviteId: invite.id,
    identityPubkey: b.pubkey, packet: requestPacket, receivedAt: now + 2 });
  expect(b.signer.decrypt).not.toHaveBeenCalled();
  await b.service.openInbox(now + 3);
  await b.service.accept(first.outbox[0].id, now + 4);
  await b.service.flush(now + 5);
  const receiver = await b.service.read(), exchange = receiver.exchanges[0];
  const acceptPacket = openContactMailboxWrap(receiver.outbox[0].event, exchange.request.reply.secret)!;
  await recordContactArrival(a.directoryId, KEY, { id: receiver.outbox[0].id, inviteId: contactExchangeKey(exchange.request),
    identityPubkey: a.pubkey, packet: acceptPacket, receivedAt: now + 6, channel: 'exchange' });
  await a.service.openInbox(now + 7);
  publish.mockResolvedValueOnce(false);
  await a.service.flush(now + 8);
  expect((await a.service.read()).outbox.some(o => !o.acknowledgedAt)).toBe(true);
  await a.service.flush(now + 9);
  const sender = await a.service.read();
  expect(sender.exchanges[0].phase).toBe('complete');
  const reveal = sender.outbox[1];
  await recordContactArrival(b.directoryId, KEY, { id: reveal.id, inviteId: contactExchangeKey(exchange.request),
    identityPubkey: b.pubkey, packet: openContactMailboxWrap(reveal.event, exchange.request.reply.secret)!,
    receivedAt: now + 10, channel: 'exchange' });
  await b.service.openInbox(now + 11);
  const completed = (await b.service.read()).exchanges[0];
  expect(completed.phase).toBe('complete');
  const aw = contactVerificationWords(completed.request, completed.acceptance!, completed.reveal!, a.pubkey);
  const bw = contactVerificationWords(completed.request, completed.acceptance!, completed.reveal!, b.pubkey);
  expect(aw.youSay).toBe(bw.theySay);
  expect(aw.theySay).toBe(bw.youSay);
  await expect(a.service.confirmWords(contactExchangeKey(exchange.request), 'wrong three words', now + 12)).rejects.toThrow('do not match');
  expect((await a.service.read()).exchanges[0].wordsConfirmedAt).toBeUndefined();
  await a.service.confirmWords(contactExchangeKey(exchange.request), `  ${bw.youSay.toUpperCase()}  `, now + 12);
  expect((await a.service.read()).exchanges[0].wordsConfirmedAt).toBe(now + 12);
  expect((await b.service.read()).exchanges[0].wordsConfirmedAt).toBeUndefined();
  await a.service.cleanup();
  const cleaned = await a.service.read();
  expect(cleaned.outbox).toHaveLength(0);
  expect(cleaned.exchanges[0].wordsConfirmedAt).toBe(now + 12);
  expect(contactVerificationWords(cleaned.exchanges[0].request, cleaned.exchanges[0].acceptance!, cleaned.exchanges[0].reveal!, a.pubkey)).toEqual(aw);
}, 30000);

it('does not send expired or silently cancelled pending requests', async () => {
  const a = party('01'.repeat(32), 'owner'), b = party('02'.repeat(32), `dependant:${'b'.repeat(64)}`);
  const expired = await b.service.create(b.pubkey, 'Short lived', ['wss://relay.example'], 'single-use', 100, 102);
  await a.service.request(a.pubkey, expired.invite, 101);
  await a.service.flush(103);
  expect(publish).not.toHaveBeenCalled();
  const active = await b.service.create(b.pubkey, 'Active', ['wss://relay.example'], 'standing', 104);
  await a.service.request(a.pubkey, active.invite, 105);
  const pending = (await a.service.read()).exchanges.find(e => e.request.createdAt === 105)!;
  await a.service.cancel(contactExchangeKey(pending.request));
  await a.service.flush(106);
  expect(publish).not.toHaveBeenCalled();
  expect((await a.service.read()).exchanges.find(e => e.request.createdAt === 105)?.phase).toBe('declined');
}, 30000);

it('flags a different intended recipient without hiding their request and requires explicit acceptance', async () => {
  const a = party('01'.repeat(32), 'owner'), b = party('02'.repeat(32), `dependant:${'b'.repeat(64)}`);
  const now = 1700000000;
  const expectedPeer = getPublicKey(hexToBytes('03'.repeat(32)));
  const invite = await b.service.create(b.pubkey, 'For someone else', ['wss://relay.example'], 'single-use', now, undefined, undefined, expectedPeer);
  expect(JSON.stringify(invite.invite)).not.toContain(expectedPeer);
  await a.service.request(a.pubkey, invite.invite, now + 1);
  const outgoing = (await a.service.read()).outbox[0];
  await recordContactArrival(b.directoryId, KEY, { id: outgoing.id, inviteId: invite.id,
    identityPubkey: b.pubkey, packet: openContactMailboxWrap(outgoing.event, invite.invite.secret)!, receivedAt: now + 2 });
  await b.service.openInbox(now + 3);
  expect((await b.service.read()).arrivals[0].request?.from).toBe(a.pubkey);
  expect((await b.service.read()).arrivals[0].dismissedAt).toBeUndefined();
  await expect(b.service.accept(outgoing.id, now + 4)).rejects.toThrow('different contact');
  expect(b.signer.signEvent).not.toHaveBeenCalled();
  await b.service.accept(outgoing.id, now + 4, true);
  expect((await b.service.read()).exchanges[0].phase).toBe('accepted');
}, 30000);

it('auto-accepts only a fresh single-use app invite and disables it after grant revocation', async () => {
  let allowed = true;
  const a = party('01'.repeat(32), 'owner'), b = party('02'.repeat(32), `dependant:${'b'.repeat(64)}`,
    { appAllowed: async () => allowed, automaticAttempts: new Set() });
  const now = 1700000000;
  const metadata = { grantId: 'c'.repeat(32), requestId: 'd'.repeat(32), requestHash: 'e'.repeat(64), appName: 'Example game', autoAcceptUntil: now + 300 };
  const invite = await b.service.issueAppInvite(b.pubkey, ['wss://relay.example'], 'single-use', now, metadata);
  await a.service.request(a.pubkey, invite.invite, now + 1);
  const outgoing = (await a.service.read()).outbox[0];
  await recordContactArrival(b.directoryId, KEY, { id: outgoing.id, inviteId: invite.id,
    identityPubkey: b.pubkey, packet: openContactMailboxWrap(outgoing.event, invite.invite.secret)!, receivedAt: now + 2 });
  await b.service.processAppInvites(now + 3);
  expect((await b.service.read()).exchanges[0]).toMatchObject({ phase: 'accepted', origin: { method: 'app', appName: 'Example game' } });
  expect(b.signer.decrypt).toHaveBeenCalledTimes(1);
  await b.service.processAppInvites(now + 4);
  expect(b.signer.decrypt).toHaveBeenCalledTimes(1);
  allowed = false;
  await b.service.processAppInvites(now + 5);
  expect((await b.service.read()).invites[0].enabled).toBe(false);
  await expect(b.service.setEnabled(invite.id, true, now + 6)).rejects.toThrow('no longer');
}, 30000);

it.each(['standing', 'opt-out', 'expired'] as const)('does no background identity work for %s app invitations', async kind => {
  const a = party('01'.repeat(32), 'owner'), b = party('02'.repeat(32), `dependant:${'b'.repeat(64)}`,
    { appAllowed: async (_app, _own, _action, automatic) => !automatic || kind !== 'opt-out', automaticAttempts: new Set() });
  const now = 1700000000;
  const metadata = { grantId: 'c'.repeat(32), requestId: 'd'.repeat(32), requestHash: 'e'.repeat(64), appName: 'Example game',
    ...(kind === 'standing' ? {} : { autoAcceptUntil: now + 300 }) };
  const invite = await b.service.issueAppInvite(b.pubkey, ['wss://relay.example'], kind === 'standing' ? 'standing' : 'single-use', now, metadata);
  await a.service.request(a.pubkey, invite.invite, now + 1);
  const outgoing = (await a.service.read()).outbox[0];
  await recordContactArrival(b.directoryId, KEY, { id: outgoing.id, inviteId: invite.id, identityPubkey: b.pubkey,
    packet: openContactMailboxWrap(outgoing.event, invite.invite.secret)!, receivedAt: now + 2 });
  await b.service.processAppInvites(now + (kind === 'expired' ? 300 : 3));
  expect(b.signer.decrypt).not.toHaveBeenCalled(); expect(b.signer.signEvent).not.toHaveBeenCalled();
  expect((await b.service.read()).exchanges).toEqual([]);
}, 30000);

it('does not automatically accept after a hardware signature outlasts the consent window', async () => {
  const a = party('01'.repeat(32), 'owner'), b = party('02'.repeat(32), `dependant:${'b'.repeat(64)}`,
    { appAllowed: async () => true, automaticAttempts: new Set() });
  const now = 1700000000;
  const invite = await b.service.issueAppInvite(b.pubkey, ['wss://relay.example'], 'single-use', now,
    { grantId: 'c'.repeat(32), requestId: 'd'.repeat(32), requestHash: 'e'.repeat(64), appName: 'Example game', autoAcceptUntil: now + 300 });
  await a.service.request(a.pubkey, invite.invite, now + 1);
  const outgoing = (await a.service.read()).outbox[0];
  await recordContactArrival(b.directoryId, KEY, { id: outgoing.id, inviteId: invite.id, identityPubkey: b.pubkey,
    packet: openContactMailboxWrap(outgoing.event, invite.invite.secret)!, receivedAt: now + 2 });
  let clock = Date.now();
  const date = vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const sign = b.signer.signEvent.getMockImplementation()!;
  b.signer.signEvent.mockImplementation(async template => { const signed = await sign(template); clock += 301000; return signed; });
  try {
    await b.service.processAppInvites(now + 3);
    await b.service.processAppInvites(now + 304);
    expect((await b.service.read()).exchanges).toEqual([]);
    expect((await b.service.read()).arrivals[0].request).toBeDefined();
    expect(b.signer.signEvent).toHaveBeenCalledTimes(1);
    // The request itself still has its 30-day lifetime and can be accepted manually.
    await b.service.accept(outgoing.id, now + 305);
    expect((await b.service.read()).exchanges[0].phase).toBe('accepted');
  } finally { date.mockRestore(); }
}, 30000);

it('does not repeat a refused app handover signature during the same unlock', async () => {
  const attempts = new Set<string>();
  const a = party('01'.repeat(32), 'owner', { appAllowed: async () => true, automaticAttempts: attempts });
  const b = party('02'.repeat(32), `dependant:${'b'.repeat(64)}`);
  const now = 1700000000;
  const invite = await b.service.create(b.pubkey, 'Hello', ['wss://relay.example'], 'single-use', now);
  const app = { grantId: 'c'.repeat(32), requestId: 'd'.repeat(32), requestHash: 'e'.repeat(64), appName: 'Game' };
  a.signer.signEvent.mockRejectedValue(new Error('User refused'));
  await expect(a.service.request(a.pubkey, invite.invite, now, app)).rejects.toThrow('User refused');
  await expect(a.service.request(a.pubkey, invite.invite, now + 5, app)).rejects.toThrow('already attempted');
  expect(a.signer.signEvent).toHaveBeenCalledTimes(1);
  expect((await a.service.read()).exchanges).toEqual([]);
  // Recreating a service during a render does not reset the unlock budget.
  const resumed = party('01'.repeat(32), 'owner', { appAllowed: async () => true, automaticAttempts: attempts });
  await expect(resumed.service.request(a.pubkey, invite.invite, now + 10, app)).rejects.toThrow('already attempted');
  expect(resumed.signer.signEvent).not.toHaveBeenCalled();
  attempts.clear();
  await resumed.service.request(a.pubkey, invite.invite, now + 15, app);
  await resumed.service.request(a.pubkey, invite.invite, now + 20, app);
  expect(resumed.signer.signEvent).toHaveBeenCalledTimes(1);
  expect((await resumed.service.read()).exchanges).toHaveLength(1);
}, 30000);

it('retains a request for guardian review without accepting or publishing before approval', async () => {
  let approved = false;
  const a = party('01'.repeat(32), 'owner'), b = party('02'.repeat(32), `dependant:${'b'.repeat(64)}`,
    { mayConnect: () => approved, mayReceive: () => true });
  const now = 1700000000;
  const invite = await b.service.create(b.pubkey, 'Family', ['wss://relay.example'], 'single-use', now);
  await a.service.request(a.pubkey, invite.invite, now + 1);
  const outgoing = (await a.service.read()).outbox[0];
  await recordContactArrival(b.directoryId, KEY, { id: outgoing.id, inviteId: invite.id, identityPubkey: b.pubkey,
    packet: openContactMailboxWrap(outgoing.event, invite.invite.secret)!, receivedAt: now + 2 });
  await b.service.openInbox(now + 3);
  expect((await b.service.read()).arrivals[0]).toMatchObject({ request: { from: a.pubkey } });
  expect((await b.service.read()).arrivals[0].dismissedAt).toBeUndefined();
  await expect(b.service.accept(outgoing.id, now + 4)).rejects.toThrow('cannot be accepted');
  expect(b.signer.signEvent).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  approved = true;
  await b.service.accept(outgoing.id, now + 5);
  expect((await b.service.read()).exchanges[0].phase).toBe('accepted');
  expect(publish).not.toHaveBeenCalled();
}, 30000);

it('rechecks the contact policy after waiting for a hardware acceptance signature', async () => {
  let allowed = true;
  const a = party('01'.repeat(32), 'owner'), b = party('02'.repeat(32), `dependant:${'b'.repeat(64)}`, { mayConnect: () => allowed });
  const now = 1700000000;
  const invite = await b.service.create(b.pubkey, 'Family', ['wss://relay.example'], 'single-use', now);
  await a.service.request(a.pubkey, invite.invite, now + 1);
  const outgoing = (await a.service.read()).outbox[0];
  await recordContactArrival(b.directoryId, KEY, { id: outgoing.id, inviteId: invite.id, identityPubkey: b.pubkey,
    packet: openContactMailboxWrap(outgoing.event, invite.invite.secret)!, receivedAt: now + 2 });
  await b.service.openInbox(now + 3);
  const sign = b.signer.signEvent.getMockImplementation()!;
  b.signer.signEvent.mockImplementation(async template => { const event = await sign(template); allowed = false; return event; });
  await expect(b.service.accept(outgoing.id, now + 4)).rejects.toThrow('policy changed');
  expect((await b.service.read()).exchanges).toEqual([]);
  expect((await b.service.read()).outbox).toEqual([]);
  expect(publish).not.toHaveBeenCalled();
}, 30000);
it('withholds an outgoing request when contact policy is withdrawn during signing', async () => {
  let allowed = true;
  const a = party('01'.repeat(32), `dependant:${'b'.repeat(64)}`, { mayConnect: () => allowed }), b = party('02'.repeat(32), 'owner');
  const now = 1700000000;
  const invite = await b.service.create(b.pubkey, 'Friend', ['wss://relay.example'], 'single-use', now);
  const sign = a.signer.signEvent.getMockImplementation()!;
  a.signer.signEvent.mockImplementation(async template => { const event = await sign(template); allowed = false; return event; });
  await expect(a.service.request(a.pubkey, invite.invite, now + 1)).rejects.toThrow('policy changed');
  expect((await a.service.read()).outbox).toEqual([]);
  expect((await a.service.read()).exchanges).toEqual([]);
});
it('rechecks fresh policy at transmission after a relay connection wait', async () => {
  let allowed = true;
  const a = party('01'.repeat(32), `dependant:${'b'.repeat(64)}`, { mayConnect: () => allowed }), b = party('02'.repeat(32), 'owner');
  const now = 1700000000;
  const invite = await b.service.create(b.pubkey, 'Friend', ['wss://relay.example'], 'single-use', now);
  await a.service.request(a.pubkey, invite.invite, now + 1);
  // Emulate the adapter reaching its send boundary after a connection wait.
  let sent = false;
  publish.mockImplementationOnce(async (...args: unknown[]) => {
    allowed = false;
    const guard = args[2] as { beforeSend(): Promise<void>; isCurrent(): boolean };
    try { await guard.beforeSend(); } catch { return false; }
    sent = guard.isCurrent(); return sent;
  });
  await a.service.flush(now + 2);
  expect(sent).toBe(false);
  expect((await a.service.read()).outbox[0].acknowledgedAt).toBeUndefined();
});

describe('child exchanges follow the pairing they were approved under (D5)', () => {
  const pairing = { endpoint: 'e'.repeat(64), client: 'f'.repeat(64) };
  async function child(live: { current: typeof pairing | null }) {
    const cancelled = vi.fn(async (_exchange: unknown) => {});
    const a = party('01'.repeat(32), `dependant:${'a'.repeat(64)}`, { childPairing: async () => live.current, onChildExchangeCancelled: cancelled });
    const b = party('02'.repeat(32), 'owner');
    const now = 1700000000;
    const invite = await b.service.create(b.pubkey, 'Child exchange', ['wss://relay.example'], 'single-use', now);
    await a.service.requestChildPlan({ identityPubkey: a.pubkey, exchangeId: 'a'.repeat(32), nonce: 'b'.repeat(64), replySecret: 'c'.repeat(64),
      invite: invite.invite, now: now + 1, pairing });
    return { a, b, invite, now, cancelled };
  }
  it('stamps the pairing and proceeds while it still matches', async () => {
    const live = { current: pairing };
    const { a, now, cancelled } = await child(live);
    expect((await a.service.read()).exchanges[0].pairing).toEqual(pairing);
    await a.service.flush(now + 2);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });
  it('refuses to create an exchange for a pairing that is no longer live', async () => {
    const live = { current: { ...pairing, client: 'd'.repeat(64) } };
    const a = party('01'.repeat(32), `dependant:${'a'.repeat(64)}`, { childPairing: async () => live.current }), b = party('02'.repeat(32), 'owner');
    const invite = await b.service.create(b.pubkey, 'Child exchange', ['wss://relay.example'], 'single-use', 1700000000);
    await expect(a.service.requestChildPlan({ identityPubkey: a.pubkey, exchangeId: 'a'.repeat(32), nonce: 'b'.repeat(64), replySecret: 'c'.repeat(64),
      invite: invite.invite, now: 1700000001, pairing })).rejects.toThrow('pairing changed');
    expect(a.signer.signEvent).not.toHaveBeenCalled();
  });
  it('flush refuses and cancels a row stamped with a replaced pairing', async () => {
    const live: { current: typeof pairing | null } = { current: pairing };
    const { a, now, cancelled } = await child(live);
    live.current = { ...pairing, client: 'd'.repeat(64) };
    await a.service.flush(now + 2);
    expect(publish).not.toHaveBeenCalled();
    expect((await a.service.read()).exchanges[0].phase).toBe('declined');
    expect(cancelled).toHaveBeenCalledTimes(1);
    await a.service.flush(now + 3);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it('cleanup cancels a row whose dependant is no longer paired', async () => {
    const live: { current: typeof pairing | null } = { current: pairing };
    const { a, now, cancelled } = await child(live);
    live.current = null;
    await a.service.cleanup(now + 2);
    expect((await a.service.read()).exchanges[0].phase).toBe('declined');
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it('treats an unstamped child row as mismatched even under the same pairing', async () => {
    const live = { current: pairing };
    const { a, now, cancelled } = await child(live);
    await updateContactInviteVault(a.directoryId, KEY, state => ({ ...state, exchanges: state.exchanges.map(({ pairing: _p, ...e }) => e) }));
    await a.service.flush(now + 2);
    expect(publish).not.toHaveBeenCalled();
    expect((await a.service.read()).exchanges[0].phase).toBe('declined');
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it('openInbox dismisses a reply to a stale exchange without an identity decrypt', async () => {
    const live: { current: typeof pairing | null } = { current: pairing };
    const { a, b, invite, now, cancelled } = await child(live);
    await a.service.flush(now + 2);
    const out = (await a.service.read()).outbox[0];
    await recordContactArrival(b.directoryId, KEY, { id: out.id, inviteId: invite.id, identityPubkey: b.pubkey,
      packet: openContactMailboxWrap(out.event, invite.invite.secret)!, receivedAt: now + 3 });
    await b.service.openInbox(now + 4);
    await b.service.accept(out.id, now + 5);
    const receiver = await b.service.read(), exchange = receiver.exchanges[0];
    await recordContactArrival(a.directoryId, KEY, { id: receiver.outbox[0].id, inviteId: contactExchangeKey(exchange.request), identityPubkey: a.pubkey,
      packet: openContactMailboxWrap(receiver.outbox[0].event, exchange.request.reply.secret)!, receivedAt: now + 6, channel: 'exchange' });
    live.current = { ...pairing, endpoint: 'd'.repeat(64) };
    await a.service.openInbox(now + 7, true);
    expect(a.signer.decrypt).not.toHaveBeenCalled();
    const state = await a.service.read();
    expect(state.arrivals[0].dismissedAt).toBe(now + 7);
    expect(state.exchanges[0].phase).toBe('declined');
    expect(cancelled).toHaveBeenCalledTimes(1);
  }, 30000);
});

describe('child exchanges publish and record only for an approved request (review finding 1)', () => {
  const pairing = { endpoint: 'e'.repeat(64), client: 'f'.repeat(64) };
  const directoryId = `dependant:${'a'.repeat(64)}`;
  async function child(verdict: { current: 'go' | 'wait' | 'withdraw' }, extra: Partial<ConstructorParameters<typeof ContactInviteService>[0]> = {}) {
    const cancelled = vi.fn(async (_exchange: unknown, _reason: string) => {});
    const opts = { childPairing: async () => pairing, onChildExchangeCancelled: cancelled, childAuthority: async () => verdict.current, ...extra };
    const a = party('01'.repeat(32), directoryId, opts);
    const b = party('02'.repeat(32), 'owner');
    const now = 1700000000;
    const invite = await b.service.create(b.pubkey, 'Child exchange', ['wss://relay.example'], 'single-use', now);
    await a.service.requestChildPlan({ identityPubkey: a.pubkey, exchangeId: 'a'.repeat(32), nonce: 'b'.repeat(64), replySecret: 'c'.repeat(64),
      invite: invite.invite, now: now + 1, pairing });
    return { a, b, invite, now, cancelled, opts };
  }
  it('a background flush before the receipt swap publishes nothing and waits', async () => {
    const verdict = { current: 'wait' as 'go' | 'wait' | 'withdraw' };
    const { a, now, cancelled } = await child(verdict);
    await a.service.flush(now + 2);
    expect(publish).not.toHaveBeenCalled();
    expect((await a.service.read()).exchanges[0].phase).toBe('requested');
    expect(cancelled).not.toHaveBeenCalled();
    verdict.current = 'go';
    await a.service.flush(now + 3);
    expect(publish).toHaveBeenCalledTimes(1);
  });
  it('withdraws an exchange whose receipt expired instead of publishing it', async () => {
    const { a, now, cancelled } = await child({ current: 'withdraw' });
    await a.service.flush(now + 2);
    expect(publish).not.toHaveBeenCalled();
    expect((await a.service.read()).exchanges[0].phase).toBe('declined');
    expect(cancelled.mock.calls[0][1]).toBe('withdrawn');
  });
  it('refuses at the send boundary when approval is withdrawn during a relay wait', async () => {
    const verdict = { current: 'go' as 'go' | 'wait' | 'withdraw' };
    const { a, now } = await child(verdict);
    let sent = false;
    publish.mockImplementationOnce(async (...args: unknown[]) => {
      verdict.current = 'withdraw';
      const guard = args[2] as { beforeSend(): Promise<void>; isCurrent(): boolean };
      try { await guard.beforeSend(); } catch { return false; }
      sent = true; return true;
    });
    await a.service.flush(now + 2);
    expect(sent).toBe(false);
  });
  it('records no contact for a completed exchange whose receipt expired', async () => {
    const verdict = { current: 'go' as 'go' | 'wait' | 'withdraw' };
    const { a, b, invite, now } = await child(verdict);
    await a.service.flush(now + 2);
    const out = (await a.service.read()).outbox[0];
    await recordContactArrival(b.directoryId, KEY, { id: out.id, inviteId: invite.id, identityPubkey: b.pubkey,
      packet: openContactMailboxWrap(out.event, invite.invite.secret)!, receivedAt: now + 3 });
    await b.service.openInbox(now + 4);
    await b.service.accept(out.id, now + 5);
    const receiver = await b.service.read(), exchange = receiver.exchanges[0];
    await recordContactArrival(a.directoryId, KEY, { id: receiver.outbox[0].id, inviteId: contactExchangeKey(exchange.request), identityPubkey: a.pubkey,
      packet: openContactMailboxWrap(receiver.outbox[0].event, exchange.request.reply.secret)!, receivedAt: now + 6, channel: 'exchange' });
    await a.service.openInbox(now + 7, true);
    await a.service.flush(now + 8);
    expect((await a.service.read()).exchanges[0].phase).toBe('complete');
    // The receipt expires before the contact is recorded.
    verdict.current = 'withdraw';
    const onCompleted = vi.fn(async () => 'd'.repeat(32));
    const again = party('01'.repeat(32), directoryId, { childPairing: async () => pairing, childAuthority: async () => verdict.current, onCompleted });
    await again.service.flush(now + 9);
    await expect(again.service.materialiseContact(contactExchangeKey(exchange.request))).rejects.toThrow('not ready');
    expect(onCompleted).not.toHaveBeenCalled();
    expect((await again.service.read()).exchanges[0].contactId).toBeUndefined();
  }, 30000);
  it('reports an exchange the peer never answered before compaction declines it', async () => {
    const { a, now, cancelled } = await child({ current: 'go' });
    const expiresAt = (await a.service.read()).exchanges[0].request.expiresAt;
    await a.service.cleanup(expiresAt + 1);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(cancelled.mock.calls[0][1]).toBe('expired');
    expect((await a.service.read()).exchanges[0].phase).toBe('declined');
    await a.service.cleanup(expiresAt + 2);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(now).toBeLessThan(expiresAt);
  });
});
