import { beforeEach, expect, it, vi } from 'vitest';
const remote = vi.hoisted(() => vi.fn());
const flush = vi.hoisted(() => vi.fn());
vi.mock('signet-protocol/experimental', async original => ({ ...await original<typeof import('signet-protocol/experimental')>(), readVaultHeadRotations: remote }));
vi.mock('./private-vault-publish', () => ({ flushVaultBackup: flush }));
const readerSpy = vi.hoisted(() => vi.fn());
vi.mock('./private-vault', async original => {
  const real = await original<typeof import('./private-vault')>();
  return { ...real, relayVaultReader: (...a: Parameters<typeof real.relayVaultReader>) => { readerSpy(...a); return real.relayVaultReader(...a); } };
});
import { syncPrivateVaultDataset } from './private-vault-sync';
import { loadVaultBackup, queueVaultBackup, confirmVaultBackup } from './private-vault-store';
import { localVaultBackend, prepareVaultSnapshot } from './private-vault';
import { LocalSigningBackend } from './signing-backend';
import { purgeAllUserData } from './db';
import { beginVaultRotation, loadVaultRotation, advanceVaultRotation, loadSeenVaultRotation } from './private-vault-rotation-store';
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
beforeEach(async () => { await purgeAllUserData(); vi.clearAllMocks(); });
function setup() {
  const backend = localVaultBackend(WORDS, 'profiles');
  const args = { adapter: { dataset: 'profiles' as const, snapshot: vi.fn(async () => '{"v":1}'), merge: vi.fn(async () => {}) },
    ownerPubkey: 'a'.repeat(64), encryptionKey: 'unlock', relays: { read: [] as string[], write: [] as string[] },
    resolve: async () => backend, isCurrent: () => true, now: 1700000000 };
  return { args, backend };
}
it('persists the signed candidate before attempting a relay write', async () => {
  const { args, backend } = setup();
  remote.mockImplementation(async resolve => { await resolve(0); return { state: 'absent' }; });
  flush.mockImplementation(async () => {
    const stored = await loadVaultBackup(backend.activePublicKeyHex, args.encryptionKey);
    expect(stored.pending?.manifest.sequence).toBe(1);
    expect(stored.confirmed).toBeUndefined();
    return { state: 'pending', confirmedRelays: [] };
  });
  expect(await syncPrivateVaultDataset(args)).toMatchObject({ state: 'pending' });
  expect(args.adapter.merge).not.toHaveBeenCalled();
});
it('does not publish over a corrupt or unavailable checkpoint', async () => {
  for (const state of ['unusable', 'unavailable'] as const) {
    const { args } = setup();
    remote.mockImplementation(async resolve => { await resolve(0); return { state }; });
    expect(await syncPrivateVaultDataset(args)).toMatchObject({ state });
    expect(args.adapter.snapshot).not.toHaveBeenCalled();
  }
  expect(flush).not.toHaveBeenCalled();
});
it('stops before preparing or publishing when the session changes during restore', async () => {
  const { args } = setup();
  let current = true;
  remote.mockImplementation(async resolve => { await resolve(0); current = false; return { state: 'absent' }; });
  expect(await syncPrivateVaultDataset({ ...args, isCurrent: () => current })).toMatchObject({ state: 'cancelled' });
  expect(args.adapter.snapshot).not.toHaveBeenCalled();
  expect(flush).not.toHaveBeenCalled();
});

it('does not start a new migration before legacy reads complete', async () => {
  const { args } = setup();
  remote.mockImplementation(async resolve => { await resolve(0); return { state: 'absent' }; });
  expect(await syncPrivateVaultDataset({ ...args, allowInitialPublish: false })).toMatchObject({ state: 'waiting-legacy' });
  expect(args.adapter.snapshot).not.toHaveBeenCalled();
  expect(flush).not.toHaveBeenCalled();
});

it('passes this device\'s recorded rotation as a floor, so a relay withholding it cannot roll sync back to rotation 0', async () => {
  const { args } = setup();
  await beginVaultRotation(args.ownerPubkey, args.adapter.dataset, args.encryptionKey, 0, args.now);
  const intent = await loadVaultRotation(args.ownerPubkey, args.adapter.dataset, args.encryptionKey);
  await advanceVaultRotation(args.ownerPubkey, args.adapter.dataset, args.encryptionKey, intent!.id, { phase: 'complete' });
  let minRotationSeen: number | undefined;
  remote.mockImplementation(async (resolve: (rotation: number) => Promise<unknown>, _purpose: string, _now: number, minRotation: number) => {
    minRotationSeen = minRotation;
    await resolve(0);
    return { state: 'unusable', reason: 'rollback' };
  });
  expect(await syncPrivateVaultDataset(args)).toMatchObject({ state: 'unusable' });
  expect(minRotationSeen).toBe(1);
  expect(args.adapter.merge).not.toHaveBeenCalled();
  expect(args.adapter.snapshot).not.toHaveBeenCalled();
  expect(flush).not.toHaveBeenCalled();
});

