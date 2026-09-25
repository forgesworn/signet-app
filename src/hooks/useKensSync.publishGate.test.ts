// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../lib/ken-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/ken-sync')>();
  return { ...actual, fetchKensSync: vi.fn(), publishKensSync: vi.fn() };
});

import type { KenEntry } from '@forgesworn/kenspeckle';
import { fetchKensSync, publishKensSync } from '../lib/ken-sync';
import { purgeAllUserData, getKens, saveKen } from '../lib/db';
import { createNewIdentity } from '../lib/signet';
import type { SignetIdentity } from '../types';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import { useKensSync } from './useKensSync';

const mockFetch = vi.mocked(fetchKensSync);
const mockPublish = vi.mocked(publishKensSync);
const RELAY = 'wss://relay.example.com';
const KEY = 'a'.repeat(64);

let identity: SignetIdentity;
let backend: DecryptingSigningBackend;

/**
 * A real `KenEntry`: `provenance` is REQUIRED on the kenspeckle type
 * (`KindredEntryBase` + `KenEntry`), and `mergeKenLists` stamps by
 * `lastResolvedAt ?? addedAt`. A fixture without it type-errors and would not
 * survive `parseEntry` on a real fetch.
 */
function makeKen(ownerPubkey: string, over: Partial<KenEntry> = {}): KenEntry {
  return {
    pubkey: 'b'.repeat(64),
    ownerPubkey,
    tier: 'ken',
    displayName: 'Pub',
    addedAt: 9_000,
    provenance: { source: 'manual', locator: 'x', confirmedAt: 9_000 },
    ...over,
  } as KenEntry;
}

beforeEach(async () => {
  await purgeAllUserData();
  mockFetch.mockReset();
  mockPublish.mockReset().mockResolvedValue(true);
  identity = createNewIdentity('Guardian', 'natural-person', false);
  backend = {
    type: 'local', activePublicKeyHex: identity.naturalPerson.publicKey,
    signEvent: vi.fn(), nip44Encrypt: vi.fn(), nip44Decrypt: vi.fn(), destroy: vi.fn(),
  } as unknown as DecryptingSigningBackend;
});

afterEach(() => { vi.useRealTimers(); });

/**
 * Flush the fake clock in two stages. `advanceTimersByTimeAsync` does not
 * re-discover a timer that gets scheduled as a side effect DURING its own
 * run (here: the publish debounce, scheduled from a state update that lands
 * only after the fetch-and-merge effect's mocked promise resolves) — a timer
 * registered mid-flight is not picked up by the remainder of that same
 * advance call, only by a later one. A short first advance lets hydration
 * settle and the debounce get scheduled; the second, much longer advance
 * then actually fires it.
 */
async function flushHydrationThenDebounce() {
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
}

describe('useKensSync — fetch half is untouched', () => {
  it('still merges a remote ken into the legacy store', async () => {
    const onRemoteMerged = vi.fn();
    mockFetch.mockResolvedValue({ kens: [makeKen(identity.naturalPerson.publicKey)], createdAt: 500 } as never);

    vi.useFakeTimers();
    renderHook(() => useKensSync({
      identity, npBackend: backend, relayUrl: RELAY, encryptionKey: KEY, onRemoteMerged,
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    // fake-indexeddb schedules on setImmediate, which fake timers capture —
    // drop back to real timers before reading IDB directly.
    vi.useRealTimers();
    expect(await getKens(identity.naturalPerson.publicKey)).toHaveLength(1);
    expect(onRemoteMerged).toHaveBeenCalled();
  });
});

describe('useKensSync — publishEnabled gate (R10)', () => {
  it('still publishes while the v2 rail has not proved itself', async () => {
    await saveKen(makeKen(identity.naturalPerson.publicKey));
    mockFetch.mockResolvedValue(null);

    vi.useFakeTimers();
    renderHook(() => useKensSync({
      identity, npBackend: backend, relayUrl: RELAY, encryptionKey: KEY,
      kens: [makeKen(identity.naturalPerson.publicKey)],
      publishEnabled: true,
    }));
    await flushHydrationThenDebounce();
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it('never publishes once the v2 rail is canonical, however long the timers run', async () => {
    await saveKen(makeKen(identity.naturalPerson.publicKey));
    mockFetch.mockResolvedValue(null);

    vi.useFakeTimers();
    // The `kens` prop IS passed: `useKensSync.ts:148` returns early without it,
    // so omitting it would make this case pass against today's code (R13).
    renderHook(() => useKensSync({
      identity, npBackend: backend, relayUrl: RELAY, encryptionKey: KEY,
      kens: [makeKen(identity.naturalPerson.publicKey)],
      publishEnabled: false,
    }));
    await flushHydrationThenDebounce();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('defaults to publishing when the option is omitted', async () => {
    await saveKen(makeKen(identity.naturalPerson.publicKey));
    mockFetch.mockResolvedValue(null);

    vi.useFakeTimers();
    renderHook(() => useKensSync({
      identity, npBackend: backend, relayUrl: RELAY, encryptionKey: KEY,
      kens: [makeKen(identity.naturalPerson.publicKey)],
    }));
    await flushHydrationThenDebounce();
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });
});
