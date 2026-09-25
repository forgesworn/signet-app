// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import 'fake-indexeddb/auto';
import {
  useContactProjections, publishProjectionForGrant,
  keepaliveDue, keepaliveDelayMs, keepaliveArmable, keepaliveDelayForRun,
} from './useContactProjections';
import { buildRevocationProjection } from '../lib/contact-projection';
import { parseProjection, projectionTag, scopedContactId } from '@forgesworn/signet-contacts/wire';
import { openVaultPayload } from '../lib/vault-envelope';
import * as db from '../lib/db';
import * as syncRelays from '../lib/sync-relays';
import { LocalSigningBackend } from '../lib/signing-backend';
import type { AppGrantV2, ContactOperation } from '../types';
import type { NostrEvent } from 'signet-protocol';

const KEY = 'a'.repeat(64);
const RAIL_SK = 'b'.repeat(63) + '1';
const APP_SK = 'c'.repeat(63) + '1';
const DEVICE = '2'.repeat(32);
const CONTACT_ID = 'a'.repeat(32);
const RELAYS = { read: ['wss://r.example'], write: ['wss://r.example'] };
const OWNER_DIR = { directoryId: 'owner', context: {
  activeGuardianPubkeys: [], defaultChildCeiling: 'ken' as const, directoryIsDependant: false,
} };
// M1/R-14: `directories` is safe in the effect's dependency array ONLY
// because the caller (App.tsx) memoises it — a fresh array every render
// re-arms the effect's timer on every internal state update the hook itself
// causes (`setPublishing`/`setPublished`/`setLastRunAt` all trigger a
// re-render of a component that calls `baseOptions()` again). Hoisted once
// here so every `baseOptions()` call shares the same reference, exactly as a
// real caller is expected to.
const DIRECTORIES = [OWNER_DIR];

// M3: a second, dependant-scoped directory, for the two-directory isolation
// proof. A distinct rail/app keypair per grant, same shape as OWNER_DIR/grant().
const DEP_PUBKEY = '3'.repeat(64);
const DEP_DIR_ID = `dependant:${DEP_PUBKEY}`;
const DEP_DIR = { directoryId: DEP_DIR_ID, context: {
  activeGuardianPubkeys: [], defaultChildCeiling: 'ken' as const, directoryIsDependant: true,
} };
const TWO_DIRECTORIES = [OWNER_DIR, DEP_DIR];
const DEP_RAIL_SK = '6'.repeat(63) + '1';
const DEP_APP_SK = '7'.repeat(63) + '1';
const DEP_CONTACT_ID = 'b'.repeat(32);

function baseOptions(over: Record<string, unknown> = {}) {
  return {
    enabled: true, encryptionKey: KEY, relays: RELAYS, directories: DIRECTORIES,
    deviceId: DEVICE, changeToken: 'c1', safetyToken: 's0', ...over,
  };
}

function grant(over: Partial<AppGrantV2> = {}): AppGrantV2 {
  return {
    grantId: 'f'.repeat(32), directoryId: 'owner', ownerIdentityPubkey: '1'.repeat(64), appPubkey: new LocalSigningBackend(APP_SK).activePublicKeyHex,
    createdAt: 1, updatedAt: 1, appName: 'Flock',
    capabilities: ['signet.contacts.read:directory', 'signet.contacts.blocks.read'],
    railPubkey: new LocalSigningBackend(RAIL_SK).activePublicKeyHex, railPrivateKey: RAIL_SK,
    relay: 'wss://r.example', maxStalenessSeconds: 21600, appLabels: {}, seenOperationIds: [], ...over,
  };
}

/**
 * R-10: every id here is 32 LOWERCASE HEX. `db.listContactOperationsV2` runs
 * each decrypted row through `validateOperation`, which requires exactly that —
 * an id like `'contact-ada'` is silently dropped, and every assertion below
 * would then pass against an empty directory.
 */
async function seedContact(contactId: string, operationId: string): Promise<void> {
  await db.saveContactOperationV2({
    operationId, directoryId: 'owner', contactId,
    actorPubkey: '1'.repeat(64), actorRole: 'owner', actorDeviceId: DEVICE,
    logicalClock: 1, action: 'add', createdAt: 1,
    value: { type: 'person', ownerIdentityPubkey: '1'.repeat(64), displayName: 'Ada', tier: 'kith' },
  }, KEY);
}

/** A guardian-authored contact in the DEPENDANT directory, for the
 * two-directory isolation proof (M3). */
async function seedDepContact(contactId: string, operationId: string): Promise<void> {
  await db.saveContactOperationV2({
    operationId, directoryId: DEP_DIR_ID, contactId,
    actorPubkey: DEP_PUBKEY, actorRole: 'guardian', actorDeviceId: DEVICE,
    logicalClock: 1, action: 'add', createdAt: 1,
    value: { type: 'person', ownerIdentityPubkey: '1'.repeat(64), displayName: 'Bo', tier: 'kith' },
  }, KEY);
}

/**
 * M3: ~700 heavy contacts is well past `MAX_WIRE_BYTES` (65532) — same
 * fixture shape `contact-projection.test.ts` uses for its own truncation
 * proof, seeded through the REAL operation log + reducer this time, so the
 * hook's own byte-fit path is what's under test, not just the pure builder.
 * One batch write, sharing a single PBKDF2 derivation (`saveContactOperationsV2`),
 * rather than 700 individually-derived writes.
 */
function manyContactOp(i: number, nameLength: number): ContactOperation {
  return {
    operationId: (i + 1).toString(16).padStart(32, '0'),
    directoryId: 'owner',
    contactId: i.toString(16).padStart(32, '0'),
    actorPubkey: '1'.repeat(64), actorRole: 'owner', actorDeviceId: DEVICE,
    logicalClock: i + 1, action: 'add', createdAt: 1,
    value: { type: 'person', ownerIdentityPubkey: '1'.repeat(64), displayName: 'N'.repeat(nameLength), tier: 'kith' },
  };
}

