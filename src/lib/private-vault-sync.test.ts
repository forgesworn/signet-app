import { beforeEach, expect, it, vi } from 'vitest';
const remote = vi.hoisted(() => vi.fn());
const flush = vi.hoisted(() => vi.fn());
vi.mock('signet-protocol/experimental', async original => ({ ...await original<typeof import('signet-protocol/experimental')>(), readVaultHeadRotations: remote }));
vi.mock('./private-vault-publish', () => ({ flushVaultBackup: flush }));
import { syncPrivateVaultDataset } from './private-vault-sync';
import { loadVaultBackup } from './private-vault-store';
import { localVaultBackend } from './private-vault';
import { purgeAllUserData } from './db';
import { beginVaultRotation, loadVaultRotation, advanceVaultRotation, loadSeenVaultRotation } from './private-vault-rotation-store';
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
beforeEach(async () => { await purgeAllUserData(); vi.clearAllMocks(); });
function setup() {
  const backend = localVaultBackend(WORDS, 'profiles');
  const args = { adapter: { dataset: 'profiles' as const, snapshot: vi.fn(async () => '{"v":1}'), merge: vi.fn(async () => {}) },
    ownerPubkey: 'a'.repeat(64), encryptionKey: 'unlock', relays: { read: [], write: [] },
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
