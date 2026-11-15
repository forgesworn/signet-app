import { describe, expect, it } from 'vitest';
import { fromMnemonic, derivePersona } from 'nsec-tree';
import { bytesToHex } from '@noble/hashes/utils.js';
import { getPublicKey } from 'nostr-tools/pure';
import { createWrappedPersonaBackup, restoreWrappedPersonaBackup, verifyWrappedPersonaBackup } from './wrapped-persona-backup';

const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const root = fromMnemonic(mnemonic);
const np = derivePersona(root, 'natural-person');
const naturalPerson = {publicKey: bytesToHex(np.identity.publicKey)};
np.identity.privateKey.fill(0); root.destroy();
const owner = {mnemonic, naturalPerson};
const privateKey = '22'.repeat(32);
const extra = {privateKey, publicKey: getPublicKey(Buffer.from(privateKey, 'hex')), imported: true, heartwoodKey: false};

describe('owner wrapped persona backup', () => {
  it('restores the exact imported key and checks a selected backup against its account', async () => {
    const record = await createWrappedPersonaBackup(owner, extra);
    const restored = await restoreWrappedPersonaBackup(owner, record);
    try {
      expect(bytesToHex(restored.privateKey)).toBe(privateKey);
      expect(bytesToHex(restored.publicKey)).toBe(extra.publicKey);
      expect(await verifyWrappedPersonaBackup(owner, extra.publicKey, record)).toBe(restored.npub);
    } finally { restored.privateKey.fill(0); }
    await expect(verifyWrappedPersonaBackup(owner, naturalPerson.publicKey, record)).rejects.toThrow(/identity/);
  });

  it('refuses absent/mismatched local roots and derived or hardware slots', async () => {
    await expect(createWrappedPersonaBackup({...owner, mnemonic: ''}, extra)).rejects.toThrow(/local/);
    await expect(createWrappedPersonaBackup({...owner, naturalPerson: {publicKey: extra.publicKey}}, extra)).rejects.toThrow(/match/);
    await expect(createWrappedPersonaBackup(owner, {...extra, imported: false})).rejects.toThrow(/imported/);
    await expect(createWrappedPersonaBackup(owner, {...extra, heartwoodKey: true})).rejects.toThrow(/imported/);
    await expect(createWrappedPersonaBackup(owner, {...extra, privateKey: ''})).rejects.toThrow(/imported/);
    await expect(createWrappedPersonaBackup(owner, {...extra, publicKey: naturalPerson.publicKey})).rejects.toThrow(/match/);
  });

  it('refuses a corrupt file before returning key material', async () => {
    const record = await createWrappedPersonaBackup(owner, extra);
    await expect(restoreWrappedPersonaBackup(owner, record.slice(0, -2) + 'xx')).rejects.toThrow();
  });
});