async function seedManyContacts(count: number, nameLength: number): Promise<void> {
  const ops = Array.from({ length: count }, (_, i) => manyContactOp(i, nameLength));
  await db.saveContactOperationsV2(ops, KEY);
}

let publishSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await db.purgeAllUserData();
  publishSpy = vi.spyOn(syncRelays, 'publishToRelays').mockResolvedValue(true);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/**
 * fake-indexeddb schedules its callbacks on `setImmediate`, which vitest's
 * fake timers capture (same hazard documented in `useContactsV2Sync.test.ts`)
 * — a direct `await db.…` made from the test body while fake timers are
 * active never resolves, because nothing is driving the fake clock forward
 * at that point. Effect-internal IDB work is fine: it runs inside the
 * `setTimeout` callback that `vi.advanceTimersByTimeAsync` itself fires, so
 * the same advance also carries the nested `setImmediate` along. This helper
 * is only for setup/assertion calls made directly from a test body.
 */
async function withRealTimers<T>(fn: () => Promise<T>): Promise<T> {
  vi.useRealTimers();
  try { return await fn(); } finally { vi.useFakeTimers(); }
}

describe('useContactProjections', () => {
  it('the seeded fixture is actually readable back (R-10 guard)', async () => {
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    expect(await withRealTimers(() => db.listContactOperationsV2('owner', KEY))).toHaveLength(1);
  });

  it('publishes one projection per active grant after the jittered delay', async () => {
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(() => db.saveContactGrantV2(grant(), KEY));
    const { unmount } = renderHook(() => useContactProjections(baseOptions() as never));
    expect(publishSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(92_000);
    // The grant row is decrypted (real PBKDF2, dispatched to Node's real
    // threadpool) as part of the run — same hazard `useContactsV2Sync.test.ts`
    // documents for `saveContactOperationsV2`. A virtual `advanceTimersByTimeAsync`
    // never donates the genuine wall-clock time that needs; `withRealTimers`
    // lets `waitFor`'s real polling loop give it that time.
    await withRealTimers(() => waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1), { timeout: 10_000 }));
    const [event] = publishSpy.mock.calls[0]!;
    expect(event.kind).toBe(30078);
    expect(event.tags).toEqual([['d', projectionTag('f'.repeat(32))]]);
    expect(event.pubkey).toBe(new LocalSigningBackend(RAIL_SK).activePublicKeyHex);
    unmount();
  });

  it('seals into a padded envelope the APP can open (R-4)', async () => {
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(() => db.saveContactGrantV2(grant(), KEY));
    const { unmount } = renderHook(() => useContactProjections(baseOptions() as never));
    await vi.advanceTimersByTimeAsync(92_000);
    await withRealTimers(() => waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1), { timeout: 10_000 }));
    const [event] = publishSpy.mock.calls[0]!;
    // A v2 envelope, not a bare ciphertext: JSON with a wrapped key and a
    // bucket size, so the directory's size does not leak through the length.
    const envelope = JSON.parse(event.content) as { v: number; b: number };
    expect(envelope.v).toBe(2);
    expect([4096, 8192, 16384, 32768, 65536]).toContain(envelope.b);
    const app = new LocalSigningBackend(APP_SK);
    const plaintext = await openVaultPayload(event.content, app, grant().railPubkey, { legacyFallback: false });
    expect(parseProjection(plaintext!)?.contacts).toHaveLength(1);
    unmount();
  });

  it('uses a grant-scoped frontier without vault activity or device identifiers', async () => {
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(() => db.saveContactGrantV2(grant(), KEY));
    const { unmount } = renderHook(() => useContactProjections(baseOptions() as never));
    await vi.advanceTimersByTimeAsync(92_000);
    await withRealTimers(() => waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1), { timeout: 10_000 }));
    const [event] = publishSpy.mock.calls[0]!;
    const app = new LocalSigningBackend(APP_SK);
    const plaintext = await openVaultPayload(event.content, app, grant().railPubkey, { legacyFallback: false });
    const frontier = parseProjection(plaintext!)!.frontier;
    expect(frontier.deviceId).toBe(grant().grantId);
    expect(frontier.opCount).toBe(0);
    expect(frontier.publishedAt).toBeGreaterThan(0);
    unmount();
  });

  it('publishes immediately when the safety token changes', async () => {
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(() => db.saveContactGrantV2(grant(), KEY));
    const { rerender, unmount } = renderHook((props: { safetyToken: string }) =>
      useContactProjections(baseOptions({ safetyToken: props.safetyToken }) as never),
    { initialProps: { safetyToken: 's0' } });
    await vi.advanceTimersByTimeAsync(92_000);
    // Let the FIRST run settle ALL THE WAY — through the post-publish
    // `lastProjectionHash` write, not just the `publishToRelays` call — before
    // clearing the spy. The dedupe check reads that hash back from IndexedDB
    // on the next run: if we rerender while the write is still in flight (real
    // PBKDF2 needs real wall-clock time — see the note above), the immediate
    // second run can read the STALE row and, coincidentally, still publish;
    // waiting for the hash to land makes this deterministic rather than a
    // race between our own polling and the write. It also guarantees
    // `runningRef` has been reset, so the immediate run isn't merely queued
    // behind a first run that has not actually finished.
    await withRealTimers(() => waitFor(async () => {
      const saved = await db.getContactGrantV2('f'.repeat(32), KEY);
      expect(saved?.lastProjectionHash).toBeTruthy();
    }, { timeout: 10_000 }));
    expect(publishSpy).toHaveBeenCalledTimes(1);
    publishSpy.mockClear();
    rerender({ safetyToken: 's1' });
    // A bare `advanceTimersByTimeAsync(0)` does not reliably fire a
    // `setTimeout(fn, 0)` registered moments earlier in the same tick — a
    // small positive advance does. The hook still schedules genuinely at
    // 0ms; this is only about getting the fake clock to actually visit it.
    await vi.advanceTimersByTimeAsync(10);
    await withRealTimers(() => waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1), { timeout: 10_000 }));
    unmount();
  });

  it('skips a republish when the projection content has not changed', async () => {
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(() => db.saveContactGrantV2(grant(), KEY));
    const { rerender, unmount } = renderHook((props: { changeToken: string }) =>
      useContactProjections(baseOptions({ changeToken: props.changeToken }) as never),
    { initialProps: { changeToken: 'c1' } });
    await vi.advanceTimersByTimeAsync(92_000);
    await withRealTimers(() => waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1), { timeout: 10_000 }));
    rerender({ changeToken: 'c2' });
    await vi.advanceTimersByTimeAsync(92_000);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('republishes an UNCHANGED directory once the grant is halfway through its window (R-29)', async () => {
    // Without this a directory nobody edits keeps one projection whose
    // `expiresAt` the consumer can never move — `isFresh` flips false and
    // stays false, because a re-fetch of the same replaceable event is
    // refused as not-newer. The owner's freshness choice then decided only
    // how fast that happened.
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(() => db.saveContactGrantV2(grant(), KEY));
    const { rerender, unmount } = renderHook((props: { changeToken: string }) =>
      useContactProjections(baseOptions({ changeToken: props.changeToken }) as never),
    { initialProps: { changeToken: 'c1' } });
    await vi.advanceTimersByTimeAsync(92_000);
    await withRealTimers(() => waitFor(async () => {
      const saved = await db.getContactGrantV2('f'.repeat(32), KEY);
      expect(saved?.lastProjectionHash).toBeTruthy();
    }, { timeout: 10_000 }));
    expect(publishSpy).toHaveBeenCalledTimes(1);

    // Back-date the last publish past half the 6-hour window. Nothing about
    // the directory changed, and `lastProjectionHash` still matches exactly
    // what the next run will build — so a second publish can only be the
    // keepalive.
    await withRealTimers(() => db.updateContactGrantV2('f'.repeat(32), KEY, (current) => ({
      ...current, lastProjectionAt: Math.floor(Date.now() / 1000) - 20_000,
    })));
    rerender({ changeToken: 'c2' });
    await vi.advanceTimersByTimeAsync(92_000);
    await withRealTimers(() => waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(2), { timeout: 10_000 }));
    unmount();
  });

  it('records the hash, the time and the publish state on success (R-5)', async () => {
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(() => db.saveContactGrantV2(grant(), KEY));
    const { unmount } = renderHook(() => useContactProjections(baseOptions() as never));
    await vi.advanceTimersByTimeAsync(92_000);
    await withRealTimers(() => waitFor(async () => {
      const saved = await db.getContactGrantV2('f'.repeat(32), KEY);
      expect(saved?.lastProjectionHash).toMatch(/^[0-9a-f]{64}$/);
      expect(saved?.lastProjectionAt).toBeGreaterThan(0);
      expect(saved?.lastPublishState).toBe('ok');
      // I3: a publish-state-only write must never bump the grants rail's LWW
      // key — `updatedAt` stays exactly what it was (grant()'s default: 1).
      expect(saved?.updatedAt).toBe(1);
    }, { timeout: 10_000 }));
    unmount();
  });

  it('records a failed publish state rather than staying silent (R-5)', async () => {
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(() => db.saveContactGrantV2(grant(), KEY));
    publishSpy.mockResolvedValue(false);
    const { unmount } = renderHook(() => useContactProjections(baseOptions() as never));
    await vi.advanceTimersByTimeAsync(92_000);
    await withRealTimers(() => waitFor(async () => {
      const saved = await db.getContactGrantV2('f'.repeat(32), KEY);
      expect(saved?.lastPublishState).toBe('failed');
      // The hash is NOT written, so the next change retries.
      expect(saved?.lastProjectionHash).toBeUndefined();
    }, { timeout: 10_000 }));
    unmount();
  });

  it('never publishes for a revoked grant', async () => {
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(() => db.saveContactGrantV2(grant({ revokedAt: 5 }), KEY));
    const { unmount } = renderHook(() => useContactProjections(baseOptions() as never));
    await vi.advanceTimersByTimeAsync(92_000);
    expect(publishSpy).not.toHaveBeenCalled();
    unmount();
  });

  it('does not resurrect a grant revoked mid-run', async () => {
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(() => db.saveContactGrantV2(grant(), KEY));
    publishSpy.mockImplementation(async () => {
      await db.saveContactGrantV2(grant({ revokedAt: 9 }), KEY);
      return true;
    });
    const { unmount } = renderHook(() => useContactProjections(baseOptions() as never));
    await vi.advanceTimersByTimeAsync(92_000);
    await withRealTimers(() => waitFor(async () => {
      const saved = await db.getContactGrantV2('f'.repeat(32), KEY);
      expect(saved?.revokedAt).toBe(9);
      expect(saved?.lastProjectionHash).toBeUndefined();
    }, { timeout: 10_000 }));
    unmount();
  });

  it('does nothing when disabled, keyless, device-less, or with no write relay', async () => {
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(() => db.saveContactGrantV2(grant(), KEY));
    for (const over of [
      { enabled: false },                       // R-8: a paired-child install
      { encryptionKey: null },
      { deviceId: null },
      { relays: { read: [], write: [] } },
    ]) {
      const { unmount } = renderHook(() => useContactProjections(baseOptions(over) as never));
      await vi.advanceTimersByTimeAsync(92_000);
      unmount();
    }
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('survives a relay failure without throwing and retries on the next change', async () => {
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(() => db.saveContactGrantV2(grant(), KEY));
    publishSpy.mockResolvedValueOnce(false);
    const { rerender, unmount } = renderHook((props: { changeToken: string }) =>
      useContactProjections(baseOptions({ changeToken: props.changeToken }) as never),
    { initialProps: { changeToken: 'c1' } });
    await vi.advanceTimersByTimeAsync(92_000);
    // Wait for the FIRST run to settle ALL THE WAY — the failure write, not
    // just the `publishToRelays` call — before rerendering (I1): the write
    // itself needs its own real-PBKDF2 round trip AFTER the publish resolves,
    // and rerendering while that is still in flight cancels it mid-flight
    // (correctly, per I1) before it ever records the failure the next
    // assertion depends on.
    await withRealTimers(() => waitFor(async () => {
      const saved = await db.getContactGrantV2('f'.repeat(32), KEY);
      expect(saved?.lastPublishState).toBe('failed');
    }, { timeout: 10_000 }));
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(await withRealTimers(() => db.getContactGrantV2('f'.repeat(32), KEY))).toMatchObject({ lastProjectionHash: undefined });
    rerender({ changeToken: 'c2' });
    await vi.advanceTimersByTimeAsync(92_000);
    await withRealTimers(() => waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(2), { timeout: 10_000 }));
    unmount();
  });

  it('stamps two publishes for the same grant strictly increasing (C1/R-24)', async () => {
    // Same shape as "publishes immediately when the safety token changes":
    // a jittered first publish, then a byte-identical safety follow-up (the
    // exact degenerate case R-24 exists for — nothing about the grant or its
    // directory changes between the two). Real DB, real crypto, real clock —
    // an attempt to pin `Date.now()` via `vi.setSystemTime` was tried and
    // abandoned: `sealVaultPayload`/`signEvent` need a genuine event-loop
    // turn to resolve their native crypto calls, the same hazard `nowSec()`
    // hits for PBKDF2, and switching to real timers for that (via
    // `withRealTimers`) unpins any fake system time back to the real clock.
    // In practice the whole round trip below completes in well under a
    // second, so the two stamps land in the same real wall-clock second on
    // any reasonably fast machine — asserting `secondEvent.created_at -
    // firstEvent.created_at` is small (not just positive) keeps this test
    // honest about that, rather than passing trivially on any real gap.
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(() => db.saveContactGrantV2(grant(), KEY));
    const { rerender, unmount } = renderHook((props: { safetyToken: string }) =>
      useContactProjections(baseOptions({ safetyToken: props.safetyToken }) as never),
    { initialProps: { safetyToken: 's0' } });

    await vi.advanceTimersByTimeAsync(92_000);
    await withRealTimers(() => waitFor(async () => {
      const saved = await db.getContactGrantV2('f'.repeat(32), KEY);
      expect(saved?.lastProjectionHash).toBeTruthy();
    }, { timeout: 10_000 }));
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const [firstEvent] = publishSpy.mock.calls[0]!;

    publishSpy.mockClear();
    rerender({ safetyToken: 's1' });
    await vi.advanceTimersByTimeAsync(10);
    await withRealTimers(() => waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1), { timeout: 10_000 }));
    const [secondEvent] = publishSpy.mock.calls[0]!;

    expect(secondEvent.created_at).toBeGreaterThan(firstEvent.created_at);
    expect(secondEvent.created_at - firstEvent.created_at).toBeLessThan(5);

    const app = new LocalSigningBackend(APP_SK);
    const firstPlain = await openVaultPayload(firstEvent.content, app, grant().railPubkey, { legacyFallback: false });
    const secondPlain = await openVaultPayload(secondEvent.content, app, grant().railPubkey, { legacyFallback: false });
    const firstFrontier = parseProjection(firstPlain!)!.frontier;
    const secondFrontier = parseProjection(secondPlain!)!.frontier;
    expect(secondFrontier.publishedAt).toBeGreaterThan(firstFrontier.publishedAt);
    // Fix round 2 (item I): `publishProjectionForGrant` now mints its OWN
    // stamp for `created_at` from the shared chain (seeded with, but not
    // necessarily equal to, `projection.issuedAt`) — so the two are only
    // guaranteed never-behind, not numerically equal as round 1 had it.
    expect(secondEvent.created_at).toBeGreaterThanOrEqual(secondFrontier.publishedAt);

    unmount();
  });

  it('a corrupt rail key on one grant does not abort the run for the remaining grants (C2)', async () => {
    const BAD_GRANT = grant({ grantId: 'd'.repeat(32), railPrivateKey: 'not-a-valid-hex-key' });
    const GOOD_GRANT = grant({ grantId: 'c'.repeat(32) });
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(async () => {
      await db.saveContactGrantV2(BAD_GRANT, KEY);
      await db.saveContactGrantV2(GOOD_GRANT, KEY);
    });
    const { unmount } = renderHook(() => useContactProjections(baseOptions() as never));
    await vi.advanceTimersByTimeAsync(92_000);
    await withRealTimers(() => waitFor(async () => {
      const bad = await db.getContactGrantV2('d'.repeat(32), KEY);
      const good = await db.getContactGrantV2('c'.repeat(32), KEY);
      expect(bad?.lastPublishState).toBe('failed');
      expect(good?.lastPublishState).toBe('ok');
    }, { timeout: 10_000 }));
    // Only the good grant ever reaches publishToRelays — the bad one fails
    // inside `publishProjectionForGrant` before ever sealing or signing.
    expect(publishSpy).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does not publish or write after unmount while a publish is in flight (I1)', async () => {
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(() => db.saveContactGrantV2(grant(), KEY));
    let resolvePublish!: (ok: boolean) => void;
    publishSpy.mockImplementation(() => new Promise<boolean>((resolve) => { resolvePublish = resolve; }));
    const { unmount } = renderHook(() => useContactProjections(baseOptions() as never));
    await vi.advanceTimersByTimeAsync(92_000);
    // Let the run actually reach the in-flight publish before unmounting.
    await withRealTimers(() => waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1), { timeout: 10_000 }));
    unmount();
    await withRealTimers(() => new Promise<void>((resolve) => {
      resolvePublish(true);
      // Let the now-resolved publish flow through the cancelled run — the
      // remaining steps are synchronous from here, this is just enough real
      // time for that continuation to actually execute.
      setTimeout(resolve, 20);
    }));
    const saved = await withRealTimers(() => db.getContactGrantV2('f'.repeat(32), KEY));
    expect(saved?.lastProjectionHash).toBeUndefined();
    expect(saved?.lastPublishState).toBeUndefined();
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it('a run queued by a newer effect invocation is not lost when the finishing run is stale (fix round 2, item C)', async () => {
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(() => db.saveContactGrantV2(grant(), KEY));
    let resolveFirst!: (ok: boolean) => void;
    publishSpy.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveFirst = resolve; }));
    const { rerender, unmount } = renderHook((props: { safetyToken: string }) =>
      useContactProjections(baseOptions({ safetyToken: props.safetyToken }) as never),
    { initialProps: { safetyToken: 's0' } });
    await vi.advanceTimersByTimeAsync(92_000);
    await withRealTimers(() => waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1), { timeout: 10_000 }));

    // A NEWER effect invocation (safetyToken s0 -> s1) fires its own
    // "immediate" attempt while run A (s0) is still stuck awaiting
    // `publishToRelays`. It finds `runningRef` still true and gets queued
    // rather than running directly — exactly the situation round 1's
    // `cancelled` check, read on the FINISHING run (A), would have refused
    // to honour once A resolved.
    rerender({ safetyToken: 's1' });
    await vi.advanceTimersByTimeAsync(10);
    expect(publishSpy).toHaveBeenCalledTimes(1); // still just A's own call — B was queued, not run

    // Resolve A. Its OWN closure is stale by now (a newer invocation exists),
    // but the queued restart must still go through — via the LATEST `run`
    // (the newer invocation's), not A's own stale one.
    await withRealTimers(() => new Promise<void>((resolve) => {
      resolveFirst(true);
      setTimeout(resolve, 20);
    }));
    await withRealTimers(() => waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(2), { timeout: 10_000 }));

    // Nothing left queued: a further advance produces no THIRD call.
    await vi.advanceTimersByTimeAsync(92_000);
    expect(publishSpy).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('a run restarted after unmount does no decrypt work at all (round-2 re-review, item 12)', async () => {
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(() => db.saveContactGrantV2(grant(), KEY));
    let resolveFirst!: (ok: boolean) => void;
    publishSpy.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveFirst = resolve; }));
    const { rerender, unmount } = renderHook((props: { safetyToken: string }) =>
      useContactProjections(baseOptions({ safetyToken: props.safetyToken }) as never),
    { initialProps: { safetyToken: 's0' } });
    await vi.advanceTimersByTimeAsync(92_000);
    await withRealTimers(() => waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1), { timeout: 10_000 }));

    // Queue a run from a NEWER invocation while run A is still stuck on the
    // relay, exactly as the fix-round-2 test above does.
    rerender({ safetyToken: 's1' });
    await vi.advanceTimersByTimeAsync(10);
    expect(publishSpy).toHaveBeenCalledTimes(1);

    // Now the component goes away with that restart still owed. The `finally`
    // restart is unconditional by design (it always calls the LATEST `run`),
    // so the only thing that can stop it is `run`'s own first line.
    // `listContactGrantsV2ForDirectory` is the run's FIRST read (the loop's
    // opening line); `listContactOperationsV2` is the second, after that
    // grant decrypt. Both are asserted, and the wait below is real wall-clock
    // time generous enough for the (real PBKDF2) grant decrypt to have
    // completed and reached the operation log, so a passing assertion means
    // the run genuinely stopped rather than merely being slow.
    const grantsSpy = vi.spyOn(db, 'listContactGrantsV2ForDirectory');
    const opsSpy = vi.spyOn(db, 'listContactOperationsV2');
    unmount();
    await withRealTimers(() => new Promise<void>((resolve) => {
      resolveFirst(true);
      setTimeout(resolve, 1_500);
    }));

    // Not merely "published nothing" — it never even read, let alone
    // decrypted, the operation log for a component that is gone.
    expect(grantsSpy).not.toHaveBeenCalled();
    expect(opsSpy).not.toHaveBeenCalled();
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it('a concurrent foreign write to the same grant row survives the publish-state write (R-22)', async () => {
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(() => db.saveContactGrantV2(grant(), KEY));
    let resolvePublish!: (ok: boolean) => void;
    publishSpy.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolvePublish = resolve; }));
    const saveSpy = vi.spyOn(db, 'saveContactGrantV2');
    const { unmount } = renderHook(() => useContactProjections(baseOptions() as never));
    await vi.advanceTimersByTimeAsync(92_000);
    await withRealTimers(() => waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1), { timeout: 10_000 }));

    // A different writer (the proposals hook, in production) appends to a
    // field this hook never names, while the publish is in flight.
    await withRealTimers(() => db.updateContactGrantV2('f'.repeat(32), KEY, (current) => ({
      ...current, seenOperationIds: ['9'.repeat(32)],
    })));

    await withRealTimers(async () => {
      resolvePublish(true);
      await waitFor(async () => {
        const saved = await db.getContactGrantV2('f'.repeat(32), KEY);
        expect(saved?.lastPublishState).toBe('ok');
      }, { timeout: 10_000 });
    });

    const saved = await withRealTimers(() => db.getContactGrantV2('f'.repeat(32), KEY));
    // Both survive: this hook wrote only its own three fields through the
    // serialised updater, spreading the row as the other writer left it.
    expect(saved?.seenOperationIds).toEqual(['9'.repeat(32)]);
    expect(saved?.lastProjectionHash).toMatch(/^[0-9a-f]{64}$/);
    // R-22: the whole-row overwrite is gone from this path entirely.
    expect(saveSpy).not.toHaveBeenCalled();
    unmount();
  });

  it("publishes to the grant's own relay even when it is not in relays.write (I2)", async () => {
    const OTHER_RELAY = 'wss://other.example';
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(() => db.saveContactGrantV2(grant({ relay: OTHER_RELAY }), KEY));
    const { unmount } = renderHook(() => useContactProjections(baseOptions() as never));
    await vi.advanceTimersByTimeAsync(92_000);
    await withRealTimers(() => waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(1), { timeout: 10_000 }));
    const [, targets] = publishSpy.mock.calls[0]!;
    expect(targets).toEqual(expect.arrayContaining([OTHER_RELAY, 'wss://r.example']));
    unmount();
  });

  it('does not bump updatedAt on a publish-state-only write (I3)', async () => {
    await withRealTimers(() => seedContact(CONTACT_ID, '9'.repeat(32)));
    await withRealTimers(() => db.saveContactGrantV2(grant({ updatedAt: 42 }), KEY));
    const { unmount } = renderHook(() => useContactProjections(baseOptions() as never));
    await vi.advanceTimersByTimeAsync(92_000);
    await withRealTimers(() => waitFor(async () => {
      const saved = await db.getContactGrantV2('f'.repeat(32), KEY);
      expect(saved?.lastPublishState).toBe('ok');
    }, { timeout: 10_000 }));
    const saved = await withRealTimers(() => db.getContactGrantV2('f'.repeat(32), KEY));
    expect(saved?.updatedAt).toBe(42);
    unmount();
  });

  it('truncates an oversized directory and reports lastPublishState "truncated", and the SDK still parses the event (M3)', async () => {
    await withRealTimers(() => seedManyContacts(700, 90));
    await withRealTimers(() => db.saveContactGrantV2(grant(), KEY));
    const { unmount } = renderHook(() => useContactProjections(baseOptions() as never));
    await vi.advanceTimersByTimeAsync(92_000);
    await withRealTimers(() => waitFor(async () => {
      const saved = await db.getContactGrantV2('f'.repeat(32), KEY);
      expect(saved?.lastPublishState).toBe('truncated');
    }, { timeout: 10_000 }));
    const [event] = publishSpy.mock.calls[0]!;
    const app = new LocalSigningBackend(APP_SK);
    const plaintext = await openVaultPayload(event.content, app, grant().railPubkey, { legacyFallback: false });
    const parsed = parseProjection(plaintext!);
    expect(parsed).not.toBeNull();
    expect(parsed?.truncated).toBe(true);
    expect(parsed!.contacts.length).toBeLessThan(700);
    unmount();
  });

  it("scopes each grant to only its OWN directory's contacts (M3)", async () => {
    const DEP_GRANT = grant({
      grantId: 'e'.repeat(32), directoryId: DEP_DIR_ID,
      appPubkey: new LocalSigningBackend(DEP_APP_SK).activePublicKeyHex,
      railPubkey: new LocalSigningBackend(DEP_RAIL_SK).activePublicKeyHex, railPrivateKey: DEP_RAIL_SK,
    });
    await withRealTimers(async () => {
      await seedContact(CONTACT_ID, '9'.repeat(32));
      await seedDepContact(DEP_CONTACT_ID, '8'.repeat(32));
      await db.saveContactGrantV2(grant(), KEY);
      await db.saveContactGrantV2(DEP_GRANT, KEY);
    });
    const { unmount } = renderHook(() => useContactProjections(
      baseOptions({ directories: TWO_DIRECTORIES }) as never,
    ));
    await vi.advanceTimersByTimeAsync(92_000);
    await withRealTimers(() => waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(2), { timeout: 10_000 }));

    const ownerTag = projectionTag('f'.repeat(32));
    const depTag = projectionTag('e'.repeat(32));
    const ownerEvent = publishSpy.mock.calls.map(([e]: [NostrEvent, string[]]) => e).find((e: NostrEvent) => e.tags[0]?.[1] === ownerTag)!;
    const depEvent = publishSpy.mock.calls.map(([e]: [NostrEvent, string[]]) => e).find((e: NostrEvent) => e.tags[0]?.[1] === depTag)!;
    expect(ownerEvent).toBeDefined();
    expect(depEvent).toBeDefined();

    const ownerApp = new LocalSigningBackend(APP_SK);
    const ownerPlain = await openVaultPayload(ownerEvent.content, ownerApp, grant().railPubkey, { legacyFallback: false });
    const ownerProjection = parseProjection(ownerPlain!)!;
    expect(ownerProjection.contacts).toHaveLength(1);
    expect(ownerProjection.contacts[0]?.contactId).toBe(scopedContactId('f'.repeat(32), CONTACT_ID));

    const depApp = new LocalSigningBackend(DEP_APP_SK);
    const depPlain = await openVaultPayload(depEvent.content, depApp, DEP_GRANT.railPubkey, { legacyFallback: false });
    const depProjection = parseProjection(depPlain!)!;
    expect(depProjection.contacts).toHaveLength(1);
    expect(depProjection.contacts[0]?.contactId).toBe(scopedContactId('e'.repeat(32), DEP_CONTACT_ID));

    unmount();
  });

  it("an appLabels entry overrides displayName in THAT app's projection only (M3)", async () => {
    const OTHER_GRANT = grant({
      grantId: 'e'.repeat(32),
      appPubkey: new LocalSigningBackend(DEP_APP_SK).activePublicKeyHex,
      railPubkey: new LocalSigningBackend(DEP_RAIL_SK).activePublicKeyHex, railPrivateKey: DEP_RAIL_SK,
      // No label override on this grant — sees the real display name.
    });
    const LABELLED_GRANT = grant({
      grantId: 'c'.repeat(32),
      appLabels: { [scopedContactId('c'.repeat(32), CONTACT_ID)]: { label: 'Nickname', updatedAt: 1 } },
    });
    await withRealTimers(async () => {
      await seedContact(CONTACT_ID, '9'.repeat(32));
      await db.saveContactGrantV2(OTHER_GRANT, KEY);
      await db.saveContactGrantV2(LABELLED_GRANT, KEY);
    });
    const { unmount } = renderHook(() => useContactProjections(baseOptions() as never));
    await vi.advanceTimersByTimeAsync(92_000);
    await withRealTimers(() => waitFor(() => expect(publishSpy).toHaveBeenCalledTimes(2), { timeout: 10_000 }));

    const otherTag = projectionTag('e'.repeat(32));
    const labelledTag = projectionTag('c'.repeat(32));
    const otherEvent = publishSpy.mock.calls.map(([e]: [NostrEvent, string[]]) => e).find((e: NostrEvent) => e.tags[0]?.[1] === otherTag)!;
    const labelledEvent = publishSpy.mock.calls.map(([e]: [NostrEvent, string[]]) => e).find((e: NostrEvent) => e.tags[0]?.[1] === labelledTag)!;

    const otherApp = new LocalSigningBackend(DEP_APP_SK);
    const otherPlain = await openVaultPayload(otherEvent.content, otherApp, OTHER_GRANT.railPubkey, { legacyFallback: false });
    expect(parseProjection(otherPlain!)!.contacts[0]?.displayName).toBe('Ada');

    const labelledApp = new LocalSigningBackend(APP_SK);
    const labelledPlain = await openVaultPayload(labelledEvent.content, labelledApp, LABELLED_GRANT.railPubkey, { legacyFallback: false });
    expect(parseProjection(labelledPlain!)!.contacts[0]?.displayName).toBe('Nickname');

    unmount();
  });
});

