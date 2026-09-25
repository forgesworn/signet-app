// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

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
import { purgeAllUserData } from '../lib/db';
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
