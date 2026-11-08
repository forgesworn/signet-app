// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock the fetch/publish legs of credentials-sync before importing the
// hook, keeping the real mergeCredentialLists/SYNC_D_TAG — this test only
// covers the timer body's error handling (I2), not the merge logic
// (covered by credentials-sync.test.ts).
vi.mock('../lib/credentials-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/credentials-sync')>();
  return {
    ...actual,
    fetchCredentialsSync: vi.fn(),
    publishCredentialsSync: vi.fn(),
  };
});

import { fetchCredentialsSync, publishCredentialsSync } from '../lib/credentials-sync';
import { purgeAllUserData, saveCredential, getAllCredentials } from '../lib/db';
import { createNewIdentity } from '../lib/signet';
import type { SignetIdentity, StoredCredential } from '../types';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import { useCredentialsSync } from './useCredentialsSync';

const mockFetch = vi.mocked(fetchCredentialsSync);
const mockPublish = vi.mocked(publishCredentialsSync);

const RELAY_URL = 'wss://relay.example.com';
const KEY = 'a'.repeat(64);

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

function makeCredential(overrides: Partial<StoredCredential> = {}): StoredCredential {
  return {
    id: 'cred-1',
    documentId: 'doc-1',
    keypairType: 'natural-person',
    event: '{}',
    verifierPubkey: 'e'.repeat(64),
    verifiedAt: 100,
    verifierStatus: 'confirmed',
    ...overrides,
  };
}

let identity: SignetIdentity;
let backend: DecryptingSigningBackend;