it('passes minRotation 0 when this device has no recorded rotation', async () => {
  const { args } = setup();
  let minRotationSeen: number | undefined;
  remote.mockImplementation(async (resolve: (rotation: number) => Promise<unknown>, _purpose: string, _now: number, minRotation: number) => {
    minRotationSeen = minRotation;
    await resolve(0);
    return { state: 'absent' };
  });
  await syncPrivateVaultDataset(args);
  expect(minRotationSeen).toBe(0);
});

it('raises the high-water mark on a verified rotation-1 read, so a later relay withholding it cannot roll this device back to 0 even with no rotation intent recorded', async () => {
  const { args } = setup();
  remote.mockImplementationOnce(async (resolve: (rotation: number) => Promise<unknown>) => {
    await resolve(1);
    return { state: 'ready', snapshots: [{
      event: { created_at: args.now },
      checkpoint: { v: 1, purpose: 'signet:vault:profiles', rotation: 1, sequence: 1, revision: 'ignored', devicePubkeys: [], chunks: [] },
      plaintext: '{"v":1}',
    }] };
  });
  flush.mockImplementationOnce(async () => ({ state: 'verified', confirmedRelays: [] }));
  expect(await syncPrivateVaultDataset(args)).toMatchObject({ state: 'verified', rotation: 1 });
  expect(await loadSeenVaultRotation(args.ownerPubkey, args.adapter.dataset, args.encryptionKey)).toBe(1);
  expect(await loadVaultRotation(args.ownerPubkey, args.adapter.dataset, args.encryptionKey)).toBeNull();
  args.adapter.merge.mockClear();
  args.adapter.snapshot.mockClear();

  let minRotationSeen: number | undefined;
  remote.mockImplementationOnce(async (resolve: (rotation: number) => Promise<unknown>, _purpose: string, _now: number, minRotation: number) => {
    minRotationSeen = minRotation;
    await resolve(0);
    return { state: 'unusable', reason: 'rollback' };
  });
  expect(await syncPrivateVaultDataset(args)).toMatchObject({ state: 'unusable' });
  expect(minRotationSeen).toBe(1);
  expect(args.adapter.merge).not.toHaveBeenCalled();
  expect(args.adapter.snapshot).not.toHaveBeenCalled();
  expect(flush).toHaveBeenCalledTimes(1);
});
it('reads checkpoints from the relays it writes to, never from a read-only relay', async () => {
  const { args } = setup();
  args.relays = { read: ['wss://read-only.example', 'wss://both.example'], write: ['wss://both.example', 'wss://write-only.example'] };
  remote.mockImplementation(async resolve => { await resolve(0); return { state: 'absent' }; });
  flush.mockResolvedValue({ state: 'pending', confirmedRelays: [] });
  await syncPrivateVaultDataset(args);
  expect(readerSpy).toHaveBeenCalledTimes(1);
  expect(readerSpy.mock.calls[0][0]).toEqual(['wss://both.example', 'wss://write-only.example']);
});
it('names the relays that blocked an unavailable read', async () => {
  const { args } = setup();
  remote.mockResolvedValue({ state: 'unavailable', failedRelays: ['wss://relay.damus.io'] });
  expect(await syncPrivateVaultDataset(args)).toMatchObject({ state: 'unavailable', failedRelays: ['wss://relay.damus.io'] });
});
it('carries no failedRelays when the protocol names none, or when the failure is another error', async () => {
  const { args } = setup();
  remote.mockResolvedValue({ state: 'unavailable' });
  expect(await syncPrivateVaultDataset(args)).not.toHaveProperty('failedRelays');
  remote.mockRejectedValue(Object.assign(new Error('boom'), { failedRelays: ['wss://x.example'] }));
  const thrown = await syncPrivateVaultDataset(args);
  expect(thrown.state).toBe('unavailable');
  expect(thrown).not.toHaveProperty('failedRelays');
});
async function confirmCopyOn(args: ReturnType<typeof setup>['args'], backend: ReturnType<typeof setup>['backend'], relays: string[]) {
  const device = new LocalSigningBackend('06'.repeat(32));
  const prepared = await prepareVaultSnapshot({ plaintext: '{"v":1}', dataset: 'profiles', rotation: 0, sequence: 1,
    createdAt: 1700000000, vault: backend, device });
  device.destroy();
  await queueVaultBackup(backend.activePublicKeyHex, args.encryptionKey, prepared);
  await confirmVaultBackup(backend.activePublicKeyHex, args.encryptionKey, prepared.checkpoint.id, 1700000000, relays);
}
it('says which relays hold the stored confirmed copy when a read is unavailable', async () => {
  const { args, backend } = setup();
  await confirmCopyOn(args, backend, ['wss://relay.damus.io']);
  remote.mockImplementation(async resolve => { await resolve(0); return { state: 'unavailable', failedRelays: ['wss://relay.damus.io'] }; });
  expect(await syncPrivateVaultDataset(args)).toMatchObject({ state: 'unavailable', failedRelays: ['wss://relay.damus.io'],
    heldOn: ['wss://relay.damus.io'] });
});
it('reports no holding relays when this device has no confirmed copy', async () => {
  const { args } = setup();
  remote.mockImplementation(async resolve => { await resolve(0); return { state: 'unavailable', failedRelays: ['wss://relay.damus.io'] }; });
  expect(await syncPrivateVaultDataset(args)).not.toHaveProperty('heldOn');
});