describe('publishProjectionForGrant', () => {
  it('seals to the app pubkey and signs with the rail key', async () => {
    const g = grant();
    const projection = buildRevocationProjection(g.grantId, g.capabilities, 1_700_000_000, DEVICE);
    const res = await publishProjectionForGrant(g, projection, RELAYS.write);
    expect(res.ok).toBe(true);
    expect(res.state).toBe('ok');
    const [event] = publishSpy.mock.calls[0]!;
    const app = new LocalSigningBackend(APP_SK);
    const plaintext = await openVaultPayload(event.content, app, g.railPubkey, { legacyFallback: false });
    expect(parseProjection(plaintext!)?.revoked).toBe(true);
  });

  it('reports truncated when the projection says it was', async () => {
    const g = grant();
    const projection = {
      ...buildRevocationProjection(g.grantId, g.capabilities, 1_700_000_000, DEVICE),
      revoked: undefined, truncated: true as const,
    };
    const res = await publishProjectionForGrant(g, projection as never, RELAYS.write);
    expect(res.state).toBe('truncated');
  });

  it('returns ok:false and state failed for an invalid relay list rather than throwing', async () => {
    const g = grant();
    const projection = buildRevocationProjection(g.grantId, g.capabilities, 1, DEVICE);
    publishSpy.mockResolvedValueOnce(false);
    const res = await publishProjectionForGrant(g, projection, []);
    expect(res.ok).toBe(false);
    expect(res.state).toBe('failed');
  });

  it('shares the monotonic chain with any other direct caller for the same grant (fix round 2, item I/R-24)', async () => {
    // Mirrors `contacts-v2-grants-rail.test.ts`'s own "M4: created_at is
    // strictly monotonic across two publishes in the same second" — relative
    // assertions only, no clock mocking needed, matching that file's proven
    // pattern for testing a module-scope monotonic counter.
    const g = grant();
    // Two "hook" publishes for the same grant, back to back.
    const p1 = buildRevocationProjection(g.grantId, g.capabilities, 5, DEVICE);
    await publishProjectionForGrant(g, p1, RELAYS.write);
    const p2 = buildRevocationProjection(g.grantId, g.capabilities, 5, DEVICE);
    await publishProjectionForGrant(g, p2, RELAYS.write);
    expect(publishSpy.mock.calls).toHaveLength(2);
    const [firstEvent] = publishSpy.mock.calls[0]! as [NostrEvent];
    const [secondEvent] = publishSpy.mock.calls[1]! as [NostrEvent];
    expect(secondEvent.created_at).toBeGreaterThan(firstEvent.created_at);

    // A totally separate DIRECT caller — in spirit, Task 22's revoke handler
    // — builds its OWN projection with `now` = 1: far BEHIND both publishes
    // above, and behind the real wall clock too. The shared chain must still
    // produce something strictly greater than what this grant has already
    // published under, ignoring the caller's stale `now` entirely.
    const revocation = buildRevocationProjection(g.grantId, g.capabilities, 1, DEVICE);
    const res = await publishProjectionForGrant(g, revocation, RELAYS.write);
    expect(res.ok).toBe(true);
    const [revokeEvent] = publishSpy.mock.calls[2]! as [NostrEvent];
    expect(revokeEvent.created_at).toBeGreaterThan(secondEvent.created_at);
  });
});

