// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the fetch/publish legs of the personas-sync module before importing
// the hook, but keep the real mergePersonas / toWire / computePublishDelayMs
// / SYNC_D_TAG — the merge/wire logic itself is covered by
// personas-sync.test.ts, and reusing the real implementations here keeps
// this test honest about what the hook actually does with them.
vi.mock('../lib/personas-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/personas-sync')>();
  return {
    ...actual,
    fetchPersonasSync: vi.fn(),
    publishPersonasSync: vi.fn(),
  };
});

import { fetchPersonasSync, publishPersonasSync, SYNC_D_TAG } from '../lib/personas-sync';
import { getSyncSeen, setSyncSeen } from '../lib/sync-seen';
import { purgeAllUserData } from '../lib/db';
import { createNewIdentity } from '../lib/signet';
import type { ExtraPersona, RemotePersonasPatch, SignetIdentity } from '../types';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import type { HeartwoodRequestFn } from '../lib/heartwood-dependant-create';
import { deriveProfessionalPersona } from '../lib/professional/pro-persona';
import { usePersonasSync } from './usePersonasSync';

const mockFetch = vi.mocked(fetchPersonasSync);
const mockPublish = vi.mocked(publishPersonasSync);

const RELAYS = { read: ['wss://relay.example.com'], write: ['wss://relay.example.com'] };
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

function makeExtra(overrides: Partial<ExtraPersona> = {}): ExtraPersona {
  return {
    publicKey: 'f'.repeat(64),
    privateKey: '',
    displayName: 'Persona One',
    derivationName: 'persona-1',
    updatedAt: 500,
    ...overrides,
  };
}

let identity: SignetIdentity;
let backend: DecryptingSigningBackend;
let applyRemotePersonas: ReturnType<typeof vi.fn>;

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
  applyRemotePersonas = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Flush the async fetch-and-merge effect (mocked fetch resolves
 * immediately; the merge + reseed path still round-trips real
 * fake-indexeddb calls, which run on fake-timer-scheduled tasks once fake
 * timers are on).
 */
async function flushHydration() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
}

interface SyncProps {
  identity: SignetIdentity;
  deviceHeldKeys?: boolean;
  heartwoodRequestFn?: HeartwoodRequestFn | null;
  mnemonic?: string | null;
}

function renderSync(props: SyncProps) {
  return renderHook(
    (p: SyncProps) => usePersonasSync({
      identity: p.identity,
      npBackend: backend,
      relays: RELAYS,
      encryptionKey: KEY,
      mnemonic: p.mnemonic ?? null,
      deviceHeldKeys: p.deviceHeldKeys ?? true,
      heartwoodRequestFn: p.heartwoodRequestFn ?? null,
      applyRemotePersonas: applyRemotePersonas as unknown as (patch: RemotePersonasPatch) => Promise<void>,
      random: () => 0,
    }),
    { initialProps: props },
  );
}

