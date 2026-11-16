import {describe, expect, it} from 'vitest';
import {fromMnemonic, derivePersona} from 'nsec-tree';
import {bytesToHex} from '@noble/hashes/utils.js';
import {finalizeEvent, getPublicKey, verifyEvent} from 'nostr-tools/pure';
import {createAccountCollection, inspectAccountCollection, restoreAccountCollection} from './wrapped-account-collection';

const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
function ownerFor(words = mnemonic) {
  const root = fromMnemonic(words);
  const np = derivePersona(root, 'natural-person');
  try { return {mnemonic: words, naturalPerson: {publicKey: bytesToHex(np.identity.publicKey)}}; }
  finally { np.identity.privateKey.fill(0); root.destroy(); }
}
const owner = ownerFor();
const slots = Array.from({length: 10}, (_, i) => {
  const key = new Uint8Array(32).fill(i + 1);
  return {displayName: `Account ${i + 1}`, privateKey: bytesToHex(key), publicKey: getPublicKey(key), imported: true};
});

describe('root-backed account collection', () => {
  it('recovers ten exact unrelated accounts in a fresh root and signs offline with every key', async () => {
    const file = await createAccountCollection(owner, slots);
    expect(new TextDecoder().decode(file.subarray(0, 8))).toBe('FSWNENC2');
    expect(file.length).toBe(65_608);
    const text = new TextDecoder().decode(file);
    expect(text).not.toContain('Account 1');
    for (const slot of slots) expect(text).not.toContain(slot.publicKey);
    const inventory = await inspectAccountCollection(ownerFor(), file);
    expect(inventory.accounts).toHaveLength(10);
    expect(inventory.createdAt).toBeGreaterThan(0);
    const restored = await restoreAccountCollection(ownerFor(), file, inventory.accounts.map(a => a.npub));
    try {
      expect(restored).toHaveLength(10);
      restored.forEach((account, i) => {
        expect(bytesToHex(account.privateKey)).toBe(slots[i].privateKey);
        expect(bytesToHex(account.publicKey)).toBe(slots[i].publicKey);
        const event = finalizeEvent({kind: 1, created_at: 1, tags: [], content: 'offline recovery check'}, account.privateKey);
        expect(verifyEvent(event)).toBe(true);
        expect(event.pubkey).toBe(slots[i].publicKey);
      });
    } finally { restored.forEach(a => a.privateKey.fill(0)); }
    const selected = await restoreAccountCollection(owner, file, [inventory.accounts[9].npub, inventory.accounts[2].npub]);
    try { expect(selected.map(a => a.name)).toEqual(['Account 3', 'Account 10']); }
    finally { selected.forEach(a => a.privateKey.fill(0)); }
  });

  it('refuses wrong roots, damaged or oversized files and unknown or duplicate selections', async () => {
    const file = await createAccountCollection(owner, slots);
    const other = ownerFor('legal winner thank year wave sausage worth useful legal winner thank yellow');
    await expect(inspectAccountCollection(other, file)).rejects.toThrow();
    for (const at of [0, 8, 24, 56, file.length - 1]) {
      const damaged = file.slice(); damaged[at] ^= 1;
      await expect(inspectAccountCollection(owner, damaged)).rejects.toThrow();
    }
    await expect(inspectAccountCollection(owner, file.subarray(0, -1))).rejects.toThrow();
    await expect(inspectAccountCollection(owner, new Uint8Array(200_000))).rejects.toThrow();
    const {accounts} = await inspectAccountCollection(owner, file);
    await expect(restoreAccountCollection(owner, file, [])).rejects.toThrow();
    await expect(restoreAccountCollection(owner, file, [accounts[0].npub, accounts[0].npub])).rejects.toThrow();
    await expect(restoreAccountCollection(owner, file, ['npub1unknown'])).rejects.toThrow();
  });

  it('refuses duplicates, mixed custody and invalid accounts rather than silently omitting them', async () => {
    for (const entries of [[], [slots[0], slots[0]], Array(101).fill(slots[0]),
      [{...slots[0], imported: false}], [{...slots[0], heartwoodKey: true}],
      [{...slots[0], publicKey: slots[1].publicKey}], [{...slots[0], displayName: 'x'.repeat(101)}]]) {
      await expect(createAccountCollection(owner, entries)).rejects.toThrow();
    }
    await expect(createAccountCollection({...owner, mnemonic: ''}, slots)).rejects.toThrow();
    await expect(createAccountCollection({...owner, naturalPerson: {publicKey: slots[0].publicKey}}, slots)).rejects.toThrow();
  });
});
