// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

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

import { fetchDependantsSync, publishDependantsSync, toSyncWire } from '../lib/dependants-sync';
import { purgeAllUserData, saveDependant, getDependants } from '../lib/db';
import { createNewIdentity } from '../lib/signet';
import type { DependantIdentity, SignetIdentity } from '../types';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import { useDependantsSync } from './useDependantsSync';
import { flushPendingPublishes, resetPendingPublishesForTests } from '../lib/pending-publish';

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
  resetPendingPublishesForTests();
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

describe('useDependantsSync — flush before lock', () => {
  it('flushPendingPublishes publishes a pending change before the debounce fires', async () => {
    mockFetch.mockResolvedValue(null);
    const dep = makeDependant(identity.naturalPerson.publicKey);

    vi.useFakeTimers();
    renderHook(() => useDependantsSync({
      identity,
      npBackend: backend,
      relayUrl: RELAY_URL,
      encryptionKey: KEY,
      guardianMnemonic: identity.mnemonic,
      dependants: [dep],
    }));

    await flushHydration();
    // Hydrated, timer armed, debounce (1 s) not yet elapsed.
    expect(mockPublish).not.toHaveBeenCalled();

    await act(async () => {
      await flushPendingPublishes();
    });
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });
});

/**
 * Real timers throughout: `saveDependant` / `getDependants` run real
 * 600k-iteration PBKDF2 for any slot that carries a private key, which a fake
 * clock never lets settle. The records here are view-only imports (no keys,
 * no mnemonic needed to reconcile) unless a test says otherwise.
 *
 * State the hook sets while a test is inside an `act` scope is only rendered
 * when that scope exits, so a negative assertion first lets one short `act`
 * flush hydration (arming the publish timer) and only then waits out the
 * debounce. Without that the "no publish" cases could pass without the
 * publish effect ever having been armed.
 */