describe('usePersonasSync — fetch-and-merge', () => {
  it('(a) applies a merged remote payload, reports present, and records seen', async () => {
    identity = { ...identity, extraPersonas: [] };
    mockFetch.mockResolvedValue({
      payload: {
        v: 1,
        personas: [{ derivationName: 'persona-1', publicKey: 'f'.repeat(64), displayName: 'Remote Persona', updatedAt: 500 }],
        tombstones: [],
      },
      createdAt: 12345,
      eventId: 'evt1',
      reachableRelays: 1,
    });

    vi.useFakeTimers();
    const { result } = renderSync({ identity });
    await flushHydration();

    expect(applyRemotePersonas).toHaveBeenCalledTimes(1);
    const patch = applyRemotePersonas.mock.calls[0][0] as RemotePersonasPatch;
    expect(patch.extraPersonas).toHaveLength(1);
    expect(patch.extraPersonas[0].derivationName).toBe('persona-1');
    expect(patch.tombstones).toEqual([]);

    expect(result.current.remoteState).toBe('present');

    // Switch to real timers before touching fake-indexeddb directly — its
    // async operations resolve via real timer callbacks that fake timers
    // would otherwise intercept and never advance.
    vi.useRealTimers();
    const seen = await getSyncSeen(identity.naturalPerson.publicKey, SYNC_D_TAG);
    expect(seen).toEqual({ eventId: 'evt1', createdAt: 12345 });
  });

  it('(b) no event, never seen before -> never-seen, no apply', async () => {
    mockFetch.mockResolvedValue(null);

    vi.useFakeTimers();
    const { result } = renderSync({ identity });
    await flushHydration();

    expect(applyRemotePersonas).not.toHaveBeenCalled();
    expect(result.current.remoteState).toBe('never-seen');
  });

  it('(c) no event but seen before -> missing-after-seen', async () => {
    await setSyncSeen(identity.naturalPerson.publicKey, SYNC_D_TAG, { eventId: 'old', createdAt: 1 });
    mockFetch.mockResolvedValue(null);

    vi.useFakeTimers();
    const { result } = renderSync({ identity });
    await flushHydration();

    expect(applyRemotePersonas).not.toHaveBeenCalled();
    expect(result.current.remoteState).toBe('missing-after-seen');
  });

  it('(d) all relays throw -> unreachable', async () => {
    mockFetch.mockResolvedValue('unreachable');

    vi.useFakeTimers();
    const { result } = renderSync({ identity });
    await flushHydration();

    expect(applyRemotePersonas).not.toHaveBeenCalled();
    expect(result.current.remoteState).toBe('unreachable');
  });

  it('(g) [regression] a cursor-suppressed null fetch after a present fetch stays present, not missing-after-seen', async () => {
    identity = { ...identity, extraPersonas: [] };
    const remotePersona = { derivationName: 'persona-1', publicKey: 'f'.repeat(64), displayName: 'Remote Persona', updatedAt: 500 };
    mockFetch.mockResolvedValueOnce({
      payload: { v: 1, personas: [remotePersona], tombstones: [] },
      createdAt: 12345,
      eventId: 'evt1',
      reachableRelays: 1,
    });

    vi.useFakeTimers();
    const { result, rerender } = renderSync({ identity });
    await flushHydration();
    expect(result.current.remoteState).toBe('present');

    // Next fetch: the relay answered but had nothing newer than our
    // cursor — simulates `fetchPersonasSync`'s "found, but not newer than
    // sinceCreatedAt" null overload, distinct from "nothing found at all".
    mockFetch.mockResolvedValueOnce(null);

    const mergedIdentity: SignetIdentity = {
      ...identity,
      extraPersonas: [makeExtra({ derivationName: 'persona-1', publicKey: 'f'.repeat(64), displayName: 'Remote Persona', updatedAt: 500 })],
    };
    rerender({ identity: mergedIdentity });
    await flushHydration();

    expect(result.current.remoteState).toBe('present');
  });

  it('(h) an unchanged round-trip still records seen and reports present', async () => {
    const localPersona = makeExtra({ derivationName: 'persona-1', publicKey: 'f'.repeat(64), displayName: 'Same', updatedAt: 500 });
    identity = { ...identity, extraPersonas: [localPersona] };
    mockFetch.mockResolvedValue({
      payload: {
        v: 1,
        personas: [{ derivationName: 'persona-1', publicKey: 'f'.repeat(64), displayName: 'Same', updatedAt: 500 }],
        tombstones: [],
      },
      createdAt: 12345,
      eventId: 'evt-unchanged',
      reachableRelays: 1,
    });

    vi.useFakeTimers();
    const { result } = renderSync({ identity });
    await flushHydration();

    expect(applyRemotePersonas).not.toHaveBeenCalled(); // changed === false
    expect(result.current.remoteState).toBe('present');

    vi.useRealTimers();
    const seen = await getSyncSeen(identity.naturalPerson.publicKey, SYNC_D_TAG);
    expect(seen).toEqual({ eventId: 'evt-unchanged', createdAt: 12345 });
  });

  it('(i) reports a skip when reconstitution is impossible (no mnemonic, no deviceHeldKeys)', async () => {
    identity = { ...identity, extraPersonas: [] };
    mockFetch.mockResolvedValue({
      payload: {
        v: 1,
        personas: [{ derivationName: 'persona-3', publicKey: '9'.repeat(64), displayName: 'Unreachable Key', updatedAt: 10 }],
        tombstones: [],
      },
      createdAt: 999,
      eventId: 'evt-skip',
      reachableRelays: 1,
    });

    vi.useFakeTimers();
    const { result } = renderSync({ identity, deviceHeldKeys: false });
    await flushHydration();

    expect(result.current.skipped).toEqual(['persona-3']);
  });
});

