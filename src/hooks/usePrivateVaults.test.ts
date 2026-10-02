// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const sync = vi.hoisted(() => vi.fn());
vi.mock('../lib/private-vault-sync', () => ({ syncPrivateVaultDataset: sync }));
import { usePrivateVaults, legacyVaultWriteAllowed, PRIVATE_VAULT_PAUSE_CAP_MS, PRIVATE_VAULT_IDLE_POLL_MS } from './usePrivateVaults';
import { VaultApprovalError } from '../lib/vault-approval';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import { vaultContentHash } from 'signet-protocol/experimental';
import type { VaultDataset } from 'signet-protocol/experimental';
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
  // All verified: the next run is the idle poll, not a 30 s backoff…
  await act(async () => { await vi.advanceTimersByTimeAsync(PRIVATE_VAULT_IDLE_POLL_MS - 5000); });
  expect(sync).toHaveBeenCalledTimes(2);
  // …and it is a full cycle, so it re-reads a verified dataset and can fail.
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(sync).toHaveBeenCalledTimes(3);
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

// ── Sign-in gets the device first ─────────────────────────────────────────────

it('starts no job while paused, and runs promptly once the pause lifts', async () => {
  vi.useFakeTimers();
  sync.mockResolvedValue({ state: 'verified', canonical: true });
  const props = { ...opts(), paused: true };
  const { rerender, unmount } = renderHook(p => usePrivateVaults(p), { initialProps: props });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(sync).not.toHaveBeenCalled();
  rerender({ ...props, paused: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(sync).toHaveBeenCalledTimes(1);
  unmount();
});

it('lets a dataset already in flight finish but starts no further one until un-paused', async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  sync.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ state: 'verified', canonical: true });
  const second = { ...job, adapter: { ...job.adapter, dataset: 'settings' as const } };
  const props = { ...opts(), jobs: async () => [job, second], paused: false };
  const { result, rerender, unmount } = renderHook(p => usePrivateVaults(p), { initialProps: props });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(sync).toHaveBeenCalledTimes(1);
  rerender({ ...props, paused: true });
  await act(async () => { finish({ state: 'verified', canonical: true }); await vi.advanceTimersByTimeAsync(10); });
  // The in-flight one was not aborted…
  expect(result.current.datasets['signet:vault:profiles'].state).toBe('verified');
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  // …and the second never started while held.
  expect(sync).toHaveBeenCalledTimes(1);
  rerender({ ...props, paused: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(sync.mock.calls.some(([args]) => (args as { adapter: { dataset: string } }).adapter.dataset === 'settings')).toBe(true);
  unmount();
});

it('does not sit out a long backoff armed before the pause', async () => {
  vi.useFakeTimers();
  sync.mockResolvedValue({ state: 'unavailable', canonical: false });
  const props = { ...opts(), paused: false };
  const { rerender, unmount } = renderHook(p => usePrivateVaults(p), { initialProps: props });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(sync).toHaveBeenCalledTimes(1); // next retry armed for 60 s
  rerender({ ...props, paused: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  rerender({ ...props, paused: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(sync).toHaveBeenCalledTimes(2);
  unmount();
});

it('a pause that is never lifted is honoured only up to the cap', async () => {
  vi.useFakeTimers();
  sync.mockResolvedValue({ state: 'verified', canonical: true });
  const { unmount } = renderHook(() => usePrivateVaults({ ...opts(), paused: true }));
  await act(async () => { await vi.advanceTimersByTimeAsync(PRIVATE_VAULT_PAUSE_CAP_MS - 1000); });
  expect(sync).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(sync).toHaveBeenCalledTimes(1);
  unmount();
});

// ── Only datasets that need it ───────────────────────────────────────────────
// Each sync is device work (a card per decrypt on a Heartwood). A change cycle
// visits only datasets whose local snapshot moved since they verified, a
// backoff retry only the unverified ones; unlock and `online` stay full.

function trackedJobs(datasets: VaultDataset[]) {
  const data = new Map<string, string>(datasets.map(d => [JSON.stringify(d), 'v0']));
  const jobs = datasets.map(dataset => ({ adapter: { dataset, merge: async () => {},
    snapshot: async () => data.get(JSON.stringify(dataset))! }, resolve: async () => ({} as DecryptingSigningBackend) }));
  return { jobs, edit: (dataset: VaultDataset, value: string) => data.set(JSON.stringify(dataset), value) };
}
const verifiedSync = async (args: { adapter: { snapshot(): Promise<string> } }) =>
  ({ state: 'verified', canonical: true, revision: vaultContentHash(await args.adapter.snapshot()) });
const ran = () => sync.mock.calls.map(([args]) => (args as { adapter: { dataset: VaultDataset } }).adapter.dataset);
const three: VaultDataset[] = ['profiles', 'credentials', 'settings'];

it('a change cycle syncs only the dataset whose local data moved', async () => {
  vi.useFakeTimers();
  sync.mockImplementation(verifiedSync);
  const { jobs, edit } = trackedJobs(three);
  let props = { ...opts(), jobs: async () => jobs };
  const { rerender, unmount } = renderHook(p => usePrivateVaults(p), { initialProps: props });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(ran()).toEqual(three);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(sync).toHaveBeenCalledTimes(3);
  edit('settings', 'v1');
  props = { ...props, changeToken: 'edited' };
  rerender(props);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(ran().slice(3)).toEqual(['settings']);
  // An unrelated token change with no data moved costs nothing.
  rerender({ ...props, changeToken: 'edited-again' });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(sync).toHaveBeenCalledTimes(4);
  unmount();
});

it('treats a snapshot that throws as changed', async () => {
  vi.useFakeTimers();
  sync.mockResolvedValue({ state: 'verified', canonical: true, revision: 'r' });
  const broken = { ...job, adapter: { ...job.adapter, snapshot: async () => { throw new Error('locked'); } } };
  let props = { ...opts(), jobs: async () => [broken] };
  const { rerender, unmount } = renderHook(p => usePrivateVaults(p), { initialProps: props });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  props = { ...props, changeToken: 'edited' };
  rerender(props);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(sync).toHaveBeenCalledTimes(2);
  unmount();
});

it('a backoff retry syncs only the datasets that did not verify', async () => {
  vi.useFakeTimers();
  sync.mockImplementation(async (args: { adapter: { dataset: VaultDataset; snapshot(): Promise<string> } }) =>
    args.adapter.dataset === 'credentials' ? { state: 'unavailable', canonical: false } : verifiedSync(args));
  const { jobs } = trackedJobs(three);
  const { unmount } = renderHook(() => usePrivateVaults({ ...opts(), jobs: async () => jobs }));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(ran()).toEqual(three);
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(ran().slice(3)).toEqual(['credentials']);
  unmount();
});

it('`online` runs a full cycle over unchanged, verified datasets', async () => {
  vi.useFakeTimers();
  sync.mockImplementation(verifiedSync);
  const { jobs } = trackedJobs(three);
  const { unmount } = renderHook(() => usePrivateVaults({ ...opts(), jobs: async () => jobs }));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  await act(async () => { window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(1500); });
  expect(ran().slice(3)).toEqual(three);
  unmount();
});

it('a full cycle requested while a change cycle runs is followed by a full one', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  sync.mockImplementation(verifiedSync);
  const { jobs, edit } = trackedJobs(three);
  let props = { ...opts(), jobs: async () => jobs };
  const { rerender, unmount } = renderHook(p => usePrivateVaults(p), { initialProps: props });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  sync.mockImplementationOnce(async args => { await new Promise<void>(r => { finish = r; }); return verifiedSync(args); });
  edit('settings', 'v1');
  props = { ...props, changeToken: 'edited' };
  rerender(props);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(ran().slice(3)).toEqual(['settings']);
  await act(async () => { window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(10); });
  await act(async () => { finish(); await vi.advanceTimersByTimeAsync(1500); });
  expect(ran().slice(4)).toEqual(three);
  unmount();
});

it('a full cycle held part-way still visits its unreached datasets after the pause', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  sync.mockImplementation(verifiedSync);
  const { jobs } = trackedJobs(three);
  const props = { ...opts(), jobs: async () => jobs, paused: false };
  const { rerender, unmount } = renderHook(p => usePrivateVaults(p), { initialProps: props });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  sync.mockImplementationOnce(async args => { await new Promise<void>(r => { finish = r; }); return verifiedSync(args); });
  await act(async () => { window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(1500); });
  expect(ran().slice(3)).toEqual(['profiles']);
  rerender({ ...props, paused: true });
  await act(async () => { finish(); await vi.advanceTimersByTimeAsync(10); });
  rerender({ ...props, paused: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  // Verified and unchanged, but the full cycle never reached them.
  expect(ran().slice(4)).toEqual(['credentials', 'settings']);
  unmount();
});

it('once every dataset verifies, the idle poll is a full cycle', async () => {
  vi.useFakeTimers();
  sync.mockImplementation(verifiedSync);
  const { jobs } = trackedJobs(three);
  const { unmount } = renderHook(() => usePrivateVaults({ ...opts(), jobs: async () => jobs }));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  await act(async () => { await vi.advanceTimersByTimeAsync(PRIVATE_VAULT_IDLE_POLL_MS - 1000); });
  expect(sync).toHaveBeenCalledTimes(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(ran().slice(3)).toEqual(three);
  unmount();
});

it('a dataset stuck unverified does not stop the periodic full cycle', async () => {
  vi.useFakeTimers();
  sync.mockImplementation(async (args: { adapter: { dataset: VaultDataset; snapshot(): Promise<string> } }) =>
    args.adapter.dataset === 'credentials' ? { state: 'waiting-legacy', canonical: false } : verifiedSync(args));
  const { jobs } = trackedJobs(three);
  const { unmount } = renderHook(() => usePrivateVaults({ ...opts(), jobs: async () => jobs }));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  await act(async () => { await vi.advanceTimersByTimeAsync(PRIVATE_VAULT_IDLE_POLL_MS + 5 * 60_000); });
  expect(ran().slice(3).filter(d => d === 'profiles').length).toBeGreaterThan(0);
  unmount();
});

it('drops the health entry of a dataset no longer in the jobs, so it cannot hold a backoff', async () => {
  vi.useFakeTimers();
  sync.mockImplementation(async (args: { adapter: { dataset: VaultDataset; snapshot(): Promise<string> } }) =>
    typeof args.adapter.dataset === 'object' ? { state: 'unavailable', canonical: false } : verifiedSync(args));
  const tracked = trackedJobs(['profiles', { dependant: 0 }]);
  let current = tracked.jobs;
  let props = { ...opts(), jobs: async () => current };
  const { result, rerender, unmount } = renderHook(p => usePrivateVaults(p), { initialProps: props });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(Object.keys(result.current.datasets)).toHaveLength(2);
  current = tracked.jobs.slice(0, 1);
  props = { ...props, changeToken: 'dependant-removed' };
  rerender(props);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(Object.keys(result.current.datasets)).toEqual(['signet:vault:profiles']);
  const before = sync.mock.calls.length;
  // Nothing runs again before the idle poll.
  await act(async () => { await vi.advanceTimersByTimeAsync(PRIVATE_VAULT_IDLE_POLL_MS - 5000); });
  expect(sync.mock.calls.length).toBe(before);
  unmount();
});

it('frequent edits do not postpone the periodic full cycle', async () => {
  vi.useFakeTimers();
  sync.mockImplementation(verifiedSync);
  const { jobs } = trackedJobs(three);
  let props = { ...opts(), jobs: async () => jobs };
  const { rerender, unmount } = renderHook(p => usePrivateVaults(p), { initialProps: props });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  for (let i = 0; i < 6; i++) {
    props = { ...props, changeToken: `tick-${i}` };
    rerender(props);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  }
  // Nothing changed locally, yet a full cycle re-read every dataset.
  expect(ran().slice(3)).toEqual(three);
  unmount();
});
