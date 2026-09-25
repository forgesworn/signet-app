import { beforeEach, expect, it } from 'vitest';
import { contactsVaultAdapter } from './private-vault-contacts';
import { purgeAllUserData, saveContactOperationsV2, listAllContactOperationsV2 } from './db';
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