describe('usePersonasSync — publish suppressed after an unreachable fetch', () => {
  it('does not publish after an unreachable fetch, even after a local change', async () => {
    mockFetch.mockResolvedValue('unreachable');

    vi.useFakeTimers();
    const { rerender } = renderSync({ identity });
    await flushHydration();

    const identity2: SignetIdentity = { ...identity, extraPersonas: [makeExtra()] };
    rerender({ identity: identity2 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100_000);
    });

    expect(mockPublish).not.toHaveBeenCalled();
  });
});

describe('usePersonasSync — effect lifecycle', () => {
  it('never applies a fetch result that resolves after the hook has unmounted', async () => {
    let resolveFetch: ((v: Awaited<ReturnType<typeof fetchPersonasSync>>) => void) | undefined;
    mockFetch.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));
    identity = { ...identity, extraPersonas: [] };

    vi.useFakeTimers();
    const { unmount } = renderSync({ identity });

    // Let the effect kick off the fetch (it won't resolve yet), then
    // unmount before it does.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();

    resolveFetch?.({
      payload: {
        v: 1,
        personas: [{ derivationName: 'persona-9', publicKey: '7'.repeat(64), displayName: 'Late', updatedAt: 1 }],
        tombstones: [],
      },
      createdAt: 1,
      eventId: 'e',
      reachableRelays: 1,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(applyRemotePersonas).not.toHaveBeenCalled();
  });
});

describe('usePersonasSync — debounced publish-on-change', () => {
  it('(e) publishes once after the jittered delay, and not again for identical state', async () => {
    mockFetch.mockResolvedValue(null);

    vi.useFakeTimers();
    const { rerender } = renderSync({ identity });
    await flushHydration();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // random: () => 0 => computePublishDelayMs === 6000ms exactly.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5999);
    });
    expect(mockPublish).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(mockPublish).toHaveBeenCalledTimes(1);

    mockPublish.mockClear();

    // Re-render with a fresh object carrying identical content.
    const identity2: SignetIdentity = { ...identity };
    rerender({ identity: identity2 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6100);
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('(I2) a rejecting publish yields no unhandled rejection and the hook stays usable', async () => {
    const extra = makeExtra();
    identity = { ...identity, extraPersonas: [extra] };
    mockFetch.mockResolvedValue(null);
    mockPublish.mockRejectedValueOnce(new Error('signEvent boom'));

    vi.useFakeTimers();
    const { rerender } = renderSync({ identity });
    await flushHydration();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6100);
    });
    expect(mockPublish).toHaveBeenCalledTimes(1);

    // A later local change still gets published on the next debounce cycle —
    // the rejection above must not have left the hook stuck (no thrown
    // unhandled rejection, and lastPublishedHashRef was never advanced).
    mockPublish.mockResolvedValue(true);
    const mutatedExtra = { ...extra, displayName: 'Changed Name' };
    const identity2: SignetIdentity = { ...identity, extraPersonas: [mutatedExtra] };
    rerender({ identity: identity2 });
    await flushHydration();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6100);
    });
    expect(mockPublish).toHaveBeenCalledTimes(2);
  });

  it('(f) a change to an imported extra never triggers a republish (excluded from the wire)', async () => {
    const imported = makeExtra({ derivationName: '', imported: true, publicKey: 'e'.repeat(64), displayName: 'Imported One' });
    identity = { ...identity, extraPersonas: [imported] };
    mockFetch.mockResolvedValue(null);

    vi.useFakeTimers();
    const { rerender } = renderSync({ identity });
    await flushHydration();

    // First publish is expected — nothing was ever seeded from a fetch, so
    // the very first hash computed from local state differs from ''.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6100);
    });
    expect(mockPublish).toHaveBeenCalledTimes(1);

    mockPublish.mockClear();

    const mutatedImported = { ...imported, displayName: 'Changed Name' };
    const identity2: SignetIdentity = { ...identity, extraPersonas: [mutatedImported] };
    rerender({ identity: identity2 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6100);
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('(6a) does not self-republish immediately after applying a merged remote payload', async () => {
    identity = { ...identity, extraPersonas: [] };
    const remotePersona = { derivationName: 'persona-1', publicKey: 'f'.repeat(64), displayName: 'Remote Persona', updatedAt: 500 };
    mockFetch.mockResolvedValue({
      payload: { v: 1, personas: [remotePersona], tombstones: [] },
      createdAt: 12345,
      eventId: 'evt1',
      reachableRelays: 1,
    });

    vi.useFakeTimers();
    const { rerender } = renderSync({ identity });
    await flushHydration();

    // Simulate the reload App.tsx performs after `applyRemotePersonas` —
    // a fresh identity object reflecting exactly the merged state.
    const mergedIdentity: SignetIdentity = {
      ...identity,
      extraPersonas: [makeExtra({ derivationName: 'persona-1', publicKey: 'f'.repeat(64), displayName: 'Remote Persona', updatedAt: 500 })],
    };
    rerender({ identity: mergedIdentity });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6100);
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });
});

