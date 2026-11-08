// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the fetch/publish legs of the grants-sync module before importing the
// hook, but keep the real mergeGrantLists / SYNC_D_TAG — the merge logic
// itself is covered by grants-sync.test.ts, and reusing the real merge here
// keeps this test honest about what the hook actually does with it.
vi.mock('../lib/grants-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/grants-sync')>();
  return {
    ...actual,
    fetchGrantsSync: vi.fn(),
    publishGrantsSync: vi.fn(),
  };
});

import { fetchGrantsSync, publishGrantsSync } from '../lib/grants-sync';
import { saveGrant, purgeAllUserData } from '../lib/db';
import { createNewIdentity } from '../lib/signet';
import type { RememberedGrant, SignetIdentity } from '../types';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import { useGrantsSync } from './useGrantsSync';

const mockFetch = vi.mocked(fetchGrantsSync);
const mockPublish = vi.mocked(publishGrantsSync);

const DEP = 'd'.repeat(64);
const RELAY_URL = 'wss://relay.example.com';
const KEY = 'a'.repeat(64);

function grant(overrides: Partial<RememberedGrant> = {}): RememberedGrant {
  return {
    dependantId: DEP,
    scope: 'sign-in',
    origin: 'https://roblox.com',
    decision: 'allow',
    decidedAt: 100,
    ...overrides,
  };
}

function makeBackend(pubkeyHex: string): DecryptingSigningBackend {
  return {
    type: 'local',
    activePublicKeyHex: pubkeyHex,
    signEvent: vi.fn(),
    nip44Encrypt: vi.fn(),
    nip44Decrypt: vi.fn(),
    destroy: vi.fn(),
  } as unknown as DecryptingSigningBackend;
}

let identity: SignetIdentity;
let backend: DecryptingSigningBackend;