describe('keepaliveDue / keepaliveDelayMs (R-29)', () => {
  const g = (lastProjectionAt: number | undefined, maxStalenessSeconds = 21600) =>
    ({ lastProjectionAt, maxStalenessSeconds });

  it('is not due before half the window, and is due at and after it', () => {
    expect(keepaliveDue(g(1000), 1000 + 10_799)).toBe(false);
    expect(keepaliveDue(g(1000), 1000 + 10_800)).toBe(true);
    expect(keepaliveDue(g(1000), 1000 + 50_000)).toBe(true);
  });

  it('uses each grant’s OWN window, because the owner chose it per app', () => {
    // One hour, the shortest the approval screen offers.
    expect(keepaliveDue(g(1000, 3600), 1000 + 1799)).toBe(false);
    expect(keepaliveDue(g(1000, 3600), 1000 + 1800)).toBe(true);
    // Seven days, the longest.
    expect(keepaliveDue(g(1000, 604800), 1000 + 1800)).toBe(false);
  });

  it('never fires for a grant that has never published — there is nothing to keep alive', () => {
    expect(keepaliveDue(g(undefined), 9_999_999)).toBe(false);
    expect(keepaliveDelayMs(g(undefined), 9_999_999)).toBe(0);
  });

  it('counts down to the half-window moment and floors at zero', () => {
    expect(keepaliveDelayMs(g(1000), 1000)).toBe(10_800_000);
    expect(keepaliveDelayMs(g(1000), 1000 + 10_000)).toBe(800_000);
    expect(keepaliveDelayMs(g(1000), 1000 + 99_999)).toBe(0);
  });
});

