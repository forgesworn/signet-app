import { beforeEach, expect, it, vi } from 'vitest';
import { buildOperation } from './contacts-v2-mutations';
// Count real log decrypts: one batch call per uncached read of the log.
const crypto = vi.hoisted(() => ({ batch: vi.fn() }));
vi.mock('./crypto-store', async importOriginal => {
  const original = await importOriginal<typeof import('./crypto-store')>();
  crypto.batch.mockImplementation(original.decryptSecretsBatch);
  return { ...original, decryptSecretsBatch: crypto.batch };
});
import { forgetContactOperationsCache as forgetContactPeerCache, listContactOperationsV2Cached, purgeAllUserData, saveContactOperationsV2 } from './db';
import { contactPeerAllowed } from './contact-exchange-record';
const db = { list: crypto.batch };

const key = 'peer cache test', peer = '2'.repeat(64), other = '5'.repeat(64);
const actor = { actorPubkey: '1'.repeat(64), actorRole: 'owner' as const, actorDeviceId: '3'.repeat(32) };
const make = (action: Parameters<typeof buildOperation>[0]['action'], value: unknown, clock: number, contactId = '9'.repeat(32)) => buildOperation({
  directoryId: 'owner', contactId, action, value, clock, actor, now: 1000, operationId: clock.toString(16).padStart(32, '0') });
const friend = () => [make('add', { type: 'person', displayName: 'Friend', tier: 'kith' }, 1),
  make('add-identity', { itemId: 'a'.repeat(32), pubkey: peer, provenance: 'direct', verification: 'unverified' }, 2)];
beforeEach(async () => { await purgeAllUserData(); forgetContactPeerCache(); db.list.mockClear(); });

it('decrypts the log once while it is unchanged', async () => {
  await saveContactOperationsV2(friend(), key);
  expect(await contactPeerAllowed('owner', key, peer)).toBe(true);
  expect(await contactPeerAllowed('owner', key, peer)).toBe(true);
  expect(await contactPeerAllowed('owner', key, other)).toBe(true);
  expect(db.list).toHaveBeenCalledTimes(1);
});

it('refuses a peer the moment a block is written, with no stale allowance', async () => {
  await saveContactOperationsV2(friend(), key);
  expect(await contactPeerAllowed('owner', key, peer)).toBe(true);
  await saveContactOperationsV2([make('block', { scope: { kind: 'contact' } }, 3)], key);
  expect(await contactPeerAllowed('owner', key, peer)).toBe(false);
  expect(await contactPeerAllowed('owner', key, other)).toBe(true);
  await saveContactOperationsV2([{ ...make('unblock', {}, 4), targetOperationId: (3).toString(16).padStart(32, '0') }], key);
  expect(await contactPeerAllowed('owner', key, peer)).toBe(true);
});

it('recomputes when the same ids are stored again with different content', async () => {
  await saveContactOperationsV2([...friend(), make('block', { scope: { kind: 'contact' } }, 3)], key);
  expect(await contactPeerAllowed('owner', key, peer)).toBe(false);
  await purgeAllUserData();
  await saveContactOperationsV2([...friend(), make('rename', { displayName: 'Friend again' }, 3)], key);
  expect(await contactPeerAllowed('owner', key, peer)).toBe(true);
});

it('hands out copies, so a caller cannot alter what the next caller reads', async () => {
  await saveContactOperationsV2(friend(), key);
  const first = await listContactOperationsV2Cached('owner', key);
  (first[0] as { action: string }).action = 'block';
  first.length = 0;
  const again = await listContactOperationsV2Cached('owner', key);
  expect(again).toHaveLength(2);
  expect(again[0].action).toBe('add');
  expect(db.list).toHaveBeenCalledTimes(1);
});

it('is emptied by a purge', async () => {
  await saveContactOperationsV2([...friend(), make('block', { scope: { kind: 'contact' } }, 3)], key);
  expect(await contactPeerAllowed('owner', key, peer)).toBe(false);
  await purgeAllUserData();
  expect(await listContactOperationsV2Cached('owner', key)).toEqual([]);
});

it('keeps nothing across a lock or a different unlock key, and separates directories', async () => {
  await saveContactOperationsV2([...friend(), make('block', { scope: { kind: 'contact' } }, 3)], key);
  expect(await contactPeerAllowed('owner', key, peer)).toBe(false);
  forgetContactPeerCache();
  expect(await contactPeerAllowed('owner', key, peer)).toBe(false);
  expect(db.list).toHaveBeenCalledTimes(2);
  // A different key decrypts nothing here, so nothing is blocked under it.
  expect(await contactPeerAllowed('owner', 'another unlock', peer)).toBe(true);
  expect(await contactPeerAllowed(`dependant:${'d'.repeat(64)}`, key, peer)).toBe(true);
  expect(db.list).toHaveBeenCalledTimes(4);
});

it('is not refilled by a decrypt that was still running when the app locked', async () => {
  await saveContactOperationsV2(friend(), key);
  const inFlight = listContactOperationsV2Cached('owner', key);
  forgetContactPeerCache();
  expect(await inFlight).toHaveLength(2);
  await listContactOperationsV2Cached('owner', key);
  expect(db.list).toHaveBeenCalledTimes(2);
});
