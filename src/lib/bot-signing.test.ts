import { beforeEach, expect, it, vi } from 'vitest';
import { getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import { loadIdentityDecrypted } from './db';
import { loadBotRegistry, type BotRegistry } from './bot-registry';
import { createBotSigningBackend } from './bot-signing';
import { LocalSigningBackend } from './signing-backend';
import { deriveExtraPersona } from './signet';
import type { SignetIdentity } from '../types';
vi.mock('./db', () => ({ loadIdentityDecrypted: vi.fn() }));
vi.mock('./bot-registry', () => ({ loadBotRegistry: vi.fn() }));
const root = 'a'.repeat(64), owner = 'b'.repeat(64), secret = '1'.repeat(64), botPubkey = getPublicKey(hexToBytes(secret));
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
let registry: BotRegistry;
let current: boolean;
const args = () => ({ identityId: root, ownerRoot: root, botPubkey, encryptionKey: 'test', mode: 'local' as const,
  isCurrent: () => current, routed: vi.fn(() => null) });
const event = (pubkey = botPubkey) => ({ pubkey, kind: 1, created_at: 1800000000, tags: [], content: 'Bot action' });
beforeEach(() => {
  current = true;
  registry = { v: 1, ownerRoot: root, allocated: [], showNew: true, preferenceUpdatedAt: 1,
    bots: [{ publicKey: botPubkey, ownerPersona: owner, source: 'generated', privateKey: secret, label: 'Helper', hidden: false, createdAt: 1, updatedAt: 1 }] };
  vi.mocked(loadIdentityDecrypted).mockResolvedValue({ naturalPerson: { publicKey: root }, persona: { publicKey: owner }, mnemonic } as SignetIdentity);
  vi.mocked(loadBotRegistry).mockImplementation(async () => structuredClone(registry));
});
it('signs and encrypts as a standalone bot even when its owner uses a hardware signer', async () => {
  const options = { ...args(), mode: 'bunker' as const }, backend = await createBotSigningBackend(options);
  const signed = await backend.signEvent(event());
  expect(signed.pubkey).toBe(botPubkey); expect(verifyEvent(signed)).toBe(true);
  expect(options.routed).not.toHaveBeenCalled();
  const peer = new LocalSigningBackend('2'.repeat(64));
  const encrypted = await backend.nip44Encrypt(peer.activePublicKeyHex, 'private bot message');
  expect(await peer.nip44Decrypt(botPubkey, encrypted)).toBe('private bot message');
  expect(await backend.nip44Decrypt(peer.activePublicKeyHex, await peer.nip44Encrypt(botPubkey, 'reply'))).toBe('reply');
  backend.destroy(); peer.destroy();
  await expect(backend.signEvent(event())).rejects.toThrow('session changed');
});
it('derives the registered bot path locally, and never uses that recovery tree as a hardware fallback', async () => {
  const key = deriveExtraPersona(mnemonic, 'bot-0').publicKey;
  registry.bots[0] = { ...registry.bots[0], publicKey: key, source: 'derived', derivationName: 'bot-0', privateKey: undefined };
  const local = await createBotSigningBackend({ ...args(), botPubkey: key });
  expect((await local.signEvent(event(key))).pubkey).toBe(key); local.destroy();
  const options = { ...args(), botPubkey: key, mode: 'bunker' as const };
  const remote = await createBotSigningBackend(options);
  await expect(remote.signEvent(event(key))).rejects.toThrow('Connect the signer for this bot');
  expect(options.routed).toHaveBeenCalledWith(key); remote.destroy();
});
it('refuses missing standalone secrets, another identity, removed bots and an unavailable owner persona', async () => {
  const backend = await createBotSigningBackend(args());
  await expect(backend.signEvent(event(root))).rejects.toThrow('different bot');
  registry.bots[0].removedAt = 2;
  await expect(backend.signEvent(event())).rejects.toThrow('not owned');
  delete registry.bots[0].removedAt; delete registry.bots[0].privateKey;
  const restored = await createBotSigningBackend(args());
  await expect(restored.signEvent(event())).rejects.toThrow('not stored');
  registry.bots[0].ownerPersona = root;
  await expect(createBotSigningBackend(args())).rejects.toThrow('not owned');
});
it('rejects an owner-key route before signing and withholds a delayed result after bot removal', async () => {
  registry.bots[0] = { ...registry.bots[0], source: 'derived', derivationName: 'bot-0', privateKey: undefined };
  const wrong = new LocalSigningBackend('2'.repeat(64)), spy = vi.spyOn(wrong, 'signEvent');
  const options = { ...args(), mode: 'bunker' as const, routed: () => wrong };
  const backend = await createBotSigningBackend(options);
  await expect(backend.signEvent(event())).rejects.toThrow('does not match'); expect(spy).not.toHaveBeenCalled();
  const right = new LocalSigningBackend(secret), original = right.signEvent.bind(right);
  vi.spyOn(right, 'signEvent').mockImplementation(async template => { const signed = await original(template); registry.bots[0].removedAt = 2; return signed; });
  const routed = await createBotSigningBackend({ ...options, routed: () => right });
  await expect(routed.signEvent(event())).rejects.toThrow('not owned');
  wrong.destroy(); right.destroy();
});
it('rejects a signer changing the event or the observing session during signing', async () => {
  registry.bots[0] = { ...registry.bots[0], source: 'derived', derivationName: 'bot-0', privateKey: undefined };
  const right = new LocalSigningBackend(secret), original = right.signEvent.bind(right);
  const sign = vi.spyOn(right, 'signEvent').mockImplementation(template => original({ ...template, content: 'different' }));
  const backend = await createBotSigningBackend({ ...args(), mode: 'bunker', routed: () => right });
  await expect(backend.signEvent(event())).rejects.toThrow('different or invalid');
  sign.mockImplementation(async template => { const signed = await original(template); verifyEvent(signed); return { ...signed, sig: '0'.repeat(128) }; });
  await expect(backend.signEvent(event())).rejects.toThrow('different or invalid');
  sign.mockImplementation(async template => { const signed = await original(template); current = false; return signed; });
  await expect(backend.signEvent(event())).rejects.toThrow('session changed'); right.destroy();
});
