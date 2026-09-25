import { beforeEach, expect, it } from 'vitest';
import { getDb, loadPairedChild, markPairedChildConnected, purgeAllUserData, savePairedChild } from './db';
import { loadChildContactPolicyCache, saveChildContactPolicyCache } from './child-contact-policy-cache';
import { projectChildContactPolicy } from './child-contact-policy-wire';
const child = '1'.repeat(64), guardian = '2'.repeat(64), recipient = '3'.repeat(64), key = 'test-family-policy-cache-key';
const setup = { dependantPubkey: child, dependantName: 'Child', guardianPubkey: guardian, pairedAt: 1,
  bunkerUri: `bunker://${'4'.repeat(64)}?relay=wss%3A%2F%2Frelay.example`, clientKeypair: { publicKey: recipient, privateKey: '5'.repeat(64) } };
const view = (now: number) => projectChildContactPolicy({ child, guardian, recipient, now, records: [], settings: { childPubkey: child, guardianPubkey: guardian, contactPolicy: 'open' } });
beforeEach(async () => { await purgeAllUserData(); await savePairedChild(setup, key); });
it('encrypts the view and remembers a newer revision across reloads and concurrent saves', async () => {
  const pair = (await loadPairedChild(child, key))!;
  await Promise.all([saveChildContactPolicyCache(pair, key, view(20)), saveChildContactPolicyCache(pair, key, view(10))]);
  await markPairedChildConnected(child, key);
  expect((await loadPairedChild(child, key))?.hasPaired).toBe(true);
  expect(await loadChildContactPolicyCache(pair, key)).toEqual(view(20));
  const raw = await (await getDb()).get('pairedChild', child);
  expect(raw.contactPolicyCache).not.toContain('policy');
  await expect(loadChildContactPolicyCache(pair, 'wrong-key')).rejects.toThrow();
});
it('rejects an old pairing after replacement and refuses corrupt cache rollback', async () => {
  const pair = (await loadPairedChild(child, key))!;
  const db = await getDb(), raw = await db.get('pairedChild', child);
  await db.put('pairedChild', { ...raw, contactPolicyCache: 'broken' });
  await expect(saveChildContactPolicyCache(pair, key, view(20))).rejects.toThrow();
  await savePairedChild({ ...setup, clientKeypair: { publicKey: '6'.repeat(64), privateKey: '7'.repeat(64) } }, key);
  await expect(saveChildContactPolicyCache(pair, key, view(20))).rejects.toThrow('pairing changed');
  await expect(loadChildContactPolicyCache(pair, key)).rejects.toThrow('pairing changed');
});
