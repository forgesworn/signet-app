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