describe('keepaliveArmable — only a successful publish is kept alive', () => {
  it('refuses a grant that has never published', () => {
    // A keepalive for one of these would re-run the whole directory — decrypt
    // the operation log, reduce, seal, attempt a relay — every minute for as
    // long as the app is unlocked, with no backoff and nothing to keep alive.
    expect(keepaliveArmable({ lastProjectionAt: undefined, lastPublishState: undefined })).toBe(false);
    expect(keepaliveArmable({ lastProjectionAt: undefined, lastPublishState: 'failed' })).toBe(false);
  });

  it('refuses a grant whose last publish failed, even though an earlier one landed', () => {
    expect(keepaliveArmable({ lastProjectionAt: 1000, lastPublishState: 'failed' })).toBe(false);
  });

  it('accepts ok and truncated — both are publishes that actually landed', () => {
    // `publishProjectionForGrant` only reports 'truncated' with `ok: true`,
    // and `lastProjectionAt` is written on success alone, so a truncated
    // projection's `expiresAt` is ticking exactly like an 'ok' one's. A large
    // stable directory is the case that would otherwise go permanently stale.
    expect(keepaliveArmable({ lastProjectionAt: 1000, lastPublishState: 'ok' })).toBe(true);
    expect(keepaliveArmable({ lastProjectionAt: 1000, lastPublishState: 'truncated' })).toBe(true);
    // A row written before `lastPublishState` existed: `lastProjectionAt` is
    // still proof it published.
    expect(keepaliveArmable({ lastProjectionAt: 1000, lastPublishState: undefined })).toBe(true);
  });
});