beforeEach(async () => {
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

async function flushHydration() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
}

describe('useCredentialsSync — debounced publish (I2)', () => {
  it('a rejecting publish yields no unhandled rejection and the hook stays usable', async () => {
    mockFetch.mockResolvedValue(null);
    mockPublish.mockRejectedValueOnce(new Error('signEvent boom'));

    const cred = makeCredential();

    vi.useFakeTimers();
    const { rerender } = renderHook(
      (props: { credentials: StoredCredential[] }) => useCredentialsSync({
        identity,
        npBackend: backend,
        relayUrl: RELAY_URL,
        encryptionKey: KEY,
        credentials: props.credentials,
      }),
      { initialProps: { credentials: [cred] } },
    );

    await flushHydration();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(mockPublish).toHaveBeenCalledTimes(1);

    // A later local change still gets published on the next debounce cycle —
    // the rejection above must not have left the hook stuck.
    mockPublish.mockResolvedValue(true);
    const mutated = makeCredential({ verifierStatus: 'pending' });
    rerender({ credentials: [mutated] });
    await flushHydration();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(mockPublish).toHaveBeenCalledTimes(2);
  });
});

it('keeps legacy reads enabled while migration disables publication', async () => {
  mockFetch.mockResolvedValue(null);
  vi.useFakeTimers();
  const { rerender, unmount } = renderHook((props: { publishEnabled: boolean }) => useCredentialsSync({
    identity, npBackend: backend, relayUrl: RELAY_URL, encryptionKey: KEY,
    credentials: [makeCredential()], publishEnabled: props.publishEnabled,
  }), { initialProps: { publishEnabled: false } });
  await flushHydration();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(mockFetch).toHaveBeenCalled();
  expect(mockPublish).not.toHaveBeenCalled();
  rerender({ publishEnabled: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
  expect(mockPublish).toHaveBeenCalledTimes(1);
  unmount();
});

/**
 * Real timers throughout: `saveCredential` / `getAllCredentials` run real
 * 600k-iteration PBKDF2, which a fake clock never lets settle.
 *
 * State the hook sets while a test is inside an `act` scope is only rendered
 * when that scope exits, so a negative assertion first lets one short `act`
 * flush hydration (arming the publish timer) and only then waits out the
 * debounce. Without that the "no publish" cases could pass without the
 * publish effect ever having been armed.
 */
describe('useCredentialsSync: republish after a merge the local side won (#192)', () => {
  type Relays = { read: string[]; write: string[] };
  const RELAYS: Relays = { read: [RELAY_URL], write: [RELAY_URL] };
  const REMOTE = (credentials: StoredCredential[]) => ({
    credentials, createdAt: 12345, eventId: 'e'.repeat(64), reachableRelays: 1,
  });

  interface Props { credentials: StoredCredential[]; relays?: Relays }
  function renderCredentials(initialProps: Props) {
    return renderHook(
      (props: Props) => useCredentialsSync({
        identity,
        npBackend: backend,
        relays: props.relays ?? RELAYS,
        encryptionKey: KEY,
        credentials: props.credentials,
      }),
      { initialProps },
    );
  }

  const settle = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  const publishes = (n: number) => waitFor(() => expect(mockPublish).toHaveBeenCalledTimes(n), { timeout: 10_000 });

  it('publishes when the local side holds a strictly newer verifiedAt than the relay', async () => {
    await saveCredential(makeCredential({ verifiedAt: 200 }), KEY);
    const stored = await getAllCredentials(KEY);
    mockFetch.mockResolvedValue(REMOTE([makeCredential({ verifiedAt: 100, verifierStatus: 'pending' })]));

    renderCredentials({ credentials: stored });
    await publishes(1);
    expect((mockPublish.mock.calls[0][0] as StoredCredential[]).map((c) => c.verifiedAt)).toEqual([200]);
  }, 30_000);

  it('publishes a credential only this device holds', async () => {
    await saveCredential(makeCredential(), KEY);
    const stored = await getAllCredentials(KEY);
    mockFetch.mockResolvedValue(REMOTE([]));

    renderCredentials({ credentials: stored });
    await publishes(1);
  }, 30_000);

  it('does not publish when the relay is the richer side', async () => {
    await saveCredential(makeCredential({ verifiedAt: 100, verifierStatus: 'pending' }), KEY);
    const [local] = await getAllCredentials(KEY);
    // Built from the stored shape so the key order matches what the app
    // reloads (the publish hash is order-sensitive).
    const newer = { ...local, verifiedAt: 200, verifierStatus: 'confirmed' as const };
    const remoteOnly = { ...local, id: 'cred-2', verifiedAt: 150 };
    mockFetch.mockResolvedValue(REMOTE([newer, remoteOnly]));

    const { result, rerender } = renderCredentials({ credentials: [local] });
    await waitFor(() => expect(result.current.remoteState).toBe('present'));
    // App reloads its credentials after `onRemoteMerged`; mirror that with
    // what is now stored so the publish effect hashes the merged state.
    rerender({ credentials: await getAllCredentials(KEY) });
    await settle(300);
    await settle(1800);

    expect(mockPublish).not.toHaveBeenCalled();
  }, 30_000);

  it('does not publish when the relay already holds exactly this state', async () => {
    await saveCredential(makeCredential(), KEY);
    const stored = await getAllCredentials(KEY);
    mockFetch.mockResolvedValue(REMOTE([...stored]));

    const { result } = renderCredentials({ credentials: stored });
    await waitFor(() => expect(result.current.remoteState).toBe('present'));
    await settle(300);
    await settle(1800);

    expect(mockPublish).not.toHaveBeenCalled();
  }, 30_000);

  it('republishes a won merge even though this device already published that exact state', async () => {
    await saveCredential(makeCredential(), KEY);
    const stored = await getAllCredentials(KEY);
    mockFetch.mockResolvedValueOnce(null);

    const { rerender } = renderCredentials({ credentials: stored });
    await publishes(1);

    // Another device overwrote the relay with an empty record; the relay set
    // changing re-fetches it. Our credential is something it lacks, so the
    // unchanged local state must go back out.
    mockFetch.mockResolvedValue(REMOTE([]));
    rerender({ credentials: stored, relays: { read: ['wss://relay-two.example.com'], write: [RELAY_URL] } });
    await publishes(2);
  }, 30_000);

  it('does not publish after an unreachable fetch, even after a local change', async () => {
    mockFetch.mockResolvedValue('unreachable');

    const { result, rerender } = renderCredentials({ credentials: [makeCredential()] });
    await waitFor(() => expect(result.current.remoteState).toBe('unreachable'));
    await settle(300);
    rerender({ credentials: [makeCredential({ verifierStatus: 'pending' })] });
    await settle(1800);

    expect(mockPublish).not.toHaveBeenCalled();
  }, 30_000);
});
