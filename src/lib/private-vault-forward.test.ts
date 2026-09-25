import { beforeEach, expect, it, vi } from 'vitest';
import type { NostrEvent } from 'signet-protocol';
const mocks = vi.hoisted(() => ({ reader: vi.fn(), flush: vi.fn() }));
vi.mock('./private-vault', async original => ({ ...await original<typeof import('./private-vault')>(), relayVaultReader: mocks.reader }));
vi.mock('./private-vault-publish', () => ({ flushVaultBackup: mocks.flush }));
import { checkVaultForwarding, resumeVaultForwarding } from './private-vault-forward';
import { localVaultBackend, prepareVaultSnapshot } from './private-vault';
import { queueVaultBackup } from './private-vault-store';
import { openVaultPayload } from './vault-envelope';
import { LocalSigningBackend } from './signing-backend';
import { purgeAllUserData } from './db';
const words = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const events = new Map<string, NostrEvent>();
beforeEach(async () => {
  await purgeAllUserData(); vi.clearAllMocks(); events.clear();
  mocks.reader.mockImplementation((_relays, backend) => ({
    checkpoints: async (author: string) => [...events.values()].filter(event => event.pubkey === author),
    chunk: async (id: string) => events.get(id) ?? null,
    open: (content: string, author: string) => openVaultPayload(content, backend, author, { legacyFallback: false }),
  }));
});
async function setup(nextRotation?: number) {
  const backend = localVaultBackend(words, 'profiles'), target = localVaultBackend(words, 'profiles', 1);
  const device = new LocalSigningBackend('06'.repeat(32));
  const source = await prepareVaultSnapshot({ plaintext: '{"v":1}', dataset: 'profiles', rotation: 0, sequence: 2,
    createdAt: 1800000000, vault: backend, device, nextRotation: 1 });
  const copy = await prepareVaultSnapshot({ plaintext: '{"v":1}', dataset: 'profiles', rotation: 1, sequence: 1,
    createdAt: 1800000000, vault: target, device, nextRotation });
  const options = { backend, dataset: 'profiles' as const, from: 0, to: 1, key: 'unlock-key',
    relays: { read: ['wss://read.example'], write: ['wss://write.example'] }, devicePubkey: device.activePublicKeyHex,
    resolve: async (rotation: number) => localVaultBackend(words, 'profiles', rotation), isCurrent: () => true, now: 1800000000 };
  target.destroy(); device.destroy();
  await queueVaultBackup(backend.activePublicKeyHex, options.key, source);
  for (const event of [copy.checkpoint, ...copy.chunks]) events.set(event.id, event);
  return { options, source, copy };
}
it('publishes only after the full prospective chain validates with real crypto', async () => {
  const { options, source } = await setup();
  expect(await checkVaultForwarding(options, source)).toBe(true);
  expect(mocks.flush).not.toHaveBeenCalled();
  mocks.flush.mockResolvedValue({ state: 'verified' });
  expect(await resumeVaultForwarding(options)).toBe(true);
  expect(mocks.flush).toHaveBeenCalledOnce();
  options.backend.destroy();
});
it('does not publish for a missing chunk, missing later rotation, or offline source history', async () => {
  const first = await setup(); events.delete(first.copy.chunks[0].id);
  expect(await resumeVaultForwarding(first.options)).toBe(false);
  first.options.backend.destroy();
  await purgeAllUserData(); events.clear();
  const later = await setup(2);
  expect(await resumeVaultForwarding(later.options)).toBe(false);
  mocks.reader.mockImplementation(() => ({ checkpoints: async () => { throw new Error('offline'); }, chunk: async () => null, open: async () => null }));
  expect(await resumeVaultForwarding(later.options)).toBe(false);
  expect(mocks.flush).not.toHaveBeenCalled();
  later.options.backend.destroy();
});
it('does not publish after locking, or over a newer source checkpoint that would hide the pointer', async () => {
  const { options } = await setup();
  expect(await resumeVaultForwarding({ ...options, isCurrent: () => false })).toBe(false);
  const device = new LocalSigningBackend('06'.repeat(32));
  const newer = await prepareVaultSnapshot({ plaintext: '{"v":2}', dataset: 'profiles', rotation: 0, sequence: 3,
    createdAt: 1800000001, vault: options.backend, device });
  for (const event of [newer.checkpoint, ...newer.chunks]) events.set(event.id, event);
  expect(await resumeVaultForwarding(options)).toBe(false);
  expect(mocks.flush).not.toHaveBeenCalled();
  options.backend.destroy(); device.destroy();
});
