import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const makeReader = vi.hoisted(() => vi.fn());
vi.mock('signet-protocol/experimental', async original => ({
  ...await original<typeof import('signet-protocol/experimental')>(), createVaultRelayReader: makeReader,
}));
import { localVaultBackend, relayVaultReader, VAULT_RELAY_READ_TIMEOUT_MS } from './private-vault';
import { syncPrivateVaultDataset } from './private-vault-sync';
import { withPrivateVaultLock } from './private-vault-lock';
import { purgeAllUserData } from './db';
import type { VaultDataset } from 'signet-protocol/experimental';

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OWNER = 'a'.repeat(64);
const never = () => new Promise<never>(() => {});
const hungReader = () => ({ checkpoints: vi.fn(never), chunk: vi.fn(never), open: vi.fn(async () => null) });

function syncArgs(dataset: VaultDataset) {
  const backend = localVaultBackend(WORDS, dataset);
  return { adapter: { dataset, snapshot: vi.fn(async () => '{"v":1}'), merge: vi.fn(async () => {}) },
    ownerPubkey: OWNER, encryptionKey: 'unlock', relays: { read: ['wss://relay.example'], write: ['wss://relay.example'] },
    resolve: async (_rotation: number) => backend, isCurrent: () => true, now: 1700000000 };
}

beforeEach(async () => {
  await purgeAllUserData();
  makeReader.mockReset();
  makeReader.mockImplementation(hungReader);
  // setImmediate stays real: fake-indexeddb schedules on it.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => { vi.useRealTimers(); });

it('allows longer than a connect plus a query', () => {
  expect(VAULT_RELAY_READ_TIMEOUT_MS).toBeGreaterThan(5_000 + 10_000);
});

it('a relay read that never settles ends the dataset unavailable and releases its lock for the next', async () => {
  const first = syncArgs('profiles');
  let settled = false;
  const run = syncPrivateVaultDataset(first).then(result => { settled = true; return result; });
  await vi.waitUntil(() => makeReader.mock.results.some(r => r.value.checkpoints.mock.calls.length > 0));
  await vi.advanceTimersByTimeAsync(VAULT_RELAY_READ_TIMEOUT_MS - 1_000);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(run).resolves.toMatchObject({ state: 'unavailable' });

  // The lock for that dataset is free again, right now.
  await expect(withPrivateVaultLock(OWNER, 'profiles', async () => 'free')).resolves.toBe('free');

  // The next dataset in the cycle gets its turn and reaches the relays.
  const callsBefore = makeReader.mock.calls.length;
  const next = syncPrivateVaultDataset(syncArgs('settings'));
  await vi.waitUntil(() => makeReader.mock.calls.length > callsBefore);
  await vi.advanceTimersByTimeAsync(VAULT_RELAY_READ_TIMEOUT_MS + 1_000);
  await expect(next).resolves.toMatchObject({ state: 'unavailable' });
});

it('bounds chunk reads too, and leaves open unwrapped for device approvals', async () => {
  const hung = hungReader();
  makeReader.mockReturnValue(hung);
  const reader = relayVaultReader(['wss://relay.example'], localVaultBackend(WORDS, 'profiles'));
  const chunk = expect(reader.chunk('e'.repeat(64))).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(VAULT_RELAY_READ_TIMEOUT_MS);
  await chunk;
  expect(reader.open).toBe(hung.open);
});

it('passes a relay answer and its arguments straight through, leaving no timer behind', async () => {
  const hung = hungReader();
  hung.checkpoints.mockImplementation((async () => []) as never);
  makeReader.mockReturnValue(hung);
  const reader = relayVaultReader(['wss://relay.example'], localVaultBackend(WORDS, 'profiles'));
  await expect(reader.checkpoints('b'.repeat(64), 'd-tag')).resolves.toEqual([]);
  expect(hung.checkpoints).toHaveBeenCalledWith('b'.repeat(64), 'd-tag');
  expect(vi.getTimerCount()).toBe(0);
});
