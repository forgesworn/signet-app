import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, purgeAllUserData } from './db';
import { localVaultBackend, prepareVaultSnapshot, relayVaultReader } from './private-vault';
import { loadVaultBackup, queueVaultBackup, vaultDeviceKey } from './private-vault-store';
import { flushVaultBackup } from './private-vault-publish';
import { LocalSigningBackend } from './signing-backend';
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const KEY = 'test vault unlock key';
beforeEach(async () => { await purgeAllUserData(); });

describe('durable private backup verification', () => {
  it('persists one encrypted device key per owner, including concurrent calls', async () => {
    const owner = 'a'.repeat(64);
    const [a, b] = await Promise.all([vaultDeviceKey(owner, KEY), vaultDeviceKey(owner, KEY)]);
    expect(a).toEqual(b);
    const row = await (await getDb()).get('privateVaultState', `device:${owner}`);
    expect(JSON.stringify(row)).not.toContain(a.privateKey);
    await expect(vaultDeviceKey(owner, 'wrong key')).rejects.toThrow();
  });
  it('keeps failed publishes for retry and marks canonical only after full readback', async () => {
    const vault = localVaultBackend(WORDS, 'profiles');
    const device = new LocalSigningBackend('02'.repeat(32));
    try {
      const prepared = await prepareVaultSnapshot({ plaintext: '{"v":1}', dataset: 'profiles', rotation: 0,
        sequence: 1, createdAt: 1700000000, vault, device });
      await queueVaultBackup(vault.activePublicKeyHex, KEY, prepared);
      const reader = { ...relayVaultReader([], vault), checkpoints: async () => [prepared.checkpoint],
        chunk: async (id: string) => prepared.chunks.find(c => c.id === id) ?? null };
      const publish = vi.fn(async () => false);
      const args = { backend: vault, encryptionKey: KEY, relays: ['wss://relay.example'], now: 1700000001,
        io: { publish, reader: () => reader } };
      expect((await flushVaultBackup(args)).state).toBe('pending');
      expect((await loadVaultBackup(vault.activePublicKeyHex, KEY)).confirmed).toBeUndefined();
      publish.mockResolvedValue(true);
      const incomplete = { ...reader, chunk: async () => null };
      expect((await flushVaultBackup({ ...args, io: { publish, reader: () => incomplete } })).state).toBe('pending');
      expect((await flushVaultBackup(args)).state).toBe('verified');
      const state = await loadVaultBackup(vault.activePublicKeyHex, KEY);
      expect(state.pending).toBeUndefined();
      expect(state.confirmed).toMatchObject({ eventId: prepared.checkpoint.id, relays: ['wss://relay.example'] });
      expect(publish.mock.calls.length).toBeGreaterThan(1);
      await purgeAllUserData();
      expect(await loadVaultBackup(vault.activePublicKeyHex, KEY)).toEqual({});
    } finally { vault.destroy(); device.destroy(); }
  });
});
