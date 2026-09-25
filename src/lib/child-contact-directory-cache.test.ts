import { beforeEach, expect, it, vi } from 'vitest';
import { getDb, loadPairedChild, markPairedChildConnected, purgeAllUserData, savePairedChild } from './db';
import * as cryptoStore from './crypto-store';
import { loadChildContactDirectoryCache, saveChildContactDirectoryCache } from './child-contact-directory-cache';
import { projectChildContactDirectory } from './child-contact-directory';
const child = '1'.repeat(64), guardian = '2'.repeat(64), recipient = '3'.repeat(64), key = 'test-family-directory-cache-key';
const setup = { dependantPubkey: child, dependantName: 'Child', guardianPubkey: guardian, pairedAt: 1,
  bunkerUri: `bunker://${'4'.repeat(64)}?relay=wss%3A%2F%2Frelay.example`, clientKeypair: { publicKey: recipient, privateKey: '5'.repeat(64) } };
const view = (revision: number) => projectChildContactDirectory({ child, guardian, recipient, availablePersonas: ['6'.repeat(64)], now: 20, revision, records: [] });
const current = () => true;
beforeEach(async () => { vi.restoreAllMocks(); await purgeAllUserData(); await savePairedChild(setup, key); });
it('encrypts the snapshot, retains the newest revision across concurrent saves and reloads', async () => {
  const pair = (await loadPairedChild(child, key))!;
  await Promise.all([saveChildContactDirectoryCache(pair, key, view(20), current), saveChildContactDirectoryCache(pair, key, view(10), current)]);
  await markPairedChildConnected(child, key);
  expect(await loadChildContactDirectoryCache(pair, key, current)).toEqual(view(20));
  const raw = await (await getDb()).get('pairedChild', child);
  expect(raw.contactDirectoryCache).not.toContain('personas');
  await expect(loadChildContactDirectoryCache(pair, 'wrong-key', current)).rejects.toThrow();
});
it('makes disagreement durable and refuses corrupt-cache rollback or replaced pairing', async () => {
  const pair = (await loadPairedChild(child, key))!;
  await saveChildContactDirectoryCache(pair, key, view(20), current);
  await saveChildContactDirectoryCache(pair, key, { ...view(20), personas: [] }, current);
  expect(await loadChildContactDirectoryCache(pair, key, current)).toMatchObject({ conflicted: true, entries: [] });
  const db = await getDb(), raw = await db.get('pairedChild', child);
  await db.put('pairedChild', { ...raw, contactDirectoryCache: 'broken' });
  await expect(saveChildContactDirectoryCache(pair, key, view(21), current)).rejects.toThrow();
  await savePairedChild({ ...setup, pairedAt: 2 }, key);
  await expect(loadChildContactDirectoryCache(pair, key, current)).rejects.toThrow('pairing changed');
  expect(await loadChildContactDirectoryCache((await loadPairedChild(child, key))!, key, current)).toBeNull();
});
it('does not commit when the session changes during encryption', async () => {
  const pair = (await loadPairedChild(child, key))!; let active = true;
  const encrypt = cryptoStore.encryptSecret;
  vi.spyOn(cryptoStore, 'encryptSecret').mockImplementation(async (...args) => { const result = await encrypt(...args); active = false; return result; });
  await expect(saveChildContactDirectoryCache(pair, key, view(20), () => active)).rejects.toThrow('session changed');
  expect(await loadChildContactDirectoryCache(pair, key, current)).toBeNull();
});
