import { beforeEach, expect, it } from 'vitest';
import { contactsVaultAdapter } from './private-vault-contacts';
import { purgeAllUserData, saveContactOperationsV2, listAllContactOperationsV2, getContactAvatar, saveContactAvatar } from './db';
import { createContactRequest, beginContactExchange, acceptContactExchange, receiveContactAcceptance, confirmContactRevealSent } from '@forgesworn/signet-contacts';
import { updateContactInviteVault } from './contact-invite-store';
import type { ContactOperation } from '../types';
const KEY = 'vault contacts key';
const op: ContactOperation = { operationId: 'a'.repeat(32), contactId: 'b'.repeat(32), directoryId: 'owner',
  actorDeviceId: 'c'.repeat(32), actorPubkey: 'd'.repeat(64), actorRole: 'owner', logicalClock: 1,
  createdAt: 1700000000, action: 'add', value: { type: 'person', displayName: 'Test', tier: 'ken', roles: [], lifecycle: 'active' } };
beforeEach(async () => { await purgeAllUserData(); });
it('keeps directory IDs pubkey-based while deriving vault purposes from the dependant ordinal', () => {
  const dep = { id: 'f'.repeat(64), derivationPath: 'dependant-0' };
  expect(contactsVaultAdapter(`dependant:${dep.id}`, KEY, () => true, dep).dataset).toEqual({ dependant: 0 });
  expect(() => contactsVaultAdapter('dependant:0', KEY, () => true, dep)).toThrow();
  expect(() => contactsVaultAdapter(`dependant:${dep.id}`, KEY, () => true, { ...dep, derivationPath: 'imported-view-0' })).toThrow();
});
it('backs up only its own directory and rejects foreign operations before writing', async () => {
  await saveContactOperationsV2([op], KEY);
  const adapter = contactsVaultAdapter('owner', KEY, () => true);
  const snapshot = JSON.parse(await adapter.snapshot());
  expect(snapshot.operations).toEqual([op]);
  const foreign = { ...op, directoryId: `dependant:${'f'.repeat(64)}`, operationId: 'e'.repeat(32) };
  await expect(adapter.merge(JSON.stringify({ ...snapshot, operations: [op, foreign] }), 1700000000)).rejects.toThrow();
  expect(await listAllContactOperationsV2(KEY)).toEqual([op]);
  await adapter.merge(JSON.stringify(snapshot), 1700000000);
  expect(await listAllContactOperationsV2(KEY)).toEqual([op]);
});
it('keeps bot contacts in one dedicated dataset and rejects mixing human contacts into it', async () => {
  const bot = { ...op, directoryId: 'bots', operationId: 'f'.repeat(32), ownerIdentityPubkey: 'e'.repeat(64) };
  await saveContactOperationsV2([op, bot], KEY);
  const bots = contactsVaultAdapter('bots', KEY, () => true), owner = contactsVaultAdapter('owner', KEY, () => true);
  expect(bots.dataset).toBe('contacts:bots');
  const snapshot = JSON.parse(await bots.snapshot());
  expect(snapshot.operations).toEqual([bot]);
  expect(JSON.parse(await owner.snapshot()).operations).toEqual([op]);
  await expect(bots.merge(JSON.stringify({ ...snapshot, operations: [op] }), 1700000000)).rejects.toThrow('Invalid contact operation');
});

// S2: the invite vault is sealed to self and carries each finished exchange's card, so a
// restored phone gets the partner photo keys back in the contactAvatars store.
const own = '1'.repeat(64), peer = '2'.repeat(64);
const photo = { key: '8'.repeat(64), server: 'https://blossom.example.com', hash: '9'.repeat(64) };
function completedExchange(createdAt: number, card: { photo: typeof photo }) {
  const nonce = '4'.repeat(64);
  const request = createContactRequest({ id: '5'.repeat(32), from: own, to: peer, nonce,
    reply: { secret: '6'.repeat(64), relays: ['wss://relay.example'] }, now: createdAt });
  const accepted = acceptContactExchange(request, '7'.repeat(64), createdAt + 1);
  const done = confirmContactRevealSent(receiveContactAcceptance(beginContactExchange(request, nonce), accepted.acceptance!, createdAt + 2));
  return { ...done, acceptance: { ...done.acceptance!, card } };
}
it('S2: restoring the invite vault installs each completed exchange\'s partner photo key and fallback', async () => {
  await updateContactInviteVault('owner', KEY, old => ({ ...old, exchanges: [completedExchange(1_700_000_100, { photo })] }));
  const snapshot = await contactsVaultAdapter('owner', KEY, () => true).snapshot();
  await purgeAllUserData(); // a fresh phone
  expect(await getContactAvatar(peer, KEY)).toBeNull();
  await contactsVaultAdapter('owner', KEY, () => true).merge(snapshot, 1700000000);
  expect(await getContactAvatar(peer, KEY)).toMatchObject({ pubkey: peer, shareKey: photo.key, fallback: { server: photo.server, hash: photo.hash } });
});
it('S2/M4: a restore never overwrites a newer key already stored for the partner', async () => {
  await updateContactInviteVault('owner', KEY, old => ({ ...old, exchanges: [completedExchange(1_700_000_100, { photo })] }));
  const snapshot = await contactsVaultAdapter('owner', KEY, () => true).snapshot();
  await purgeAllUserData();
  const newer = { pubkey: peer, shareKey: 'a'.repeat(64), addedAt: 1_700_000_200_000, fallback: { server: 'https://new.example.com', hash: 'b'.repeat(64) } };
  await saveContactAvatar(newer, KEY);
  await contactsVaultAdapter('owner', KEY, () => true).merge(snapshot, 1700000000);
  expect(await getContactAvatar(peer, KEY)).toMatchObject({ shareKey: newer.shareKey, fallback: newer.fallback });
});