beforeEach(async () => {
  // Real timers for all the IDB setup — fake-indexeddb schedules its
  // callbacks via (fake-able) setImmediate, so anything that needs IDB to
  // resolve must run before fake timers are engaged, or be driven forward
  // explicitly via vi.advanceTimersByTimeAsync.
  await purgeAllUserData();
  mockFetch.mockReset();
  mockPublish.mockReset();
  mockPublish.mockResolvedValue(true);
  identity = createNewIdentity('Guardian', 'natural-person', false);
  backend = makeBackend(identity.naturalPerson.publicKey);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Flush the async fetch-and-merge effect (mocked fetch resolves
 * immediately; the merge + reseed path still round-trips real fake-indexeddb
 * calls, which run on fake-timer-scheduled tasks once fake timers are on).
 */
async function flushHydration() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
}

describe('useGrantsSync — publish-hash reseed after fetch (§11.1.10)', () => {
  it('does not republish on a warm unlock when the fetched set matches local', async () => {
    const g = grant();
    await saveGrant(g);
    mockFetch.mockResolvedValue({ grants: [g], createdAt: 12345, eventId: 'e'.repeat(64), reachableRelays: 1 });

    vi.useFakeTimers();

    const { rerender } = renderHook(
      (props: { grants: RememberedGrant[] }) => useGrantsSync({
        identity,
        npBackend: backend,
        relayUrl: RELAY_URL,
        encryptionKey: KEY,
        grants: props.grants,
      }),
      { initialProps: { grants: [g] } },
    );

    await flushHydration();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Re-render with a new array instance carrying the same content, so the
    // publish effect actually re-evaluates against the reseeded hash.
    rerender({ grants: [g] });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('does not publish after an unreachable fetch, even after a local change', async () => {
    const g = grant();
    await saveGrant(g);
    mockFetch.mockResolvedValue('unreachable');

    vi.useFakeTimers();

    const { rerender } = renderHook(
      (props: { grants: RememberedGrant[] }) => useGrantsSync({
        identity,
        npBackend: backend,
        relayUrl: RELAY_URL,
        encryptionKey: KEY,
        grants: props.grants,
      }),
      { initialProps: { grants: [g] } },
    );

    await flushHydration();

    rerender({ grants: [grant({ decision: 'deny', decidedAt: 999 })] });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('publishes once when local grants actually change after hydration', async () => {
    const g = grant();
    await saveGrant(g);
    mockFetch.mockResolvedValue({ grants: [g], createdAt: 12345, eventId: 'e'.repeat(64), reachableRelays: 1 });

    vi.useFakeTimers();

    const { rerender } = renderHook(
      (props: { grants: RememberedGrant[] }) => useGrantsSync({
        identity,
        npBackend: backend,
        relayUrl: RELAY_URL,
        encryptionKey: KEY,
        grants: props.grants,
      }),
      { initialProps: { grants: [g] } },
    );

    await flushHydration();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const mutated = grant({ decision: 'deny', decidedAt: 999 });
    rerender({ grants: [mutated] });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it('(I2) a rejecting publish yields no unhandled rejection and the hook stays usable', async () => {
    const g = grant();
    await saveGrant(g);
    mockFetch.mockResolvedValue({ grants: [g], createdAt: 12345, eventId: 'e'.repeat(64), reachableRelays: 1 });
    mockPublish.mockRejectedValueOnce(new Error('signEvent boom'));

    vi.useFakeTimers();

    const { rerender } = renderHook(
      (props: { grants: RememberedGrant[] }) => useGrantsSync({
        identity,
        npBackend: backend,
        relayUrl: RELAY_URL,
        encryptionKey: KEY,
        grants: props.grants,
      }),
      { initialProps: { grants: [g] } },
    );

    await flushHydration();

    const mutated = grant({ decision: 'deny', decidedAt: 999 });
    rerender({ grants: [mutated] });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(mockPublish).toHaveBeenCalledTimes(1);

    // A later local change still gets published on the next debounce cycle —
    // the rejection above must not have left the hook stuck.
    mockPublish.mockResolvedValue(true);
    const mutated2 = grant({ decision: 'allow', decidedAt: 1500 });
    rerender({ grants: [mutated2] });
    await flushHydration();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(mockPublish).toHaveBeenCalledTimes(2);
  });
});

describe('useGrantsSync: republish after a merge the local side won (#192)', () => {
  const REMOTE = (grants: RememberedGrant[]) => ({
    grants, createdAt: 12345, eventId: 'e'.repeat(64), reachableRelays: 1,
  });

  function renderGrants(initialProps: { grants: RememberedGrant[]; relayUrl?: string }) {
    return renderHook(
      (props: { grants: RememberedGrant[]; relayUrl?: string }) => useGrantsSync({
        identity,
        npBackend: backend,
        relayUrl: props.relayUrl ?? RELAY_URL,
        encryptionKey: KEY,
        grants: props.grants,
      }),
      { initialProps },
    );
  }

  it('publishes when the local side holds a newer decision than the relay', async () => {
    const local = grant({ decision: 'deny', decidedAt: 200 });
    await saveGrant(local);
    mockFetch.mockResolvedValue(REMOTE([grant({ decision: 'allow', decidedAt: 100 })]));

    vi.useFakeTimers();
    renderGrants({ grants: [local] });
    await flushHydration();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0][0]).toEqual([local]);
  });

  it('publishes a grant only this device holds', async () => {
    const local = grant();
    await saveGrant(local);
    mockFetch.mockResolvedValue(REMOTE([]));

    vi.useFakeTimers();
    renderGrants({ grants: [local] });
    await flushHydration();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it('does not publish when the relay is the richer side', async () => {
    await saveGrant(grant({ decision: 'allow', decidedAt: 100 }));
    const newer = grant({ decision: 'deny', decidedAt: 200 });
    const remoteOnly = grant({ scope: 'other-scope', decidedAt: 150 });
    mockFetch.mockResolvedValue(REMOTE([newer, remoteOnly]));

    vi.useFakeTimers();
    const { rerender } = renderGrants({ grants: [grant({ decision: 'allow', decidedAt: 100 })] });
    await flushHydration();
    // App reloads its grants after `onRemoteMerged`; mirror that with the
    // merged state so the publish effect hashes what is now stored.
    rerender({ grants: [newer, remoteOnly] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('republishes a won merge even though this device already published that exact state', async () => {
    const local = grant({ decidedAt: 200 });
    await saveGrant(local);
    mockFetch.mockResolvedValueOnce(null);

    vi.useFakeTimers();
    const { rerender } = renderGrants({ grants: [local] });
    await flushHydration();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(mockPublish).toHaveBeenCalledTimes(1);

    // Another device overwrote the relay with a poorer record. A re-fetch (the
    // relay set changed) finds it: our state is richer, and must go back out
    // even though it matches what we published a moment ago.
    mockFetch.mockResolvedValue(REMOTE([]));
    rerender({ grants: [local], relayUrl: 'wss://relay-two.example.com' });
    await flushHydration();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    expect(mockPublish).toHaveBeenCalledTimes(2);
  });
});