describe('keepaliveDelayForRun — the whole arming decision', () => {
  const ok = (lastProjectionAt: number, maxStalenessSeconds = 21600) =>
    ({ lastProjectionAt, maxStalenessSeconds, lastPublishState: 'ok' as const });

  it('arms NOTHING for a run whose grants have never published', () => {
    // The bug this closes: `Math.max(KEEPALIVE_MIN_MS, Infinity)` is
    // `Infinity`, but `Math.max(KEEPALIVE_MIN_MS, 0)` — which is what an
    // undefined `lastProjectionAt` produced through `keepaliveDelayMs` — is
    // 60 s. So a grant with nothing to keep alive re-ran the whole directory
    // every minute for as long as the app stayed unlocked, with no backoff.
    expect(keepaliveDelayForRun([], 1000)).toBeNull();
    expect(keepaliveDelayForRun(
      [{ lastProjectionAt: undefined, maxStalenessSeconds: 21600, lastPublishState: undefined }], 1000,
    )).toBeNull();
  });

  it('arms nothing for a run whose only grant last failed to publish', () => {
    expect(keepaliveDelayForRun(
      [{ lastProjectionAt: 1000, maxStalenessSeconds: 21600, lastPublishState: 'failed' }], 1000,
    )).toBeNull();
  });

  it('ignores the unarmable grants and follows the soonest armable one', () => {
    const delay = keepaliveDelayForRun([
      { lastProjectionAt: undefined, maxStalenessSeconds: 3600, lastPublishState: undefined },
      { lastProjectionAt: 1000, maxStalenessSeconds: 3600, lastPublishState: 'failed' },
      ok(1000, 3600),
    ], 1000);
    // The never-published and failed grants would each have computed 0, and
    // the 60 s floor would then have won the `Math.min` — the armable grant's
    // own half-window (1800 s) is what decides instead.
    expect(delay).toBe(1_800_000);
  });

  it('takes the soonest of several armable grants', () => {
    expect(keepaliveDelayForRun([ok(1000, 21600), ok(1000, 3600)], 1000)).toBe(1_800_000);
  });

  it('clamps a tiny window up to the floor rather than becoming a busy loop', () => {
    // Already past its half-window: the raw delay is 0.
    expect(keepaliveDelayForRun([ok(1000, 3600)], 99_999)).toBe(60_000);
  });

  it('clamps a seven-day window down to the ceiling, so the decision is re-made hourly', () => {
    // A timer parked for days is one a backgrounded phone never honours; the
    // real decision is re-made from the stored `lastProjectionAt` each hour.
    expect(keepaliveDelayForRun([ok(1000, 604800)], 1000)).toBe(3_600_000);
  });
});
