import { expect, it } from 'vitest';
import { createStoredContactInvite, type ContactInviteVault } from './contact-invite-store';
import { contactMailboxPlan } from './contact-mailbox-plan';
const owner = 'a'.repeat(64), other = 'b'.repeat(64);
function state(count: number): ContactInviteVault {
  return { v: 1, directoryId: 'owner', exchanges: [], arrivals: [], outbox: [],
    invites: Array.from({ length: count }, (_, n) => createStoredContactInvite({
      identityPubkey: owner, name: `Invite ${n}`, now: 1, relays: [`wss://r${n}.test`] })) };
}
it('bounds merged offline overage and eventually polls every mailbox without changing the state', () => {
  const merged = state(35), original = JSON.stringify(merged), seen = new Set();
  for (let minute = 1; minute <= 35; minute++) {
    const plan = contactMailboxPlan(merged, owner, minute * 60);
    expect(plan.bindings).toHaveLength(16);
    expect(new Set(plan.bindings.flatMap(b => b.relays)).size).toBeLessThanOrEqual(16);
    expect(plan.deferred).toBe(19);
    plan.bindings.forEach(b => seen.add(b.id));
  }
  expect(seen.size).toBe(35);
  expect(JSON.stringify(merged)).toBe(original);
  expect(contactMailboxPlan(merged, other, 60).bindings).toEqual([]);
});
it('stops expired, disabled and consumed single-use mailboxes and normalizes relay aliases', () => {
  const data = state(4);
  data.invites[0].invite.expiresAt = 60;
  data.invites[1].enabled = false;
  data.invites[2].mode = 'single-use';
  data.arrivals.push({ id: 'c'.repeat(64), identityPubkey: owner, inviteId: data.invites[2].id,
    receivedAt: 10, packet: { v: 1, key: other, ciphertext: '' } });
  data.invites[3].invite.relays = ['wss://relay.test', 'wss://relay.test/'];
  expect(contactMailboxPlan(data, owner, 60).bindings).toEqual([{
    id: data.invites[3].id, secret: data.invites[3].invite.secret, relays: ['wss://relay.test/'], channel: 'invite',
  }]);
});
it('listens only on the public reply relays of a handshake exchange (review P1)', async () => {
  const { createContactRequest } = await import('@forgesworn/signet-contacts');
  const exchange = (id: string, relays: string[], handshake: boolean) => ({
    request: createContactRequest({ id: id.repeat(32), from: other, to: owner, nonce: '5'.repeat(64), now: 1,
      reply: { secret: '6'.repeat(64), relays }, expiresAt: 1000 }),
    role: 'recipient', phase: 'accepted', nonce: '5'.repeat(64), ...(handshake ? { handshake: { startedAt: 1 } } : {}),
  }) as never;
  const data: ContactInviteVault = { v: 1, directoryId: 'owner', invites: [], arrivals: [], outbox: [], exchanges: [
    exchange('1', ['wss://192.168.1.5', 'wss://nas', 'wss://relay.example'], true),
    exchange('2', ['wss://192.168.1.5', 'wss://relay.example'], false),
    exchange('3', ['wss://printer.local'], true),
  ] };
  const relays = contactMailboxPlan(data, owner, 60).bindings.map(b => b.relays).sort((a, b) => a.length - b.length);
  // The handshake listens on its public relay only; one with none is not opened; others are as before.
  expect(relays).toEqual([['wss://relay.example/'], ['wss://192.168.1.5/', 'wss://relay.example/']]);
});
