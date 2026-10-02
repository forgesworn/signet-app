import { beforeEach, describe, expect, it, vi } from 'vitest';
// At-rest encryption cost (600k PBKDF2) is not under test; a key-bound
// reversible stand-in keeps "wrong key reads nothing" without the runtime.
vi.mock('./crypto-store', async original => ({ ...await original<typeof import('./crypto-store')>(),
  encryptSecret: async (plaintext: string, key: string) => `test:${btoa(key)}:${btoa(plaintext)}`,
  decryptSecret: async (encrypted: string, key: string) => {
    const [, bound, body] = encrypted.split(':');
    if (bound !== btoa(key)) throw new Error('wrong key');
    return atob(body);
  } }));
import { createVaultPubkeyStore } from './vault-pubkey-cache';
import { deleteHeartwoodVaultPubkeys, getAllIdentities, cleanupUnencryptedIdentities, purgeAllUserData, loadHeartwoodVaultPubkeys } from './db';

const MASTER = 'aa'.repeat(32);
const OTHER_MASTER = 'bb'.repeat(32);
const VAULT = 'cc'.repeat(32);
const KEY = 'signet:vault:profiles:0';

describe('createVaultPubkeyStore', () => {
  beforeEach(async () => { await deleteHeartwoodVaultPubkeys(); });

  it('persists a resolved pubkey across stores (unlocks) under the same key', async () => {
    await createVaultPubkeyStore('unlock').put(MASTER, KEY, VAULT);
    expect(await createVaultPubkeyStore('unlock').get(MASTER, KEY)).toBe(VAULT);
    // Encrypted at rest: another unlock key reads nothing.
    expect(await createVaultPubkeyStore('other-key').get(MASTER, KEY)).toBeNull();
  });

  it('misses under a different master, and a write under it replaces the row', async () => {
    const store = createVaultPubkeyStore('unlock');
    await store.put(MASTER, KEY, VAULT);
    expect(await store.get(OTHER_MASTER, KEY)).toBeNull();
    await store.put(OTHER_MASTER, 'signet:vault:settings:0', 'dd'.repeat(32));
    const fresh = createVaultPubkeyStore('unlock');
    expect(await fresh.get(MASTER, KEY)).toBeNull();
    expect(await fresh.get(OTHER_MASTER, 'signet:vault:settings:0')).toBe('dd'.repeat(32));
  });

  it('drop removes one entry; concurrent puts both land', async () => {
    const store = createVaultPubkeyStore('unlock');
    await Promise.all([store.put(MASTER, KEY, VAULT), store.put(MASTER, 'signet:vault:settings:0', 'dd'.repeat(32))]);
    await store.drop(MASTER, KEY);
    const row = await loadHeartwoodVaultPubkeys('unlock');
    expect(row).toEqual({ masterPubkey: MASTER, entries: { 'signet:vault:settings:0': 'dd'.repeat(32) } });
  });

  it('never stores a malformed pubkey', async () => {
    const store = createVaultPubkeyStore('unlock');
    await store.put(MASTER, KEY, 'not-hex');
    expect(await createVaultPubkeyStore('unlock').get(MASTER, KEY)).toBeNull();
  });

  it('is not an identity row, survives unencrypted-row cleanup, and is cleared by purgeAllUserData', async () => {
    await createVaultPubkeyStore('unlock').put(MASTER, KEY, VAULT);
    expect((await getAllIdentities()).map(r => r.id)).not.toContain('heartwoodVaultPubkeys');
    await cleanupUnencryptedIdentities();
    expect(await loadHeartwoodVaultPubkeys('unlock')).not.toBeNull();
    await purgeAllUserData();
    expect(await loadHeartwoodVaultPubkeys('unlock')).toBeNull();
  });
});