describe('useDependantsSync: republish after a merge the local side won (#192)', () => {
  type Relays = { read: string[]; write: string[] };
  const RELAYS: Relays = { read: [RELAY_URL], write: [RELAY_URL] };
  const ID_X = 'c'.repeat(64);
  const ID_Y = 'd'.repeat(64);

  function makeViewOnly(id: string, overrides: Partial<DependantIdentity> = {}): DependantIdentity {
    return {
      id,
      guardianPubkey: identity.naturalPerson.publicKey,
      displayName: 'Kid',
      naturalPerson: { publicKey: id, privateKey: '', displayName: 'Kid' },
      persona: { publicKey: '', privateKey: '', displayName: '' },
      derivationPath: `imported-view-${id.slice(0, 8)}`,
      createdAt: 1000,
      autonomyStage: 'full-autonomy',
      primaryKeypair: 'natural-person',
      naturalPersonActive: true,
      ...overrides,
    };
  }

  const REMOTE = (...deps: DependantIdentity[]) => ({
    dependants: deps.map((d) => toSyncWire(d)!),
    createdAt: 12345,
    eventId: 'e'.repeat(64),
    reachableRelays: 1,
  });

  interface Props { dependants: DependantIdentity[]; relays?: Relays; guardianMnemonic?: string | null; deviceHeldKeys?: boolean }
  function renderDependants(initialProps: Props) {
    return renderHook(
      (props: Props) => useDependantsSync({
        identity,
        npBackend: backend,
        relays: props.relays ?? RELAYS,
        encryptionKey: KEY,
        guardianMnemonic: props.guardianMnemonic === undefined ? identity.mnemonic : props.guardianMnemonic,
        deviceHeldKeys: props.deviceHeldKeys,
        dependants: props.dependants,
      }),
      { initialProps },
    );
  }

  const stored = () => getDependants(identity.naturalPerson.publicKey, KEY);
  const settle = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  const publishes = (n: number) => waitFor(() => expect(mockPublish).toHaveBeenCalledTimes(n), { timeout: 10_000 });

  it('publishes a dependant only this device holds', async () => {
    await saveDependant(makeViewOnly(ID_X), KEY);
    await saveDependant(makeViewOnly(ID_Y, { displayName: 'Local only' }), KEY);
    mockFetch.mockResolvedValue(REMOTE(makeViewOnly(ID_X)));

    renderDependants({ dependants: await stored() });
    await publishes(1);
    expect((mockPublish.mock.calls[0][0] as DependantIdentity[]).map((d) => d.id).sort()).toEqual([ID_X, ID_Y]);
  }, 30_000);

  it('publishes when the LWW guard kept a newer local record whole', async () => {
    await saveDependant(makeViewOnly(ID_X, { displayName: 'Recreated', createdAt: 2000 }), KEY);
    mockFetch.mockResolvedValue(REMOTE(makeViewOnly(ID_X, { displayName: 'Stale', createdAt: 1000 })));

    renderDependants({ dependants: await stored() });
    await publishes(1);
    expect((mockPublish.mock.calls[0][0] as DependantIdentity[]).map((d) => d.displayName)).toEqual(['Recreated']);
  }, 30_000);

  it('does not publish when the relay is the richer side', async () => {
    await saveDependant(makeViewOnly(ID_X), KEY);
    mockFetch.mockResolvedValue(REMOTE(
      makeViewOnly(ID_X, { displayName: 'Renamed elsewhere' }),
      makeViewOnly(ID_Y, { displayName: 'Remote only' }),
    ));

    const { result, rerender } = renderDependants({ dependants: await stored() });
    await waitFor(() => expect(result.current.remoteState).toBe('present'));
    // App reloads its dependants after `onRemoteMerged`; mirror that with
    // what is now stored so the publish effect hashes the merged state.
    rerender({ dependants: await stored() });
    await settle(300);
    await settle(1800);

    expect(mockPublish).not.toHaveBeenCalled();
    expect((await stored()).map((d) => d.displayName).sort()).toEqual(['Remote only', 'Renamed elsewhere']);
  }, 30_000);

  it('does not read its own copy of a record it cannot reconcile as a local win', async () => {
    // A derived dependant on a device with no mnemonic and no device-held
    // keys: the remote record is skipped, not merged. The local copy carries
    // an extra the remote lacks, but that is the relay's record to hold.
    const derived = makeViewOnly(ID_X, {
      derivationPath: 'dependant-0',
      extraPersonas: [{ publicKey: 'e'.repeat(64), privateKey: '', displayName: 'Alt', derivationName: 'dependant-0-persona-1' }],
    });
    await saveDependant(derived, KEY);
    mockFetch.mockResolvedValue(REMOTE({ ...derived, extraPersonas: undefined }));

    const { result } = renderDependants({ dependants: await stored(), guardianMnemonic: null, deviceHeldKeys: false });
    await waitFor(() => expect(result.current.remoteState).toBe('present'));
    await settle(300);
    await settle(1800);

    expect(mockPublish).not.toHaveBeenCalled();
  }, 30_000);

  it('does not publish when the relay already holds exactly this state', async () => {
    await saveDependant(makeViewOnly(ID_X), KEY);
    mockFetch.mockResolvedValue(REMOTE(makeViewOnly(ID_X)));

    const { result } = renderDependants({ dependants: await stored() });
    await waitFor(() => expect(result.current.remoteState).toBe('present'));
    await settle(300);
    await settle(1800);

    expect(mockPublish).not.toHaveBeenCalled();
  }, 30_000);

  it('republishes a won merge even though this device already published that exact state', async () => {
    await saveDependant(makeViewOnly(ID_X), KEY);
    const local = await stored();
    mockFetch.mockResolvedValueOnce(null);

    const { rerender } = renderDependants({ dependants: local });
    await publishes(1);

    // Another device overwrote the relay with an empty record; the relay set
    // changing re-fetches it. Our dependant is something it lacks, so the
    // unchanged local state must go back out.
    mockFetch.mockResolvedValue(REMOTE());
    rerender({ dependants: local, relays: { read: ['wss://relay-two.example.com'], write: [RELAY_URL] } });
    await publishes(2);
  }, 30_000);

  it('does not publish after an unreachable fetch, even after a local change', async () => {
    mockFetch.mockResolvedValue('unreachable');

    const { result, rerender } = renderDependants({ dependants: [makeViewOnly(ID_X)] });
    await waitFor(() => expect(result.current.remoteState).toBe('unreachable'));
    await settle(300);
    rerender({ dependants: [makeViewOnly(ID_X, { displayName: 'Changed' })] });
    await settle(1800);

    expect(mockPublish).not.toHaveBeenCalled();
  }, 30_000);
});