describe('usePersonasSync — republish after a merge the local side won', () => {
  it('publishes the merge when the local side won a field the relay does not hold', async () => {
    // Local persona-1 was renamed here at t=900; the relay's copy is the
    // old name at t=100, and the relay also carries a persona-2 this
    // device has never seen. The merge therefore keeps the local rename
    // AND adds persona-2 — a state neither side holds, so it must be
    // published, not silently swallowed by the post-fetch hash reseed.
    identity = {
      ...identity,
      extraPersonas: [makeExtra({ derivationName: 'persona-1', publicKey: 'f'.repeat(64), displayName: 'Local New', updatedAt: 900 })],
    };
    mockFetch.mockResolvedValue({
      payload: {
        v: 1,
        personas: [
          { derivationName: 'persona-1', publicKey: 'f'.repeat(64), displayName: 'Stale Remote', updatedAt: 100 },
          { derivationName: 'persona-2', publicKey: '1'.repeat(64), displayName: 'Remote Only', updatedAt: 200 },
        ],
        tombstones: [],
      },
      createdAt: 12345,
      eventId: 'evt-local-wins',
      reachableRelays: 1,
    });

    vi.useFakeTimers();
    renderSync({ identity });
    await flushHydration();

    expect(applyRemotePersonas).toHaveBeenCalledTimes(1);
    const patch = applyRemotePersonas.mock.calls[0][0] as RemotePersonasPatch;
    expect(patch.extraPersonas.find((p) => p.derivationName === 'persona-1')?.displayName).toBe('Local New');
    expect(patch.extraPersonas.some((p) => p.derivationName === 'persona-2')).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6100);
    });
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });
});

