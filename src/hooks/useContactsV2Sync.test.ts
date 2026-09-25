// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock the fetch/publish legs, keep the real tags, selectors and triggers —
// same posture as usePersonasSync.test.ts. The rail logic has its own suite;
// reusing the real helpers keeps this test honest about what the hook does.
vi.mock('../lib/contacts-v2-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/contacts-v2-sync')>();
  return {
    ...actual,
    fetchContactsV2Sync: vi.fn(),
    publishContactsV2Outbox: vi.fn(),
    publishContactsV2Checkpoint: vi.fn(),
  };
});

import {
  fetchContactsV2Sync,
  publishContactsV2Outbox,
  publishContactsV2Checkpoint,
  tagFor,
} from '../lib/contacts-v2-sync';
import { getSyncSeen, setSyncSeen } from '../lib/sync-seen';
import { purgeAllUserData, listAllContactOperationsV2, saveContactOperationV2, saveContactOperationsV2 } from '../lib/db';
import * as db from '../lib/db';
import { createNewIdentity } from '../lib/signet';
import type { ContactOperation, SignetIdentity } from '../types';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import { useContactsV2Sync } from './useContactsV2Sync';

const mockFetch = vi.mocked(fetchContactsV2Sync);
const mockOutbox = vi.mocked(publishContactsV2Outbox);
const mockCheckpoint = vi.mocked(publishContactsV2Checkpoint);

const RELAYS = { read: ['wss://relay.example.com'], write: ['wss://relay.example.com'] };
const KEY = 'a'.repeat(64);
const DEVICE = 'd'.repeat(32);
const CID = '0'.repeat(32);

let seq = 0;
function opId(): string {
  seq += 1;
  return seq.toString(16).padStart(32, '0');
}

