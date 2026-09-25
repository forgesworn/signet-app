// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the fetch/publish legs of dependants-sync before importing the hook,
// keeping the real toSyncWire/fromSyncWire/mergeDependantWithLocal/SYNC_D_TAG
// — this test is only concerned with the timer body's error handling (I2),
// not the merge logic (covered by dependants-sync.test.ts).
vi.mock('../lib/dependants-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/dependants-sync')>();
  return {
    ...actual,
    fetchDependantsSync: vi.fn(),
    publishDependantsSync: vi.fn(),
  };
});

import { fetchDependantsSync, publishDependantsSync } from '../lib/dependants-sync';
import { purgeAllUserData } from '../lib/db';
import { createNewIdentity } from '../lib/signet';
import type { DependantIdentity, SignetIdentity } from '../types';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import { useDependantsSync } from './useDependantsSync';

const mockFetch = vi.mocked(fetchDependantsSync);
const mockPublish = vi.mocked(publishDependantsSync);

const RELAY_URL = 'wss://relay.example.com';
const KEY = 'a'.repeat(64);
const DEP_NP = 'b'.repeat(64);
const DEP_PERSONA = 'c'.repeat(64);

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

function makeDependant(guardianPubkey: string, overrides: Partial<DependantIdentity> = {}): DependantIdentity {
  return {
    id: DEP_NP,
    guardianPubkey,
    displayName: 'Family Label',
    naturalPerson: { publicKey: DEP_NP, privateKey: '', displayName: '' },
    persona: { publicKey: DEP_PERSONA, privateKey: '', displayName: 'Persona' },
    // 'imported' never needs the guardian mnemonic to reconstitute on fetch.
    derivationPath: 'imported',
    createdAt: Math.floor(Date.now() / 1000),
    autonomyStage: 'full-control',
    primaryKeypair: 'natural-person',
    naturalPersonActive: false,
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

describe('useDependantsSync — debounced publish (I2)', () => {
  it('a rejecting publish yields no unhandled rejection and the hook stays usable', async () => {
    mockFetch.mockResolvedValue(null);
    mockPublish.mockRejectedValueOnce(new Error('signEvent boom'));

    const dep = makeDependant(identity.naturalPerson.publicKey);

    vi.useFakeTimers();
    const { rerender } = renderHook(
      (props: { dependants: DependantIdentity[] }) => useDependantsSync({
        identity,
        npBackend: backend,
        relayUrl: RELAY_URL,
        encryptionKey: KEY,
        guardianMnemonic: identity.mnemonic,
        dependants: props.dependants,
      }),
      { initialProps: { dependants: [dep] } },
    );

    await flushHydration();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(mockPublish).toHaveBeenCalledTimes(1);

    // A later local change still gets published on the next debounce cycle —
    // the rejection above must not have left the hook stuck.
    mockPublish.mockResolvedValue(true);
    const mutated = { ...dep, displayName: 'Changed Label' };
    rerender({ dependants: [mutated] });
    await flushHydration();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(mockPublish).toHaveBeenCalledTimes(2);
  });
});
