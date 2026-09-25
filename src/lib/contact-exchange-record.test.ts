import { beforeEach, expect, it } from 'vitest';
import { createContactRequest, beginContactExchange, acceptContactExchange, receiveContactAcceptance, confirmContactRevealSent } from '@forgesworn/signet-contacts';
import { recordCompletedContactExchange, contactPeerAllowed } from './contact-exchange-record';
import { listContactOperationsV2, saveContactOperationsV2, purgeAllUserData } from './db';
import { applyOperations } from './contacts-v2-reducer';
import { buildOperation } from './contacts-v2-mutations';
const key = 'exchange contact test', own = '1'.repeat(64), peer = '2'.repeat(64);
const actor = { actorPubkey: own, actorRole: 'owner' as const, actorDeviceId: '3'.repeat(32) };
function exchange() {
  const nonce = '4'.repeat(64);
  const request = createContactRequest({ id: '5'.repeat(32), from: own, to: peer, nonce,
    reply: { secret: '6'.repeat(64), relays: ['wss://relay.example'] }, now: 100 });
  const accepted = acceptContactExchange(request, '7'.repeat(64), 101);
  return confirmContactRevealSent(receiveContactAcceptance(beginContactExchange(request, nonce), accepted.acceptance!, 102));
}
const record = () => recordCompletedContactExchange({ directoryId: 'owner', key, actor, exchange: exchange(), isCurrent: () => true });
beforeEach(purgeAllUserData);
it('creates one Kith contact without asserting that its words were checked, and does not resurrect on replay', async () => {
  const contactId = await record();
  expect(await record()).toBe(contactId);
  let ops = await listContactOperationsV2('owner', key);
  expect(ops).toHaveLength(3);
  const contact = applyOperations(ops).get(`owner/${contactId}`)!;
  expect(contact.tier).toBe('kith');
  expect(contact.identities[0]).toMatchObject({ pubkey: peer, verification: 'unverified' });
  await saveContactOperationsV2([buildOperation({ directoryId: 'owner', contactId, action: 'remove', value: {},
    clock: 100, actor, now: 200000, operationId: '8'.repeat(32) })], key);
  expect(await record()).toBe(contactId);
  ops = await listContactOperationsV2('owner', key);
  expect(ops).toHaveLength(4);
  expect(applyOperations(ops).get(`owner/${contactId}`)!.lifecycle).toBe('removed');
});
it('preserves Kin and refuses a blocked peer before recording an exchange', async () => {
  const contactId = '9'.repeat(32);
  const make = (action: Parameters<typeof buildOperation>[0]['action'], value: unknown, clock: number) => buildOperation({
    directoryId: 'owner', contactId, action, value, clock, actor, now: 1000, operationId: clock.toString(16).padStart(32, '0') });
  await saveContactOperationsV2([make('add', { type: 'person', displayName: 'Friend', tier: 'kin' }, 1),
    make('add-identity', { itemId: 'a'.repeat(32), pubkey: peer, provenance: 'direct', verification: 'unverified' }, 2),
    make('block', { scope: { kind: 'contact' } }, 3)], key);
  expect(await contactPeerAllowed('owner', key, peer)).toBe(false);
  await expect(record()).rejects.toThrow('blocked');
  await purgeAllUserData();
  await saveContactOperationsV2([make('add', { type: 'person', displayName: 'Friend', tier: 'kin' }, 1),
    make('add-identity', { itemId: 'a'.repeat(32), pubkey: peer, provenance: 'direct', verification: 'unverified' }, 2)], key);
  expect(await record()).toBe(contactId);
  expect(applyOperations(await listContactOperationsV2('owner', key)).get(`owner/${contactId}`)!.tier).toBe('kin');
});
it('records confirmed words once and gives concurrent device operations distinct immutable IDs', async () => {
  const confirmed = { ...exchange(), wordsConfirmedAt: 103 };
  const args = { directoryId: 'owner', key, actor, exchange: confirmed, isCurrent: () => true };
  const contactId = await recordCompletedContactExchange(args);
  const first = await listContactOperationsV2('owner', key);
  await recordCompletedContactExchange(args);
  expect(await listContactOperationsV2('owner', key)).toHaveLength(first.length);
  expect(applyOperations(first).get(`owner/${contactId}`)!.checks?.[0]).toMatchObject({ method: 'words', checkedAt: 103000 });
  await purgeAllUserData();
  await recordCompletedContactExchange({ ...args, actor: { ...actor, actorDeviceId: 'e'.repeat(32) } });
  const second = await listContactOperationsV2('owner', key);
  expect(second.some(op => first.some(old => old.operationId === op.operationId))).toBe(false);
  await saveContactOperationsV2(first, key);
  const merged = [...applyOperations(await listContactOperationsV2('owner', key)).values()];
  expect(merged).toHaveLength(1);
  expect(merged[0].checks).toHaveLength(1);
});
it('copies private invite attribution to the contact once and does not recreate a removed history record', async () => {
  const completed = { ...exchange(), origin: { id: 'b'.repeat(32), ownerIdentityPubkey: own,
    method: 'accepted-request' as const, addedAt: 102000, inviteId: 'c'.repeat(32), inviteName: 'Private event name' } };
  const args = { directoryId: 'owner', key, actor, exchange: completed, isCurrent: () => true };
  const contactId = await recordCompletedContactExchange(args);
  const ops = await listContactOperationsV2('owner', key);
  expect(applyOperations(ops).get(`owner/${contactId}`)!.origins).toEqual([completed.origin]);
  await saveContactOperationsV2([buildOperation({ directoryId: 'owner', contactId, action: 'remove-origin', value: { id: completed.origin.id },
    clock: 100, actor, now: 200000, operationId: 'd'.repeat(32) })], key);
  await recordCompletedContactExchange(args);
  expect(applyOperations(await listContactOperationsV2('owner', key)).get(`owner/${contactId}`)!.origins).toEqual([]);
});
