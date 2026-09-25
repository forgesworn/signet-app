import { beforeEach, expect, it, vi } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import { botRegistrySnapshot, createBot, loadBotRegistry, mergeBotRegistry, parseBotRegistry, updateBotRegistry } from './bot-registry';
import { getDb, purgeAllUserData } from './db';
const root = 'a'.repeat(64), owner = 'b'.repeat(64), key = 'bot registry test';
const args = { root, encryptionKey: key, ownerPersona: owner, ownedPersonas: [owner], label: 'Helper', now: 100, isCurrent: () => true };
beforeEach(async () => { await purgeAllUserData(); });
it('stores standalone keys encrypted, omits them from profiles, and preserves them across metadata restore', async () => {
  const bot = await createBot({ ...args, source: 'generated' });
  const stored = await loadBotRegistry(root, key), snapshot = botRegistrySnapshot(stored);
  expect(bot.privateKey).toHaveLength(64);
  expect(JSON.stringify(await (await getDb()).getAll('privateVaultState'))).not.toContain(bot.privateKey);
  expect(JSON.stringify(snapshot)).not.toContain(bot.privateKey);
  snapshot.bots[0].label = 'Renamed'; snapshot.bots[0].updatedAt = 101;
  expect(mergeBotRegistry(stored, snapshot).bots[0]).toMatchObject({ label: 'Renamed', privateKey: bot.privateKey });
  expect(() => mergeBotRegistry(snapshot, stored)).toThrow('signing keys');
  const empty = { ...snapshot, bots: [] };
  expect(mergeBotRegistry(empty, snapshot).bots[0].privateKey).toBeUndefined();
});
it('reserves failed derivations forever and independently allocates concurrent requests', async () => {
  const deriveRegistered = vi.fn(async (name: string) => {
    if (name === 'bot-0') throw new Error('Signer refused');
    return getPublicKey(hexToBytes(name === 'bot-1' ? '01'.repeat(32) : '02'.repeat(32)));
  });
  await expect(createBot({ ...args, source: 'derived', deriveRegistered })).rejects.toThrow('refused');
  const bots = await Promise.all([createBot({ ...args, source: 'derived', deriveRegistered }), createBot({ ...args, source: 'derived', deriveRegistered })]);
  expect(new Set(bots.map(b => b.derivationName))).toEqual(new Set(['bot-1', 'bot-2']));
  expect((await loadBotRegistry(root, key)).allocated).toEqual(['bot-0', 'bot-1', 'bot-2']);
  expect(bots.every(b => b.privateKey === undefined)).toBe(true);
});
it('keeps removals, fails conflicting ownership, and never accepts root ownership or duplicate local keys', async () => {
  await expect(createBot({ ...args, ownerPersona: root, ownedPersonas: [root], source: 'generated' })).rejects.toThrow('owned persona');
  const bot = await createBot({ ...args, source: 'imported', importedKey: '01'.repeat(32) });
  await expect(createBot({ ...args, source: 'imported', importedKey: '01'.repeat(32) })).rejects.toThrow('already');
  const local = await loadBotRegistry(root, key), remote = botRegistrySnapshot(local);
  local.bots[0].removedAt = 110; remote.bots[0].updatedAt = 120;
  expect(mergeBotRegistry(local, remote).bots[0].removedAt).toBe(110);
  remote.bots[0].ownerPersona = 'c'.repeat(64);
  expect(() => mergeBotRegistry(local, remote)).toThrow('Conflicting');
  local.bots[0].privateKey = '02'.repeat(32);
  expect(() => parseBotRegistry(JSON.stringify(local), root)).toThrow('mismatch');
  expect(bot.publicKey).toBe(getPublicKey(hexToBytes('01'.repeat(32))));
});
it('applies show-new only at creation and fails closed if the session changes during derivation', async () => {
  await updateBotRegistry(root, key, s => ({ ...s, showNew: false, preferenceUpdatedAt: 1 }));
  const first = await createBot({ ...args, source: 'generated' });
  expect(first.hidden).toBe(true);
  let current = true;
  await expect(createBot({ ...args, source: 'derived', isCurrent: () => current, deriveRegistered: async () => {
    current = false; return getPublicKey(hexToBytes('03'.repeat(32)));
  } })).rejects.toThrow('session changed');
  const state = await loadBotRegistry(root, key);
  expect(state.allocated).toEqual(['bot-0']);
  expect(state.bots).toHaveLength(1);
});
it('reattaches an imported backup to a restored standalone bot without changing its origin or owner', async () => {
  const bot = await createBot({ ...args, source: 'generated' });
  await updateBotRegistry(root, key, botRegistrySnapshot);
  const restored = await createBot({ ...args, source: 'imported', importedKey: bot.privateKey, label: 'Ignored replacement name', now: 200 });
  expect(restored).toEqual(bot);
});