describe('usePersonasSync — Heartwood reconcile (bunker mode)', () => {
  it('never re-adds a tombstoned slot the device still knows about', async () => {
    identity = {
      ...identity,
      extraPersonas: [makeExtra({ derivationName: 'persona-1', publicKey: 'f'.repeat(64) })],
      extraPersonaTombstones: [{ derivationName: 'persona-2', removedAt: 1000 }],
    };
    mockFetch.mockResolvedValue(null);

    const heartwoodRequestFn: HeartwoodRequestFn = vi.fn().mockResolvedValue(JSON.stringify([
      { pubkey: 'f'.repeat(64), purpose: 'nostr:persona:persona-1', index: 1 },
      { pubkey: '1'.repeat(64), purpose: 'nostr:persona:persona-2', index: 2, personaName: 'Deleted Persona' },
    ]));

    vi.useFakeTimers();
    renderSync({ identity, deviceHeldKeys: true, heartwoodRequestFn });
    await flushHydration();

    expect(applyRemotePersonas).not.toHaveBeenCalled();
  });

  it('adds a device-derived persona keylessly without removing existing ones', async () => {
    const existing = makeExtra({ derivationName: 'persona-1', publicKey: 'f'.repeat(64) });
    identity = { ...identity, extraPersonas: [existing] };
    mockFetch.mockResolvedValue(null);

    const heartwoodRequestFn: HeartwoodRequestFn = vi.fn().mockResolvedValue(JSON.stringify([
      { pubkey: 'f'.repeat(64), purpose: 'nostr:persona:persona-1', index: 1 },
      { pubkey: '1'.repeat(64), purpose: 'nostr:persona:persona-2', index: 2, personaName: 'Device Persona' },
    ]));

    vi.useFakeTimers();
    renderSync({ identity, deviceHeldKeys: true, heartwoodRequestFn });
    await flushHydration();

    expect(applyRemotePersonas).toHaveBeenCalledTimes(1);
    const patch = applyRemotePersonas.mock.calls[0][0] as RemotePersonasPatch;
    expect(patch.extraPersonas).toHaveLength(2);
    const added = patch.extraPersonas.find((p) => p.publicKey === '1'.repeat(64));
    expect(added).toBeDefined();
    expect(added?.privateKey).toBe('');
    expect(added?.derivationName).toBe('persona-2');
    expect(added?.displayName).toBe('Device Persona');
    // Existing persona untouched / still present.
    expect(patch.extraPersonas.some((p) => p.publicKey === 'f'.repeat(64))).toBe(true);
  });

  it('is silent on failure and never removes anything based on the device list', async () => {
    identity = { ...identity, extraPersonas: [makeExtra()] };
    mockFetch.mockResolvedValue(null);

    const heartwoodRequestFn: HeartwoodRequestFn = vi.fn().mockRejectedValue(new Error('device offline'));

    vi.useFakeTimers();
    const { result } = renderSync({ identity, deviceHeldKeys: true, heartwoodRequestFn });
    await flushHydration();

    // The failure must not surface anywhere or block the rest of hydration.
    expect(result.current.remoteState).toBe('never-seen');
    expect(applyRemotePersonas).not.toHaveBeenCalled();
  });

  it('never shadows a known derivationName under a different pubkey', async () => {
    // Local already has persona-1 under pubkey f...f. The device reports a
    // DIFFERENT pubkey for the same derivationName (e.g. a stale/foreign
    // device record) — this must never be added, since it would let a
    // second identity claim a slot name the rail already has an answer for.
    const existing = makeExtra({ derivationName: 'persona-1', publicKey: 'f'.repeat(64) });
    identity = { ...identity, extraPersonas: [existing] };
    mockFetch.mockResolvedValue(null);

    const heartwoodRequestFn: HeartwoodRequestFn = vi.fn().mockResolvedValue(JSON.stringify([
      { pubkey: '2'.repeat(64), purpose: 'nostr:persona:persona-1', index: 1 },
    ]));

    vi.useFakeTimers();
    const { result } = renderSync({ identity, deviceHeldKeys: true, heartwoodRequestFn });
    await flushHydration();

    expect(applyRemotePersonas).not.toHaveBeenCalled();
    expect(result.current.remoteState).toBe('never-seen');
  });

  it('(6e) a never-resolving Heartwood request times out silently after 6s; the relay merge still reports present', async () => {
    identity = { ...identity, extraPersonas: [] };
    mockFetch.mockResolvedValue({
      payload: {
        v: 1,
        personas: [{ derivationName: 'persona-1', publicKey: 'f'.repeat(64), displayName: 'Remote', updatedAt: 1 }],
        tombstones: [],
      },
      createdAt: 5,
      eventId: 'evt-hw-timeout',
      reachableRelays: 1,
    });
    const heartwoodRequestFn: HeartwoodRequestFn = vi.fn(() => new Promise<string>(() => { /* never resolves */ }));

    vi.useFakeTimers();
    const { result } = renderSync({ identity, deviceHeldKeys: true, heartwoodRequestFn });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6100);
    });

    expect(result.current.remoteState).toBe('present');
    // Exactly one apply — from the relay merge. The Heartwood timeout must
    // not produce a second (or any) apply of its own.
    expect(applyRemotePersonas).toHaveBeenCalledTimes(1);
  });
});

