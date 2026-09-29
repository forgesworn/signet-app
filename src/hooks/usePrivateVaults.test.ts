// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const sync = vi.hoisted(() => vi.fn());
vi.mock('../lib/private-vault-sync', () => ({ syncPrivateVaultDataset: sync }));
import { usePrivateVaults, legacyVaultWriteAllowed } from './usePrivateVaults';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
const job = { adapter: { dataset: 'profiles' as const, snapshot: async () => '{}', merge: async () => {} },
  resolve: async () => ({} as DecryptingSigningBackend) };
const opts = () => ({ sessionKey: 'owner', ownerPubkey: 'a'.repeat(64), encryptionKey: 'unlock', supported: true,
  ready: true, changeToken: '', relays: { read: [], write: [] }, jobs: async () => [job], onMerged: vi.fn() });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
it('retries without another edit and never re-enables legacy writes after verification', async () => {
  vi.useFakeTimers();
  sync.mockResolvedValueOnce({ state: 'pending', canonical: false })
    .mockResolvedValueOnce({ state: 'verified', canonical: true })
    .mockResolvedValue({ state: 'unavailable', canonical: false });
  const { result, unmount } = renderHook(() => usePrivateVaults(opts()));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(legacyVaultWriteAllowed(result.current, 'profiles')).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(legacyVaultWriteAllowed(result.current, 'profiles')).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(result.current.datasets['signet:vault:profiles'].state).toBe('unavailable');
  expect(result.current.datasets['signet:vault:profiles'].canonical).toBe(true);
  expect(legacyVaultWriteAllowed(result.current, 'profiles')).toBe(false);
  unmount();
});
it('does not apply late cycle callbacks after unmount or start work without a recovery tree', async () => {
  vi.useFakeTimers();
  const options = opts();
  let finish!: (value: unknown) => void;
  sync.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const mounted = renderHook(() => usePrivateVaults(options));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  mounted.unmount();
  await act(async () => { finish({ state: 'verified', canonical: true }); });
  expect(options.onMerged).not.toHaveBeenCalled();
  sync.mockClear();
  const unsupported = renderHook(() => usePrivateVaults({ ...options, supported: false }));
  expect(unsupported.result.current.phase).toBe('unsupported');
  expect(sync).not.toHaveBeenCalled();
  unsupported.unmount();
});

// ── Refusal vs transport failure ─────────────────────────────────────────────
// private-vault-sync swallows errors into a dataset state; the hook sees the
// kind of failure through the backend/resolve it hands out.
import { VaultApprovalError } from '../lib/vault-approval';

function failingJob(error: () => Error) {
  return { adapter: job.adapter, resolve: async () => { throw error(); } };
}
const callsResolve = async (args: { resolve(rotation: number): Promise<unknown> }) => {
  try { await args.resolve(0); return { state: 'verified', canonical: true }; }
  catch { return { state: 'unavailable', canonical: false }; }
};

it('a signer refusal stops automatic retries and change kicks until approveToken moves', async () => {
  vi.useFakeTimers();
  sync.mockImplementation(callsResolve);
  const resolve = vi.fn(async (): Promise<DecryptingSigningBackend> => { throw new VaultApprovalError('The signer refused the vault request'); });
  let props = { ...opts(), jobs: async () => [{ adapter: job.adapter, resolve }], approveToken: 0 };
  const { result, rerender, unmount } = renderHook(p => usePrivateVaults(p), { initialProps: props });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(sync).toHaveBeenCalledTimes(1);
  expect(result.current.needsApproval).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(20 * 60_000); });
  props = { ...props, changeToken: 'edited' };
  rerender(props);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  // `ready` flapping (e.g. a sign-in gate) must not quietly retry either.
  rerender({ ...props, ready: false });
  rerender(props);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(sync).toHaveBeenCalledTimes(1);
  // The user is at the device: one more run, which succeeds this time.
  resolve.mockResolvedValue({} as DecryptingSigningBackend);
  props = { ...props, approveToken: 1 };
  rerender(props);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(sync).toHaveBeenCalledTimes(2);
  expect(result.current.needsApproval).toBeFalsy();
  unmount();
});

it('a refusal raised by the handed-out backend (not the resolve) also stops retries', async () => {
  vi.useFakeTimers();
  sync.mockImplementation(async (args: { resolve(rotation: number): Promise<{ nip44Decrypt(a: string, b: string): Promise<string> }> }) => {
    const backend = await args.resolve(0);
    try { await backend.nip44Decrypt('a', 'b'); } catch { /* swallowed like the real sync */ }
    return { state: 'unavailable', canonical: false };
  });
  const backend = { nip44Decrypt: async () => { throw new VaultApprovalError('The signer requires approval for this vault request'); } };
  const { result, unmount } = renderHook(() => usePrivateVaults({ ...opts(),
    jobs: async () => [{ ...job, resolve: async () => backend as unknown as DecryptingSigningBackend }, job] }));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(result.current.needsApproval).toBe(true);
  // One refusal stops the cycle: the second dataset is not started.
  expect(sync).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
  expect(sync).toHaveBeenCalledTimes(1);
  unmount();
});

it('a network failure keeps the timed backoff', async () => {
  vi.useFakeTimers();
  sync.mockImplementation(callsResolve);
  const { result, unmount } = renderHook(() => usePrivateVaults({ ...opts(),
    jobs: async () => [failingJob(() => new Error('Could not reach the vault signer'))] }));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(sync).toHaveBeenCalledTimes(1);
  expect(result.current.needsApproval).toBeFalsy();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(sync).toHaveBeenCalledTimes(2);
  unmount();
});
