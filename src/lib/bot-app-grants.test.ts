import { beforeEach, expect, it, vi } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import { approveBotAppGrant, loadBotAppGrants, revokeBotAppGrant, signWithBotAppGrant, type BotAppGrant } from './bot-app-grants';
import { createBot, updateBotRegistry } from './bot-registry';
import { getDb, purgeAllUserData } from './db';
import { LocalSigningBackend } from './signing-backend';
import { updateEncryptedPrivateState } from './private-vault-store';
const root = 'a'.repeat(64), key = 'bot app consent test', secret = '01'.repeat(32);
const botPubkey = getPublicKey(new Uint8Array(32).fill(1)), clientPubkey = 'c'.repeat(64);
let active = true, now = 100;
const session = () => ({ root, encryptionKey: key, isCurrent: () => active, now: () => now });
const grant = (id = 'd'.repeat(32)): BotAppGrant => ({ id, botPubkey, clientPubkey, appName: 'Private bot app', relayUrl: 'wss://relay.test', eventKinds: [1], createdAt: 100, expiresAt: 200 });
const event = () => ({ pubkey: botPubkey, kind: 1, created_at: 100, content: 'Bot note', tags: [] });
const sign = (overrides: Partial<Parameters<typeof signWithBotAppGrant>[0]> = {}) => signWithBotAppGrant({ ...session(),
  grantId: grant().id, botPubkey, clientPubkey, event: event(), signer: async () => new LocalSigningBackend(secret), ...overrides });
beforeEach(async () => {
  await purgeAllUserData(); active = true; now = 100;
  await createBot({ root, encryptionKey: key, isCurrent: () => true, ownerPersona: 'b'.repeat(64), ownedPersonas: ['b'.repeat(64)],
    label: 'Helper', source: 'imported', importedKey: secret, now });
});
it('stores explicit consent encrypted and signs only the granted bot, client and event kind', async () => {
  const signer = vi.fn(async () => new LocalSigningBackend(secret));
  await expect(sign({ signer })).rejects.toThrow('not authorised'); expect(signer).not.toHaveBeenCalled();
  await approveBotAppGrant({ ...session(), grant: grant() });
  const rows = JSON.stringify(await (await getDb()).getAll('privateVaultState'));
  expect(rows).not.toContain('Private bot app'); expect(rows).not.toContain(clientPubkey);
  expect((await sign()).pubkey).toBe(botPubkey);
  for (const overrides of [{ clientPubkey: 'e'.repeat(64) }, { botPubkey: root }, { event: { ...event(), pubkey: root } },
    { event: { ...event(), kind: 0 } }, { grantId: 'e'.repeat(32) }]) {
    await expect(sign({ ...overrides, signer })).rejects.toThrow('not authorised');
  }
  expect(signer).not.toHaveBeenCalled();
});
it('retains revocations and never recycles an expired or revoked consent ID', async () => {
  await approveBotAppGrant({ ...session(), grant: grant() });
  await revokeBotAppGrant({ ...session(), grantId: grant().id });
  await expect(sign()).rejects.toThrow('not authorised');
  await expect(approveBotAppGrant({ ...session(), grant: grant() })).rejects.toThrow('already exists');
  expect((await loadBotAppGrants(root, key))[0].revokedAt).toBe(100);
  await approveBotAppGrant({ ...session(), grant: grant('e'.repeat(32)) });
  now = 200; await expect(sign({ grantId: 'e'.repeat(32) })).rejects.toThrow('not authorised');
});
it('discards an in-flight signature revoked while the hardware signer is awaiting approval', async () => {
  await approveBotAppGrant({ ...session(), grant: grant() });
  const backend = new LocalSigningBackend(secret), original = backend.signEvent.bind(backend), destroy = vi.spyOn(backend, 'destroy');
  vi.spyOn(backend, 'signEvent').mockImplementation(async template => {
    const signed = await original(template); await revokeBotAppGrant({ ...session(), grantId: grant().id }); return signed;
  });
  await expect(sign({ signer: async () => backend })).rejects.toThrow('not authorised'); expect(destroy).toHaveBeenCalledOnce();
});
it('refuses removed bots, locked sessions and signed templates changed by a backend', async () => {
  await approveBotAppGrant({ ...session(), grant: grant() });
  const backend = new LocalSigningBackend(secret), original = backend.signEvent.bind(backend);
  vi.spyOn(backend, 'signEvent').mockImplementation(template => original({ ...template, kind: 0 }));
  await expect(sign({ signer: async () => backend })).rejects.toThrow('Invalid bot app signature');
  active = false; await expect(sign()).rejects.toThrow('session changed'); active = true;
  await updateBotRegistry(root, key, state => ({ ...state, bots: state.bots.map(bot => ({ ...bot, removedAt: 100 })) }));
  await expect(sign()).rejects.toThrow('not authorised');
});
it('validates consent bounds and does not broaden an existing consent through reapproval', async () => {
  for (const invalid of [{ eventKinds: [] }, { eventKinds: [1, 1] }, { expiresAt: 100 + 31 * 86400 }, { eventKinds: [1.5] }]) {
    await expect(approveBotAppGrant({ ...session(), grant: { ...grant(), ...invalid } })).rejects.toThrow('Invalid bot app grant');
  }
  await approveBotAppGrant({ ...session(), grant: grant() });
  await expect(approveBotAppGrant({ ...session(), grant: { ...grant(), eventKinds: [1, 0] } })).rejects.toThrow('already exists');
  expect((await loadBotAppGrants(root, key))[0].eventKinds).toEqual([1]);
});
it('checks consent again at the storage commit boundary after encryption', async () => {
  const id = 'test:bot-consent-commit';
  await expect(updateEncryptedPrivateState(id, key, () => ({ consent: true }), () => { throw new Error('Session locked'); })).rejects.toThrow('Session locked');
  expect(await (await getDb()).get('privateVaultState', id)).toBeUndefined();
});
it('replaces old consent without allowing its permissions to revive after revoking the replacement', async () => {
  await approveBotAppGrant({ ...session(), grant: grant() });
  const replacement = { ...grant('e'.repeat(32)), eventKinds: [0] };
  await approveBotAppGrant({ ...session(), grant: replacement });
  expect((await loadBotAppGrants(root, key)).find(g => g.id === grant().id)?.revokedAt).toBe(100);
  await revokeBotAppGrant({ ...session(), grantId: replacement.id });
  await expect(sign()).rejects.toThrow('not authorised');
  await expect(sign({ grantId: replacement.id, event: { ...event(), kind: 0 } })).rejects.toThrow('not authorised');
});