describe('usePersonasSync — Professional slot conjured on receipt', () => {
  /**
   * A device that has never opened the Pro surface has no
   * `professionalPersona`. It must still adopt the other device's Pro name
   * rather than drop it AND republish a record with no `professional`
   * block, which would destroy that backup and flap once per app start.
   */
  function remoteWithPro(publicKey: string) {
    return {
      payload: {
        v: 1 as const,
        personas: [],
        tombstones: [],
        professional: { publicKey, displayName: 'Dr Remote', updatedAt: 1000 },
      },
      createdAt: 12345,
      eventId: 'evt-pro',
      reachableRelays: 1,
    };
  }

  it('(a) local mnemonic re-derives the wire pubkey: slot conjured, nothing republished', async () => {
    identity = { ...identity, extraPersonas: [], professionalPersona: undefined };
    const pro = deriveProfessionalPersona(identity.mnemonic);
    mockFetch.mockResolvedValue(remoteWithPro(pro.publicKey));

    vi.useFakeTimers();
    const { rerender } = renderSync({ identity, deviceHeldKeys: false, mnemonic: identity.mnemonic });
    await flushHydration();

    expect(applyRemotePersonas).toHaveBeenCalledTimes(1);
    const patch = applyRemotePersonas.mock.calls[0][0] as RemotePersonasPatch;
    expect(patch.professional).toEqual({ displayName: 'Dr Remote', updatedAt: 1000 });
    expect(patch.professionalSlot).toEqual({ publicKey: pro.publicKey, privateKey: pro.privateKey });

    // Simulate App.tsx's reload after the write — the identity now carries
    // the conjured slot, exactly as the hook's synthetic mergedIdentity did.
    rerender({
      identity: {
        ...identity,
        professionalPersona: { ...pro, displayName: 'Dr Remote', updatedAt: 1000 },
      },
      deviceHeldKeys: false,
      mnemonic: identity.mnemonic,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100_000);
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('(b) device-held keys: slot conjured keyless, nothing republished', async () => {
    identity = { ...identity, extraPersonas: [], professionalPersona: undefined };
    const WIRE_PRO = '7'.repeat(64);
    mockFetch.mockResolvedValue(remoteWithPro(WIRE_PRO));

    vi.useFakeTimers();
    const { rerender } = renderSync({ identity, deviceHeldKeys: true });
    await flushHydration();

    const patch = applyRemotePersonas.mock.calls[0][0] as RemotePersonasPatch;
    expect(patch.professionalSlot).toEqual({ publicKey: WIRE_PRO, privateKey: '' });

    rerender({
      identity: {
        ...identity,
        professionalPersona: { publicKey: WIRE_PRO, privateKey: '', displayName: 'Dr Remote', updatedAt: 1000 },
      },
      deviceHeldKeys: true,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100_000);
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('(c) a mnemonic that derives a DIFFERENT pubkey conjures nothing and still never republishes', async () => {
    // naturalPersonActive: false — this test is about the professional-slot
    // conjuring rule, not NP activation; without this the fixture's default
    // "already active" identity vs. an absent remote flag would ALSO count
    // as richer (correctly, per the OR-merge rule) and mask what's being
    // tested here.
    identity = { ...identity, extraPersonas: [], professionalPersona: undefined, naturalPersonActive: false };
    mockFetch.mockResolvedValue(remoteWithPro('3'.repeat(64)));

    vi.useFakeTimers();
    renderSync({ identity, deviceHeldKeys: false, mnemonic: identity.mnemonic });
    await flushHydration();

    // Nothing to write the rename into ⇒ no apply at all…
    expect(applyRemotePersonas).not.toHaveBeenCalled();

    // …and the relay is the richer side, so this device must NOT publish
    // its Pro-less record over it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100_000);
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('(c2) a persona this device cannot reconstitute is remote-richer, never republished', async () => {
    // naturalPersonActive: false — see the comment on (c) above; this test
    // is about the skipped-persona richer-ness rule, not NP activation.
    identity = { ...identity, extraPersonas: [], naturalPersonActive: false };
    mockFetch.mockResolvedValue({
      payload: {
        v: 1 as const,
        personas: [{ derivationName: 'persona-3', publicKey: '9'.repeat(64), displayName: 'Unreachable', updatedAt: 10 }],
        tombstones: [],
      },
      createdAt: 999,
      eventId: 'evt-skip-2',
      reachableRelays: 1,
    });

    vi.useFakeTimers();
    const { result } = renderSync({ identity, deviceHeldKeys: false });
    await flushHydration();

    expect(result.current.skipped).toEqual(['persona-3']);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100_000);
    });
    expect(mockPublish).not.toHaveBeenCalled();
  });
});


it('resets the fetch cursor and backup status when switching authors in the same hook', async () => {
  mockFetch.mockResolvedValue({
    payload: { v: 1, personas: [], tombstones: [] }, createdAt: 12345,
    eventId: 'old-author-event', reachableRelays: 1,
  });
  vi.useFakeTimers();
  const hook = renderSync({ identity });
  await flushHydration();
  expect(hook.result.current.remoteState).toBe('present');

  const other = createNewIdentity('Other', 'natural-person', false);
  mockFetch.mockResolvedValue(null);
  hook.rerender({ identity: other });
  await flushHydration();
  const lastCall = mockFetch.mock.calls.at(-1)!;
  expect(lastCall[0]).toBe(other.naturalPerson.publicKey);
  expect(lastCall[3]).toBeUndefined();
  expect(hook.result.current.remoteState).toBe('never-seen');
  hook.unmount();
});