function op(overrides: Partial<ContactOperation> = {}): ContactOperation {
  return {
    operationId: opId(),
    directoryId: 'owner',
    contactId: CID,
    actorPubkey: '1'.repeat(64),
    actorRole: 'owner',
    actorDeviceId: DEVICE,
    logicalClock: 1,
    action: 'add',
    value: { type: 'person', displayName: 'Dave', tier: 'kith' },
    createdAt: 1_000,
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

/** A `'present'` remote, the shape Task 9 returns. */
function present(ops: ContactOperation[], over: Record<string, unknown> = {}) {
  return {
    ops,
    checkpointState: 'present' as const,
    checkpoint: {
      seq: 1, createdAt: 1_000, deviceIds: [DEVICE],
      frontierOpIds: ops.map((o) => o.operationId), frontierMaxClock: 1,
      eventId: 'e'.repeat(64), eventCreatedAt: 500,
      ...over,
    },
    reachableRelays: 1,
  };
}

let identity: SignetIdentity;
let backend: DecryptingSigningBackend;
let onRemoteMerged: ReturnType<typeof vi.fn>;
let onVerifiedChange: ReturnType<typeof vi.fn>;
let onBackupStateChange: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  // Real timers for the IDB setup — fake-indexeddb schedules its callbacks via
  // fake-able setImmediate, so IDB work must resolve before fake timers engage.
  await purgeAllUserData();
  seq = 0;
  mockFetch.mockReset();
  mockOutbox.mockReset().mockResolvedValue(true);
  mockCheckpoint.mockReset().mockResolvedValue(true);
  identity = createNewIdentity('Guardian', 'natural-person', false);
  backend = makeBackend(identity.naturalPerson.publicKey);
  onRemoteMerged = vi.fn();
  onVerifiedChange = vi.fn();
  onBackupStateChange = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

async function flushHydration() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
}

/**
 * Run an IndexedDB read/write outside fake timers. fake-indexeddb schedules
 * its callbacks on `setImmediate`, which vitest's fake timers capture — an
 * un-advanced `await db.…` would hang. Effect-internal IDB work is driven by
 * `advanceTimersByTimeAsync` instead; this is for assertions and setup.
 */
async function withRealTimers<T>(fn: () => Promise<T>): Promise<T> {
  vi.useRealTimers();
  try { return await fn(); } finally { vi.useFakeTimers(); }
}

function renderSync(opsVersion = 0) {
  return renderHook((v: number) => useContactsV2Sync({
    identity,
    npBackend: backend,
    relays: RELAYS,
    encryptionKey: KEY,
    deviceId: DEVICE,
    opsVersion: v,
    onRemoteMerged: onRemoteMerged as unknown as () => void,
    onVerifiedChange: onVerifiedChange as unknown as (verified: boolean) => void,
    random: () => 0,
  }), { initialProps: opsVersion });
}

describe('useContactsV2Sync — fetch and merge', () => {
  it('persists remote operations the local log does not have, records the seq, and reports present', async () => {
    const remoteOp = op();
    mockFetch.mockResolvedValue(present([remoteOp], { seq: 4 }));
    vi.useFakeTimers();
    const { result } = renderSync();
    await flushHydration();
    // The merge writes `remoteOp` through `saveContactOperationsV2`, a real
    // AES-256-GCM/PBKDF2 WebCrypto call — dispatched to Node's real
    // threadpool, so it needs genuine wall-clock time to settle, which a
    // *virtual* `advanceTimersByTimeAsync` never provides (it fast-forwards
    // the fake clock without yielding to the real event loop). `waitFor`
    // polls under REAL timers (I3: no more guessed fixed sleeps) — every
    // other test in this file has an empty `ops` list and never hits this
    // path; this is the one place that needs it. Wait on `onRemoteMerged`
    // specifically, not `remoteState` — the latter flips to `'present'`
    // BEFORE the merge/write below it in the same async chain, so polling
    // for it alone can resolve before the write has actually happened.
    await withRealTimers(() => waitFor(() => {
      expect(onRemoteMerged).toHaveBeenCalledTimes(1);
    }));

    expect(result.current.remoteState).toBe('present');
    expect(result.current.backupState).toBe('ok');
    expect(await withRealTimers(() => listAllContactOperationsV2(KEY))).toHaveLength(1);
    // R2: the sequence is persisted beside the event id, so `nextCheckpointSeq`
    // cannot regress after a fetch that could not read the current checkpoint.
    expect(await withRealTimers(() => getSyncSeen(identity.naturalPerson.publicKey, tagFor(identity.naturalPerson.publicKey, 'checkpoint')))).toEqual({
      eventId: 'e'.repeat(64), createdAt: 500, seq: 4,
    });
  });

  it('passes the persisted seq and event time back into the next fetch (R2)', async () => {
    await withRealTimers(async () => {
      await setSyncSeen(identity.naturalPerson.publicKey, tagFor(identity.naturalPerson.publicKey, 'checkpoint'), {
        eventId: 'z'.repeat(64), createdAt: 900, seq: 7,
      });
    });
    mockFetch.mockResolvedValue(present([], { seq: 7, eventCreatedAt: 900 }));
    vi.useFakeTimers();
    renderSync();
    await flushHydration();
    expect(mockFetch.mock.calls[0][0].persisted).toEqual({ seq: 7, eventCreatedAt: 900 });
  });

  it('does not re-save an operation it already holds, and does not call onRemoteMerged', async () => {
    const existing = op();
    await saveContactOperationV2(existing, KEY);
    mockFetch.mockResolvedValue(present([existing]));
    vi.useFakeTimers();
    renderSync();
    await flushHydration();

    expect(await withRealTimers(() => listAllContactOperationsV2(KEY))).toHaveLength(1);
    expect(onRemoteMerged).not.toHaveBeenCalled();
  });

  it('reports unreachable and never-seen and missing-after-seen', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue('unreachable');
    const first = renderSync();
    await flushHydration();
    expect(first.result.current.remoteState).toBe('unreachable');
    first.unmount();

    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'absent', reachableRelays: 1 });
    const second = renderSync();
    await flushHydration();
    expect(second.result.current.remoteState).toBe('never-seen');
    second.unmount();

    await withRealTimers(() => setSyncSeen(identity.naturalPerson.publicKey,
      tagFor(identity.naturalPerson.publicKey, 'checkpoint'),
      { eventId: 'z'.repeat(64), createdAt: 1 },
    ));
    const third = renderSync();
    await flushHydration();
    expect(third.result.current.remoteState).toBe('missing-after-seen');
  });

  it('never reports a lost backup for a checkpoint it simply could not read (R9)', async () => {
    await withRealTimers(() => setSyncSeen(identity.naturalPerson.publicKey,
      tagFor(identity.naturalPerson.publicKey, 'checkpoint'),
      { eventId: 'z'.repeat(64), createdAt: 1, seq: 3 },
    ));
    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'unusable', reachableRelays: 1 });
    vi.useFakeTimers();
    const { result } = renderSync();
    await flushHydration();
    // A record IS there. "Your contact backup is missing from your relay" would
    // be a lie, and the alarming kind.
    expect(result.current.remoteState).toBe('present');
    // ...and the unreadable checkpoint must not overwrite what we recorded.
    expect(await withRealTimers(() => getSyncSeen(identity.naturalPerson.publicKey, tagFor(identity.naturalPerson.publicKey, 'checkpoint')))).toEqual({
      eventId: 'z'.repeat(64), createdAt: 1, seq: 3,
    });
  });

  it('reports the v2-canonical check only once it has read back a checkpoint naming this device (R10)', async () => {
    vi.useFakeTimers();
    // A checkpoint that does not list this device proves nothing about this
    // device's own operations having survived a round trip.
    mockFetch.mockResolvedValue(present([], { deviceIds: ['9'.repeat(32)] }));
    const first = renderSync();
    await flushHydration();
    expect(onVerifiedChange).not.toHaveBeenCalledWith(true);
    first.unmount();

    onVerifiedChange.mockClear();
    mockFetch.mockResolvedValue(present([], { deviceIds: [DEVICE] }));
    renderSync();
    await flushHydration();
    expect(onVerifiedChange).toHaveBeenCalledWith(true);
  });

  it('does not run at all without an identity, backend, device id, key or read relay', async () => {
    vi.useFakeTimers();
    renderHook(() => useContactsV2Sync({
      identity: null, npBackend: backend, relays: RELAYS, encryptionKey: KEY,
      deviceId: DEVICE, opsVersion: 0, random: () => 0,
    }));
    renderHook(() => useContactsV2Sync({
      identity, npBackend: backend, relays: RELAYS, encryptionKey: KEY,
      deviceId: null, opsVersion: 0, random: () => 0,
    }));
    await flushHydration();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('treats a fetch that rejects as unreachable, not as an unknown relay (R2/S11)', async () => {
    mockFetch.mockRejectedValue(new Error('relay exploded'));
    vi.useFakeTimers();
    const { result } = renderSync();
    await flushHydration();
    // Leaving this null would let Task 12's publish effect run: it gates on
    // `remoteState === 'unreachable'`, and a thrown fetch is exactly the state
    // in which we know least about what is on the relay.
    expect(result.current.remoteState).toBe('unreachable');
    // Hydration still completed, so a later successful fetch resumes publishing
    // rather than the device being stranded for the session.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * The "publish" suite below runs entirely on REAL timers — no
 * `vi.useFakeTimers()` anywhere in this describe block — combined with I3's
 * `publishDelayMs` test override, which replaces the real 6-90s jittered
 * debounce with ~5 ms for every test except the one that specifically
 * exercises the real timing (`does not publish before the jitter window
 * elapses`).
 *
 * An earlier version of this suite mixed fake timers with the real
 * ~600k-iteration PBKDF2 decrypts every local operation costs (both the
 * fetch effect's merge-read and the debounced publish callback's own
 * re-read): `vi.useFakeTimers()` / `vi.useRealTimers()` toggling proved
 * unreliable under that load — sometimes a debounce `setTimeout` scheduled
 * on one fake-clock "generation" was silently lost across a toggle
 * (0 publishes where 1 was expected), sometimes the opposite happened (2
 * publishes where 1 was expected), and both were TIMING-DEPENDENT, not
 * deterministic. Real timers throughout removes that hazard; `publishDelayMs`
 * plus `waitFor` (I3) removes the fixed-sleep guesswork AND the multi-second
 * cost per test — this file now runs in a few seconds, not minutes.
 */
/**
 * Deliberately NOT wrapped in `act()`: React's async `act()` batches and
 * defers committing state updates that resolve DURING its callback until the
 * callback itself returns — including updates from a completely unrelated
 * in-flight effect (this hook's own fetch/hydration chain), which is not
 * "act"ing on anything this call does. Wrapping a bystander real-time wait
 * in `act()` was observed to delay `hydrated` flipping true by the ENTIRE
 * wait duration (a 5000 ms wait made hydration itself measure ~5000 ms,
 * regardless of how fast the underlying crypto actually was) — exactly
 * backwards from the intent. A bare wait lets React flush updates as they
 * genuinely happen; `waitFor` (used for every positive assertion in this
 * file) already handles `act()` wrapping correctly per poll.
 */
async function realWait(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** A `'present'` remote at seq 4, carrying `checkpointOpIds` in its frontier. */
const PRESENT = (ops: ContactOperation[], checkpointOpIds: string[], over: Record<string, unknown> = {}) => ({
  ops,
  checkpointState: 'present' as const,
  checkpoint: {
    seq: 4, createdAt: Date.now(), deviceIds: [DEVICE],
    frontierOpIds: checkpointOpIds, frontierMaxClock: 1,
    eventId: 'e'.repeat(64), eventCreatedAt: 500,
    ...over,
  },
  reachableRelays: 1,
});

interface PublishSyncProps {
  opsVersion?: number;
  relays?: { read: string[]; write: string[] };
  /** I3: defaults to ~5 ms — omit (pass `undefined`) for the real 6000 ms debounce. */
  publishDelayMs?: number;
  maxCheckpointOps?: number;
  maxOutboxOps?: number;
  /** Fix round 2, point 3: override the identity/backend the hook sees. */
  identity?: SignetIdentity;
  npBackend?: DecryptingSigningBackend;
  /** I1: override the encryption key — `null` simulates a lock. */
  encryptionKey?: string | null;
}

/**
 * One render helper for the whole "publish" suite, parameterised by
 * `rerender(props)` rather than a family of single-purpose wrappers —
 * every test that needs to re-trigger the FETCH effect (a relay-list edit,
 * or a whole identity swap) or the PUBLISH effect (an `opsVersion` bump)
 * does it by passing new props.
 */
function renderPublishSync(initial: PublishSyncProps = {}) {
  return renderHook((p: PublishSyncProps) => useContactsV2Sync({
    identity: p.identity ?? identity,
    npBackend: p.npBackend ?? backend,
    relays: p.relays ?? RELAYS,
    encryptionKey: 'encryptionKey' in p ? p.encryptionKey ?? null : KEY,
    deviceId: DEVICE,
    opsVersion: p.opsVersion ?? 0,
    onRemoteMerged: onRemoteMerged as unknown as () => void,
    onVerifiedChange: onVerifiedChange as unknown as (verified: boolean) => void,
    onBackupStateChange: onBackupStateChange as unknown as (state: 'ok' | 'too-large' | 'stalled') => void,
    random: () => 0,
    publishDelayMs: 'publishDelayMs' in p ? p.publishDelayMs : 5,
    maxCheckpointOps: p.maxCheckpointOps,
    maxOutboxOps: p.maxOutboxOps,
  }), { initialProps: initial });
}

describe('useContactsV2Sync — publish', () => {
  it('publishes only what the checkpoint does not already carry, as an outbox', async () => {
    const carried = op();
    const mine = op({ logicalClock: 5 });
    await saveContactOperationV2(carried, KEY);
    await saveContactOperationV2(mine, KEY);
    mockFetch.mockResolvedValue(PRESENT([carried], [carried.operationId]));

    renderPublishSync();
    await waitFor(() => expect(mockOutbox).toHaveBeenCalledTimes(1));

    expect(mockCheckpoint).not.toHaveBeenCalled();
    expect(mockOutbox.mock.calls[0][0].deviceId).toBe(DEVICE);
    expect(mockOutbox.mock.calls[0][0].ops).toEqual([mine]);
    expect(mockOutbox.mock.calls[0][0].baseFrontierMaxClock).toBe(1);
  });

  it('publishes nothing when the checkpoint already carries everything', async () => {
    const carried = op();
    await saveContactOperationV2(carried, KEY);
    mockFetch.mockResolvedValue(PRESENT([carried], [carried.operationId]));

    // Anchor on hydration actually completing before the negative wait — a
    // blind fixed wait proves only "nothing happened YET", not "nothing
    // published"; if hydration ever outlasted the fixed budget this would
    // pass vacuously (Fix round 2, point 1).
    const { result } = renderPublishSync();
    await waitFor(() => expect(result.current.remoteState).toBe('present'));
    await realWait(300);

    expect(mockOutbox).not.toHaveBeenCalled();
    expect(mockCheckpoint).not.toHaveBeenCalled();
  });

  it('publishes a checkpoint when the relay has none, carrying the whole local log', async () => {
    const a = op();
    const b = op({ logicalClock: 2 });
    await saveContactOperationV2(a, KEY);
    await saveContactOperationV2(b, KEY);
    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'absent', reachableRelays: 1 });

    renderPublishSync();
    await waitFor(() => expect(mockCheckpoint).toHaveBeenCalledTimes(1));

    expect(mockOutbox).not.toHaveBeenCalled();
    const args = mockCheckpoint.mock.calls[0][0];
    expect(args.seq).toBe(1);
    expect(args.deviceIds).toEqual([DEVICE]);
    expect(args.ops.map((o) => o.operationId).sort()).toEqual([a.operationId, b.operationId].sort());
  });

  it('NEVER compacts over a checkpoint it could not read — it publishes its outbox instead (R2/S1)', async () => {
    const mine = op();
    await saveContactOperationV2(mine, KEY);
    // A checkpoint event exists; one chunk was missing, or the decrypt failed.
    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'unusable', reachableRelays: 1 });

    renderPublishSync();
    await waitFor(() => expect(mockOutbox).toHaveBeenCalledTimes(1));

    // Replacing the live checkpoint with a seq-1 one carrying only this
    // device's operations is exactly the data loss this state exists to stop.
    expect(mockCheckpoint).not.toHaveBeenCalled();
    // The outbox is still published — that leg is lossless, it only ever adds.
    expect(mockOutbox.mock.calls[0][0].ops).toEqual([mine]);
  });

  it('never regresses the checkpoint sequence after an unreadable read (R2)', async () => {
    await setSyncSeen(identity.naturalPerson.publicKey,
      tagFor(identity.naturalPerson.publicKey, 'checkpoint'),
      { eventId: 'z'.repeat(64), createdAt: 900, seq: 9 },
    );
    await saveContactOperationV2(op(), KEY);
    // The relay lost the checkpoint entirely; this device still knows a seq 9
    // once existed, and its chunk tags are `...:chunk:<seq>:<index>`.
    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'absent', reachableRelays: 1 });

    renderPublishSync();
    await waitFor(() => expect(mockCheckpoint).toHaveBeenCalledTimes(1));

    expect(mockCheckpoint.mock.calls[0][0].seq).toBe(10);
  });

  // I1: `getSyncSeen` reflects the last RELAY READ this device saw, not a
  // publish this device itself made (only a subsequent fetch updates it) —
  // so a stale/absent local row on a re-triggered fetch must not walk the
  // in-memory high-water mark backwards under a device that already
  // published past it.
  it('never regresses the in-memory persisted seq across a relay-list edit that re-runs the fetch (I1)', async () => {
    await setSyncSeen(identity.naturalPerson.publicKey,
      tagFor(identity.naturalPerson.publicKey, 'checkpoint'),
      { eventId: 'z'.repeat(64), createdAt: 900, seq: 4 },
    );
    await saveContactOperationV2(op(), KEY);
    // Always answers 'absent' — this device's own successful publish below
    // is never reflected back, exactly like a mock that doesn't model the
    // relay actually storing what was written to it.
    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'absent', reachableRelays: 1 });

    const { rerender } = renderPublishSync({ relays: { read: ['wss://relay.example.com'], write: RELAYS.write } });
    await waitFor(() => expect(mockCheckpoint).toHaveBeenCalledTimes(1));
    expect(mockCheckpoint.mock.calls[0][0].seq).toBe(5);

    // A relay-list edit re-runs the FETCH effect (`readRelaysKey` changed).
    // The local `syncSeen` row is still the stale seq-4 one from above.
    rerender({ relays: { read: ['wss://relay2.example.com'], write: RELAYS.write } });
    await waitFor(() => expect(mockCheckpoint).toHaveBeenCalledTimes(2));
    // Not 5 (the stale local row) and not 1 (a naive reset) — 6.
    expect(mockCheckpoint.mock.calls[1][0].seq).toBe(6);
  });

  it('re-inserts this device when the checkpoint stopped listing it (R7)', async () => {
    const carried = op();
    await saveContactOperationV2(carried, KEY);
    // Evicted at the cap by another device. Nothing local changed, and the
    // outbox is empty — but nobody will read this device's outbox again.
    mockFetch.mockResolvedValue(PRESENT([carried], [carried.operationId], { deviceIds: ['9'.repeat(32)] }));

    renderPublishSync();
    await waitFor(() => expect(mockCheckpoint).toHaveBeenCalledTimes(1));

    expect(mockCheckpoint.mock.calls[0][0].deviceIds).toEqual(['9'.repeat(32), DEVICE]);
  });

  it('publishes nothing at all when there is nothing local and nothing remote', async () => {
    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'absent', reachableRelays: 1 });
    // No local ops, nothing seen before ⇒ 'never-seen' (Fix round 2, point 1
    // anchor: `classifyFetchOutcome({found:false, reachableRelays:1,
    // seenBefore:false})`).
    const { result } = renderPublishSync();
    await waitFor(() => expect(result.current.remoteState).toBe('never-seen'));
    await realWait(300);
    expect(mockCheckpoint).not.toHaveBeenCalled();
    expect(mockOutbox).not.toHaveBeenCalled();
  });

  it('recompacts into a new checkpoint when the outbox passes the threshold', async () => {
    const carried = op();
    const rest = Array.from({ length: 51 }, (_, i) => op({ logicalClock: i + 2 }));
    // I2: batch-saved (one PBKDF2 derivation for the 51 rows) — the OLD
    // one-row-at-a-time save is what used to make this test itself the
    // slowest thing in the file, unrelated to what it is testing.
    await saveContactOperationV2(carried, KEY);
    await saveContactOperationsV2(rest, KEY);
    mockFetch.mockResolvedValue(PRESENT([carried], [carried.operationId]));

    renderPublishSync();
    await waitFor(() => expect(mockCheckpoint).toHaveBeenCalledTimes(1));

    expect(mockOutbox).not.toHaveBeenCalled();
    expect(mockCheckpoint.mock.calls[0][0].seq).toBe(5);
    expect(mockCheckpoint.mock.calls[0][0].ops).toHaveLength(52);
  });

  it('does not publish over a pool the fetch could not reach', async () => {
    await saveContactOperationV2(op(), KEY);
    mockFetch.mockResolvedValue('unreachable');
    const { result } = renderPublishSync();
    await waitFor(() => expect(result.current.remoteState).toBe('unreachable'));
    await realWait(300);
    expect(mockOutbox).not.toHaveBeenCalled();
    expect(mockCheckpoint).not.toHaveBeenCalled();
  });

  // M2: `remote === null` (a malformed-author signal) must gate the publish
  // effect off exactly like `'unreachable'` — this pins that by proving no
  // publish happens even though nothing else in this test looks unreachable.
  it('does not publish when the fetch reports a malformed author (M2)', async () => {
    await saveContactOperationV2(op(), KEY);
    mockFetch.mockResolvedValue(null);
    const { result } = renderPublishSync();
    await waitFor(() => expect(result.current.remoteState).toBe('unreachable'));
    await realWait(300);
    expect(mockOutbox).not.toHaveBeenCalled();
    expect(mockCheckpoint).not.toHaveBeenCalled();
  });

  it('resumes publishing once a later fetch succeeds after an unreachable one', async () => {
    await saveContactOperationV2(op(), KEY);
    mockFetch.mockResolvedValueOnce('unreachable');
    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'absent', reachableRelays: 1 });

    const { result, rerender } = renderPublishSync({ relays: { read: ['wss://relay.example.com'], write: RELAYS.write } });
    await waitFor(() => expect(result.current.remoteState).toBe('unreachable'));
    await realWait(300);
    expect(mockOutbox).not.toHaveBeenCalled();
    expect(mockCheckpoint).not.toHaveBeenCalled();

    // Re-triggers the fetch effect; this time it succeeds.
    rerender({ relays: { read: ['wss://relay2.example.com'], write: RELAYS.write } });
    await waitFor(() => expect(mockCheckpoint).toHaveBeenCalledTimes(1));
  });

  it('does not republish an unchanged outbox on the next opsVersion bump', async () => {
    const carried = op();
    const mine = op({ logicalClock: 5 });
    await saveContactOperationV2(carried, KEY);
    await saveContactOperationV2(mine, KEY);
    mockFetch.mockResolvedValue(PRESENT([carried], [carried.operationId]));

    const { rerender } = renderPublishSync();
    await waitFor(() => expect(mockOutbox).toHaveBeenCalledTimes(1));

    rerender({ opsVersion: 1 });
    await realWait(200);
    expect(mockOutbox).toHaveBeenCalledTimes(1);
  });

  it('publishes nothing on the cycle after a successful checkpoint, with no new local mutation', async () => {
    await saveContactOperationV2(op(), KEY);
    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'absent', reachableRelays: 1 });

    const { rerender } = renderPublishSync();
    await waitFor(() => expect(mockCheckpoint).toHaveBeenCalledTimes(1));

    mockCheckpoint.mockClear();
    mockOutbox.mockClear();
    rerender({ opsVersion: 1 }); // re-arms the debounce; nothing local changed
    await realWait(200);
    expect(mockCheckpoint).not.toHaveBeenCalled();
    expect(mockOutbox).not.toHaveBeenCalled();
  });

  // A refused publish (`ok === false`) must leave `persistedSeqRef` and
  // `checkpointRef` exactly as they were, so the next cycle retries with the
  // SAME inputs rather than skipping ahead as if it had succeeded.
  it('a refused checkpoint publish leaves the seq and checkpoint ref untouched, so the next cycle retries identically', async () => {
    await saveContactOperationV2(op(), KEY);
    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'absent', reachableRelays: 1 });
    mockCheckpoint.mockResolvedValueOnce(false); // first attempt refused

    const { rerender } = renderPublishSync();
    await waitFor(() => expect(mockCheckpoint).toHaveBeenCalledTimes(1));
    expect(mockCheckpoint.mock.calls[0][0].seq).toBe(1);

    rerender({ opsVersion: 1 }); // re-arms the debounce; no new op, no new fetch
    await waitFor(() => expect(mockCheckpoint).toHaveBeenCalledTimes(2));
    // Still seq 1 and still the same single op — nothing advanced on the refusal.
    expect(mockCheckpoint.mock.calls[1][0].seq).toBe(1);
    expect(mockCheckpoint.mock.calls[1][0].ops).toHaveLength(1);
  });

  // Fix round 2, point 2: a debounce cycle that collides with an in-flight
  // one must not be dropped — it re-arms exactly once after the in-flight
  // cycle finishes.
  it('re-arms the debounce once after a mutation collides with an in-flight publish', async () => {
    const carried = op();
    await saveContactOperationV2(carried, KEY);
    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'absent', reachableRelays: 1 });

    // Gate the FIRST checkpoint publish on a manual promise so it stays
    // "in flight" until the test resolves it — refused (`false`), so the
    // checkpoint stays unadopted and the second (re-armed) cycle sees "no
    // checkpoint exists" too, exercising the same leg both times.
    let resolveFirst: (ok: boolean) => void = () => {};
    const firstGate = new Promise<boolean>((resolve) => { resolveFirst = resolve; });
    mockCheckpoint.mockImplementationOnce(() => firstGate);

    const { result, rerender } = renderPublishSync();
    await waitFor(() => expect(result.current.remoteState).toBe('never-seen'));
    await waitFor(() => expect(mockCheckpoint).toHaveBeenCalledTimes(1)); // now in flight, blocked on firstGate

    // A local mutation re-arms the debounce WHILE the first cycle is still
    // in flight — its timer must collide with the in-flight one and skip,
    // not run a second cycle concurrently against the same refs.
    await saveContactOperationV2(op({ logicalClock: 2 }), KEY);
    rerender({ opsVersion: 1 });
    await realWait(200); // long enough for the colliding timer to fire and skip
    expect(mockCheckpoint).toHaveBeenCalledTimes(1); // still just the first attempt

    // Resolve the first (refused) attempt; the skipped collision re-arms
    // exactly once, and the follow-up picks up the new op.
    resolveFirst(false);
    await waitFor(() => expect(mockCheckpoint).toHaveBeenCalledTimes(2));
    expect(mockCheckpoint.mock.calls[1][0].ops).toHaveLength(2);
  });

  // I1: a lock or an identity switch mid-flight must stop a cycle already
  // scheduled under the OLD identity/unlock from doing any further work or
  // re-arming — not just from starting a NEW one. Both tests below force a
  // genuine collision first (so "no re-arm" is a real claim, not vacuously
  // true because nothing was ever queued), then flip the identity/key while
  // the first cycle is still in flight.
  it('I1: a lock (encryptionKey -> null) while a publish is in flight stops any further work or re-arm', async () => {
    const carried = op();
    await saveContactOperationV2(carried, KEY);
    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'absent', reachableRelays: 1 });

    let resolveFirst: (ok: boolean) => void = () => {};
    const firstGate = new Promise<boolean>((resolve) => { resolveFirst = resolve; });
    mockCheckpoint.mockImplementationOnce(() => firstGate);
    const listSpy = vi.spyOn(db, 'listAllContactOperationsV2');

    const { result, rerender } = renderPublishSync();
    await waitFor(() => expect(result.current.remoteState).toBe('never-seen'));
    await waitFor(() => expect(mockCheckpoint).toHaveBeenCalledTimes(1)); // now in flight, blocked on firstGate
    expect(listSpy).toHaveBeenCalledTimes(2);

    // A mutation collides with the in-flight cycle, queuing a follow-up —
    // without this, "no re-arm" below would hold trivially (nothing was
    // ever queued to re-arm in the first place).
    await saveContactOperationV2(op({ logicalClock: 2 }), KEY);
    rerender({ opsVersion: 1 });
    await realWait(200);
    expect(mockCheckpoint).toHaveBeenCalledTimes(1);

    // Lock: encryptionKey -> null, mid-flight.
    rerender({ opsVersion: 1, encryptionKey: null });
    await realWait(50);

    // Resolve the original in-flight attempt.
    resolveFirst(false);
    await realWait(300);

    // No FURTHER listAllContactOperationsV2 call (2 = the fetch effect's own
    // merge-step read, plus the one in-flight publish cycle's own read — the
    // baseline established above) and no re-arm: the queued follow-up never
    // runs against the now-null key.
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(mockCheckpoint).toHaveBeenCalledTimes(1);
    expect(mockOutbox).not.toHaveBeenCalled();
    listSpy.mockRestore();
  });

  it('I1: an identity switch mid-flight stops the stale cycle from re-arming under the old identity', async () => {
    const carried = op();
    await saveContactOperationV2(carried, KEY);
    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'absent', reachableRelays: 1 });

    let resolveFirst: (ok: boolean) => void = () => {};
    const firstGate = new Promise<boolean>((resolve) => { resolveFirst = resolve; });
    mockCheckpoint.mockImplementationOnce(() => firstGate);
    const listSpy = vi.spyOn(db, 'listAllContactOperationsV2');

    const { result, rerender } = renderPublishSync();
    await waitFor(() => expect(result.current.remoteState).toBe('never-seen'));
    await waitFor(() => expect(mockCheckpoint).toHaveBeenCalledTimes(1)); // in flight, blocked on firstGate
    expect(listSpy).toHaveBeenCalledTimes(2);

    // A mutation collides with the in-flight cycle before the switch.
    await saveContactOperationV2(op({ logicalClock: 2 }), KEY);
    rerender({ opsVersion: 1 });
    await realWait(200);
    expect(mockCheckpoint).toHaveBeenCalledTimes(1);

    // Switch identity mid-flight. Empty read relays for the new identity
    // (same technique as the sibling "empty read relays" test above) means
    // it can never hydrate, so any FURTHER checkpoint/outbox call below can
    // only be the stale identity1 cycle re-arming — exactly what must not
    // happen.
    const identity2 = createNewIdentity('Second', 'natural-person', false);
    const backend2 = makeBackend(identity2.naturalPerson.publicKey);
    rerender({ opsVersion: 1, identity: identity2, npBackend: backend2, relays: { read: [], write: RELAYS.write } });
    await realWait(100);

    // Resolve identity1's original in-flight attempt.
    resolveFirst(false);
    await realWait(300);

    // No FURTHER listAllContactOperationsV2 call beyond the 2-call baseline
    // established above, and no re-arm.
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(mockCheckpoint).toHaveBeenCalledTimes(1);
    expect(mockOutbox).not.toHaveBeenCalled();
    listSpy.mockRestore();
  });

  // I1 residual (re-review): a lock/identity switch that lands WHILE
  // `runCycle`'s own `listAllContactOperationsV2` call is in flight — not
  // just while an actual publish call is — must still be caught. Gate the
  // db read itself (not the checkpoint/outbox publish) so the race is
  // squarely inside the decrypt, before `stillCurrent()` is re-checked.
  it('I1 residual: re-gates after the listAllContactOperationsV2 await — a lock mid-decrypt fires no onBackupStateChange', async () => {
    const carried = op();
    await saveContactOperationV2(carried, KEY);
    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'absent', reachableRelays: 1 });

    // Gate only the SECOND call (the publish cycle's own read) — the FIRST
    // is the fetch effect's own merge-step read, which must resolve
    // normally for the hook to hydrate and the publish cycle to ever start.
    let calls = 0;
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    // Captured BEFORE spying: calling the named import from inside the mock
    // would recurse into the mock itself (same live ESM binding).
    const originalList = db.listAllContactOperationsV2;
    const listSpy = vi.spyOn(db, 'listAllContactOperationsV2').mockImplementation(async (key: string) => {
      calls += 1;
      if (calls === 2) await gate;
      return originalList(key);
    });

    const { result, rerender } = renderPublishSync();
    await waitFor(() => expect(result.current.remoteState).toBe('never-seen'));
    // The publish cycle has started and is now blocked mid-decrypt.
    await waitFor(() => expect(calls).toBe(2));
    onBackupStateChange.mockClear();

    // Lock mid-await.
    rerender({ opsVersion: 0, encryptionKey: null });
    await realWait(50);

    // Release the gated read — `stillCurrent()` must catch the lock here,
    // before `publishBackupState` (and therefore `onBackupStateChange`)
    // would otherwise fire with a value computed for the old identity.
    releaseGate();
    await realWait(300);

    expect(onBackupStateChange).not.toHaveBeenCalled();
    expect(mockCheckpoint).not.toHaveBeenCalled();
    expect(mockOutbox).not.toHaveBeenCalled();

    listSpy.mockRestore();
  });

  // Fix round 2, point 3: `identityGenerationRef` used to be maintained
  // only inside the fetch effect's body, which early-returns before that
  // point when `relays.read` is empty — so a write-only relay config meant
  // a NEW identity could inherit the PREVIOUS identity's `checkpointRef`/
  // `hydrated` forever, and the publish effect (gated only on
  // `relays.write`) would run against it.
  it('never publishes for a new identity with empty read relays, even though the previous identity had hydrated', async () => {
    await saveContactOperationV2(op(), KEY);
    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'absent', reachableRelays: 1 });

    const { result, rerender } = renderPublishSync();
    await waitFor(() => expect(result.current.remoteState).toBe('never-seen'));
    await waitFor(() => expect(mockCheckpoint).toHaveBeenCalledTimes(1)); // this identity hydrated and published
    mockCheckpoint.mockClear();
    mockOutbox.mockClear();

    // Switch to a DIFFERENT identity with EMPTY read relays (write-only) —
    // the fetch effect can never run for it, so it must never hydrate, and
    // the publish effect must never fire against the stale checkpoint state
    // left over from the previous identity.
    const otherIdentity = createNewIdentity('Other', 'natural-person', false);
    const otherBackend = makeBackend(otherIdentity.naturalPerson.publicKey);
    rerender({ identity: otherIdentity, npBackend: otherBackend, relays: { read: [], write: RELAYS.write } });
    await realWait(300);

    expect(mockCheckpoint).not.toHaveBeenCalled();
    expect(mockOutbox).not.toHaveBeenCalled();
  });

  it('publishes again once a new local operation lands', async () => {
    const carried = op();
    await saveContactOperationV2(carried, KEY);
    await saveContactOperationV2(op({ logicalClock: 5 }), KEY);
    mockFetch.mockResolvedValue(PRESENT([carried], [carried.operationId]));

    const { rerender } = renderPublishSync();
    await waitFor(() => expect(mockOutbox).toHaveBeenCalledTimes(1));

    await saveContactOperationV2(op({ logicalClock: 6 }), KEY);
    rerender({ opsVersion: 1 });
    await waitFor(() => expect(mockOutbox).toHaveBeenCalledTimes(2));
    expect(mockOutbox.mock.calls[1][0].ops).toHaveLength(2);
  });

  it("clears the 'stalled' backup state once the checkpoint becomes readable again", async () => {
    const mine = op();
    await saveContactOperationV2(mine, KEY);
    mockFetch.mockResolvedValueOnce({ ops: [], checkpoint: null, checkpointState: 'unusable', reachableRelays: 1 });
    mockFetch.mockResolvedValue(PRESENT([], []));

    const { result, rerender } = renderPublishSync({
      relays: { read: ['wss://relay.example.com'], write: RELAYS.write },
      maxOutboxOps: 0,
    });
    await waitFor(() => expect(result.current.backupState).toBe('stalled'));
    expect(mockCheckpoint).not.toHaveBeenCalled();
    expect(mockOutbox).not.toHaveBeenCalled();

    rerender({
      relays: { read: ['wss://relay2.example.com'], write: RELAYS.write },
      maxOutboxOps: 0,
    });
    await waitFor(() => expect(result.current.backupState).toBe('ok'));
    // The state clears on the fetch; the outbox publish follows on its own
    // timer, so wait for it rather than asserting in the same tick.
    await waitFor(() => expect(mockOutbox).toHaveBeenCalledTimes(1));
    expect(mockOutbox.mock.calls[0][0].ops).toEqual([mine]);
  });

  // Trigger (c): a stale checkpoint (older than `CHECKPOINT_MAX_AGE_MS`) with
  // something to fold in recompacts, even though outbox size (b) and device
  // list (d) both give no reason to on their own.
  it('recompacts when the checkpoint is stale AND there is something to fold in (trigger c)', async () => {
    const carried = op();
    const mine = op({ logicalClock: 5 });
    await saveContactOperationV2(carried, KEY);
    await saveContactOperationV2(mine, KEY);
    mockFetch.mockResolvedValue(PRESENT([carried], [carried.operationId], { createdAt: Date.now() - 90_000_000 }));

    renderPublishSync();
    await waitFor(() => expect(mockCheckpoint).toHaveBeenCalledTimes(1));

    expect(mockOutbox).not.toHaveBeenCalled();
    expect(mockCheckpoint.mock.calls[0][0].ops.map((o: ContactOperation) => o.operationId).sort())
      .toEqual([carried.operationId, mine.operationId].sort());
  });

  it('does not publish before the jitter window elapses', async () => {
    const carried = op();
    await saveContactOperationV2(carried, KEY);
    await saveContactOperationV2(op({ logicalClock: 5 }), KEY);
    mockFetch.mockResolvedValue(PRESENT([carried], [carried.operationId]));

    // No `publishDelayMs` override: `computePublishDelayMs(() => 0)` is
    // exactly 6000 ms, and this is the one test that must prove the REAL
    // timing, not the fast test override.
    renderPublishSync({ publishDelayMs: undefined });
    await realWait(5000);
    expect(mockOutbox).not.toHaveBeenCalled();
    await waitFor(() => expect(mockOutbox).toHaveBeenCalledTimes(1), { timeout: 4000 });
  }, 15_000);

  it('cancels the pending debounce timer on unmount', async () => {
    const carried = op();
    const mine = op({ logicalClock: 5 });
    await saveContactOperationV2(carried, KEY);
    await saveContactOperationV2(mine, KEY);
    mockFetch.mockResolvedValue(PRESENT([carried], [carried.operationId]));

    // A longer-than-default debounce, so there is something for cleanup to
    // have to cancel — with the ~5 ms fast-test default it would already
    // have fired before we could unmount. Not the full real 6000 ms either:
    // that timing is what the jitter-window test above exists to prove.
    const { result, unmount } = renderPublishSync({ publishDelayMs: 1500 });
    // Anchor on `remoteState` settling rather than a guessed fixed wait
    // (Fix round 2, point 1) — a blind wait shorter than hydration takes
    // this run would unmount BEFORE the publish effect ever schedules its
    // timer, making "nothing published" trivially true for the wrong
    // reason. The small buffer after the anchor covers the one remaining
    // real-crypto step (the merge read) between `remoteState` settling and
    // `hydrated` actually flipping, so the 1500 ms timer is genuinely
    // pending — not merely never-created — when `unmount()` runs.
    await waitFor(() => expect(result.current.remoteState).toBe('present'));
    await realWait(300);
    unmount();
    // Wait past where it would have fired had cleanup not cancelled it.
    await realWait(1600);

    expect(mockOutbox).not.toHaveBeenCalled();
    expect(mockCheckpoint).not.toHaveBeenCalled();
  }, 15_000);

  it('reports a log that has outgrown the rail instead of failing silently (R6)', async () => {
    await saveContactOperationV2(op(), KEY);
    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'absent', reachableRelays: 1 });

    // A ceiling of zero stands in for a 64 000-operation log: building one
    // would cost minutes of PBKDF2 and prove the same branch.
    const { result, unmount } = renderPublishSync({ maxCheckpointOps: 0 });
    await waitFor(() => expect(result.current.backupState).toBe('too-large'));
    expect(mockCheckpoint).not.toHaveBeenCalled();
    // R6: `tooLarge` only refuses the CHECKPOINT leg — the outbox leg still
    // runs (it is lossless regardless of checkpoint state). Wait for it to
    // actually settle, and unmount, before this test ends: otherwise the
    // still-in-flight publish call lands asynchronously after the test
    // function has returned, contaminating whichever test runs next with a
    // stray `mockOutbox` call.
    await waitFor(() => expect(mockOutbox).toHaveBeenCalledTimes(1));
    unmount();
  });

  // M9: `onBackupStateChange` is a caller-facing notification of the SAME
  // value the hook returns — so a caller (App's R-VERIFIED-TWO-WAY gate)
  // can hold its own copy of the current value from a point in the render
  // where this hook's own return value isn't in scope yet.
  it('fires onBackupStateChange with the same value the hook returns (M9)', async () => {
    await saveContactOperationV2(op(), KEY);
    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'absent', reachableRelays: 1 });

    const { result, unmount } = renderPublishSync({ maxCheckpointOps: 0 });
    await waitFor(() => expect(result.current.backupState).toBe('too-large'));
    expect(onBackupStateChange).toHaveBeenCalledWith('too-large');
    await waitFor(() => expect(mockOutbox).toHaveBeenCalledTimes(1));
    unmount();
  });

  it('reports a stalled outbox instead of looping on a doomed publish, when the checkpoint is unusable and the outbox is oversized (Task 6 review ruling)', async () => {
    await saveContactOperationV2(op(), KEY);
    // A checkpoint event exists but could not be read — R2 forbids the
    // compaction leg — and this device's outbox has nowhere left to go: a
    // payload over `maxOutboxOps` (a stand-in for `MAX_OPS_PER_PAYLOAD`,
    // avoiding 2001 real PBKDF2-encrypted operations) is refused every time.
    mockFetch.mockResolvedValue({ ops: [], checkpoint: null, checkpointState: 'unusable', reachableRelays: 1 });

    const { result } = renderPublishSync({ maxOutboxOps: 0 });
    await waitFor(() => expect(result.current.backupState).toBe('stalled'));
    // No relay call — a doomed publish is not attempted, let alone retried.
    expect(mockOutbox).not.toHaveBeenCalled();
    expect(mockCheckpoint).not.toHaveBeenCalled();
  });
});
