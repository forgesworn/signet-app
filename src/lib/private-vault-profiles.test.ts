import { beforeEach, expect, it } from 'vitest';
import { createNewIdentity } from './signet';
import { profilesVaultAdapter } from './private-vault-profiles';
import { purgeAllUserData, saveIdentityEncrypted, loadIdentityDecrypted } from './db';
const KEY = 'profile vault test unlock';
beforeEach(async () => { await purgeAllUserData(); });
it('backs up profile metadata without root or identity secrets and restores a newer default name', async () => {
  const identity = createNewIdentity('Owner', 'persona', false);
  identity.persona.displayName = 'Before';
  identity.persona.displayNameUpdatedAt = 1;
  await saveIdentityEncrypted(identity, KEY);
  const adapter = profilesVaultAdapter({ identityId: identity.id, ownerPubkey: identity.naturalPerson.publicKey,
    encryptionKey: KEY, mnemonic: identity.mnemonic, deviceHeldKeys: false, isCurrent: () => true });
  const raw = await adapter.snapshot();
  expect(raw).not.toContain(identity.mnemonic);
  expect(raw).not.toContain(identity.naturalPerson.privateKey);
  expect(raw).not.toContain(identity.persona.privateKey);
  const value = JSON.parse(raw);
  value.persona.displayName = 'After'; value.persona.updatedAt = 2;
  await adapter.merge(JSON.stringify(value), 1700000000);
  const restored = await loadIdentityDecrypted(identity.id, KEY);
  expect(restored?.persona.displayName).toBe('After');
  expect(restored?.persona.privateKey).toBe(identity.persona.privateKey);
  value.persona.displayName = 'Stale'; value.persona.updatedAt = 1;
  await adapter.merge(JSON.stringify(value), 1700000001);
  expect((await loadIdentityDecrypted(identity.id, KEY))?.persona.displayName).toBe('After');
});
it('refuses a mismatched default persona before changing local data', async () => {
  const identity = createNewIdentity('Owner', 'persona', false);
  await saveIdentityEncrypted(identity, KEY);
  const adapter = profilesVaultAdapter({ identityId: identity.id, ownerPubkey: identity.naturalPerson.publicKey,
    encryptionKey: KEY, mnemonic: identity.mnemonic, deviceHeldKeys: false, isCurrent: () => true });
  const value = JSON.parse(await adapter.snapshot());
  value.persona.publicKey = 'f'.repeat(64);
  await expect(adapter.merge(JSON.stringify(value), 1700000000)).rejects.toThrow('default persona');
  expect((await loadIdentityDecrypted(identity.id, KEY))?.persona.publicKey).toBe(identity.persona.publicKey);
});

it('recovers bot metadata and spent derivation slots without backing up standalone bot keys', async () => {
  const { createBot, loadBotRegistry, updateBotRegistry } = await import('./bot-registry');
  const { deriveExtraPersonaPubkey } = await import('./signet');
  const identity = createNewIdentity('Owner', 'persona', false);
  await saveIdentityEncrypted(identity, KEY);
  const args = { root: identity.naturalPerson.publicKey, encryptionKey: KEY, ownerPersona: identity.persona.publicKey,
    ownedPersonas: [identity.persona.publicKey], label: 'Helper', now: 100, isCurrent: () => true };
  const derived = await createBot({ ...args, source: 'derived', deriveRegistered: async name => deriveExtraPersonaPubkey(identity.mnemonic, name) });
  const generated = await createBot({ ...args, source: 'generated' });
  const adapter = profilesVaultAdapter({ identityId: identity.id, ownerPubkey: args.root,
    encryptionKey: KEY, mnemonic: identity.mnemonic, deviceHeldKeys: false, isCurrent: () => true });
  const snapshot = await adapter.snapshot();
  expect(snapshot).not.toContain(generated.privateKey);
  await updateBotRegistry(args.root, KEY, state => ({ ...state, bots: [], allocated: [] }));
  await adapter.merge(snapshot, 101);
  const restored = await loadBotRegistry(args.root, KEY);
  expect(restored.allocated).toEqual(['bot-0']);
  expect(restored.bots.find(b => b.publicKey === derived.publicKey)?.derivationName).toBe('bot-0');
  expect(restored.bots.every(b => b.privateKey === undefined)).toBe(true);
  const invalid = JSON.parse(snapshot);
  invalid.bots.bots.find((b: { source: string }) => b.source === 'derived').publicKey = 'f'.repeat(64);
  await expect(adapter.merge(JSON.stringify(invalid), 102)).rejects.toThrow('recovery tree');
});
