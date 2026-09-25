import { useSyncReadRetry } from './useSyncReadRetry';
import { guardedSigningBackend } from '../lib/guarded-signing-backend';
/**
 * Contacts v2 relay rail hook (`contacts-v2-sync.ts`).
 *
 * Same shape as `usePersonasSync`: fetch-and-merge on unlock behind an M7
 * `hydrated` gate, then a debounced, jittered publish (Task 12). Three
 * differences from the older rails, all forced by the rail's shape:
 *
 *  - It is not one replaceable record, so `remoteState` and `syncSeen` are
 *    keyed on the CHECKPOINT tag. An outbox going missing is not a lost
 *    backup; a missing checkpoint is.
 *  - There are many `d` tags, so the §11.1.10 decrypt cache is a per-tag
 *    factory rather than a single cache. The caches are memoised per unlock
 *    exactly as the single-rail ones are, so PBKDF2 still runs once.
 *  - The fetch reports a THREE-state checkpoint result (R2). `'unusable'` —
 *    an event exists but could not be opened, parsed, reassembled, or is
 *    older than what this device recorded — is carried into Task 12's publish
 *    decision, because compacting over a checkpoint we could not read would
 *    replace every other device's operations with ours alone.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContactOperation, SignetIdentity } from '../types';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import * as db from '../lib/db';
import {
  fetchContactsV2Sync,
  publishContactsV2Outbox,
  publishContactsV2Checkpoint,
  shouldPublishCheckpoint,
  selectOutboxOps,
  nextCheckpointSeq,
  mergeDeviceIds,
  exceedsCheckpointCeiling,
  tagFor,
  MAX_OPS_PER_PAYLOAD,
  type CacheForTag,
  type CheckpointState,
  type ContactsV2RemoteCheckpoint,
} from '../lib/contacts-v2-sync';
import { createSyncDecryptCache, type SyncDecryptCache } from '../lib/sync-decrypt-cache';
import { getSyncSeen, setSyncSeen, classifyFetchOutcome, type SyncRemoteState } from '../lib/sync-seen';
import { computePublishDelayMs } from '../lib/personas-sync';

/**
 * R6: whether the local log still fits the rail at all.
 *
 * `'stalled'` is the Task 6 review ruling: the checkpoint is `'unusable'` (R2
 * forbids compacting over it) AND this device's outbox is too big for the
 * single envelope `publishContactsV2Outbox` accepts, so there is no leg left
 * that could possibly succeed. Reported once and left alone rather than
 * retried every debounce cycle against a relay call that will always refuse.
 */
export type ContactsV2BackupState = 'ok' | 'too-large' | 'stalled';

export interface UseContactsV2SyncOptions {
  publishEnabled?: boolean;
  /** Directories whose writers have moved to dedicated keys. Reads still merge them. */
  publishExcludedDirectories?: readonly string[];
  identity: SignetIdentity | null;
  npBackend: DecryptingSigningBackend | null;
  relays: { read: string[]; write: string[] };
  encryptionKey: string | null;
  /** `AppPreferences.contactsDeviceId` (Phase B). */
  deviceId: string | null;
  /** Bumped by any local v2 mutation; re-arms the debounced publish. */
  opsVersion: number;
  /** Called after remote operations are merged in, so the caller can reload derived state. */
  onRemoteMerged?: () => void;
  /**
   * R10: fired when the v2-canonical check flips. True once this device has
   * READ BACK a checkpoint that names its own device id — the cheap stand-in
   * for the spec's publish/fetch-back/verify ceremony. App gates the legacy
   * contacts and kens publishers on it.
   */
  onVerifiedChange?: (verified: boolean) => void;
  /**
   * M9: fired every time `backupState` is (re)computed — from the fetch
   * effect's merge step as well as the publish cycle — so a caller that
   * needs the CURRENT value before this hook's own return value is
   * available in the same render (R-VERIFIED-TWO-WAY's App-level gate,
   * declared earlier in the component than this hook is mounted) can hold
   * its own state fed by this callback instead. The hook's return value
   * stays the source of truth for direct consumers (tests included); this
   * is purely an additional notification.
   */
  onBackupStateChange?: (state: ContactsV2BackupState) => void;
  /** Jitter injection for tests. Defaults to Math.random. */
  random?: () => number;
  /**
   * Whole-checkpoint operation ceiling. Defaults to `MAX_CHECKPOINT_OPS`;
   * injectable only so the `'too-large'` branch can be exercised without
   * building 64 001 operations, each of which costs a 600k-iteration PBKDF2
   * encrypt.
   */
  maxCheckpointOps?: number;
  /**
   * Ceiling for a single outbox publish. Defaults to `MAX_OPS_PER_PAYLOAD`;
   * injectable so the `'stalled'` branch (Task 6 review ruling) can be
   * exercised without building 2001 operations.
   */
  maxOutboxOps?: number;
  /**
   * Overrides `computePublishDelayMs(random ?? Math.random)` outright when
   * given. Test-only (I3): the production debounce is a real 6-90s wait, and
   * a suite exercising many publish cycles at that pace is both slow and
   * exercises nothing the delay VALUE itself doesn't already cover once. Omit
   * to get the real jittered delay.
   */
  publishDelayMs?: number;
}

/** What the last fetch learned about the relay's checkpoint. */
type CheckpointRef = Pick<ContactsV2RemoteCheckpoint, 'seq' | 'createdAt' | 'deviceIds' | 'frontierOpIds' | 'frontierMaxClock'>;

/**
 * Publish-idempotency hash for an operation list. Operation ids are immutable
 * and globally unique, so the sorted id set is a complete identity for the
 * payload — no need to serialise the bodies.
 */
function hashOps(ops: ContactOperation[]): string {
  return JSON.stringify(ops.map((o) => o.operationId).sort());
}

/**
 * M9: the single source of truth for `backupState`, shared by the fetch
 * effect and the publish cycle — a stale `'too-large'`/`'stalled'` must clear
 * the moment EITHER learns the log shrank or the checkpoint became readable
 * again, not only on the next debounced publish (which can be many seconds
 * away, or gated off entirely while `remoteState === 'unreachable'`).
 */
function computeBackupState(args: {
  localOpsCount: number;
  outboxOpsCount: number;
  checkpointState: CheckpointState;
  maxCheckpointOps?: number;
  maxOutboxOps?: number;
}): ContactsV2BackupState {
  const tooLarge = args.maxCheckpointOps === undefined
    ? exceedsCheckpointCeiling(args.localOpsCount)
    : args.localOpsCount > args.maxCheckpointOps;
  const outboxCeiling = args.maxOutboxOps === undefined ? MAX_OPS_PER_PAYLOAD : args.maxOutboxOps;
  const stalled = !tooLarge && args.checkpointState === 'unusable' && args.outboxOpsCount > outboxCeiling;
  return tooLarge ? 'too-large' : stalled ? 'stalled' : 'ok';
}

export function useContactsV2Sync({
  publishEnabled = true, publishExcludedDirectories = [],
  identity,
  npBackend,
  relays,
  encryptionKey,
  deviceId,
  opsVersion,
  onRemoteMerged,
  onVerifiedChange,
  onBackupStateChange,
  random,
  maxCheckpointOps,
  maxOutboxOps,
  publishDelayMs,
}: UseContactsV2SyncOptions): { remoteState: SyncRemoteState | null; backupState: ContactsV2BackupState } {
  const excludedKey = [...publishExcludedDirectories].sort().join('|');
  const authorPubkey = identity?.naturalPerson.publicKey ?? null;
  const checkpointTag = useMemo(
    () => (authorPubkey ? tagFor(authorPubkey, 'checkpoint') : null),
    [authorPubkey],
  );

  // One decrypt cache per `d` tag, all under the same unlock key. Memoised so
  // the PBKDF2 derivation inside `createSyncDecryptCache` happens once per
  // unlock, not once per tag per fetch.
  const cacheFor = useMemo<CacheForTag | undefined>(() => {
    if (!authorPubkey || !encryptionKey) return undefined;
    const caches = new Map<string, SyncDecryptCache>();
    return (tag: string) => {
      let cache = caches.get(tag);
      if (!cache) {
        cache = createSyncDecryptCache({ dTag: tag, authorPubkey, encryptionKey });
        caches.set(tag, cache);
      }
      return cache;
    };
  }, [authorPubkey, encryptionKey]);

  const [remoteState, setRemoteState] = useState<SyncRemoteState | null>(null);
  const readRetry = useSyncReadRetry(remoteState === 'unreachable');
  const [backupState, setBackupState] = useState<ContactsV2BackupState>('ok');
  const [hydrated, setHydrated] = useState(false);
  const checkpointRef = useRef<CheckpointRef | null>(null);
  // R2: `'unusable'` must reach the publish decision, not be flattened to null.
  const checkpointStateRef = useRef<CheckpointState>('absent');
  const lastPublishedHashRef = useRef<string>('');
  const onRemoteMergedRef = useRef(onRemoteMerged);
  onRemoteMergedRef.current = onRemoteMerged;
  const onVerifiedChangeRef = useRef(onVerifiedChange);
  onVerifiedChangeRef.current = onVerifiedChange;
  const onBackupStateChangeRef = useRef(onBackupStateChange);
  onBackupStateChangeRef.current = onBackupStateChange;
  // M9: the one place `backupState` is ever written — keeps the React state
  // and the change notification from being able to drift apart.
  const publishBackupState = (state: ContactsV2BackupState) => {
    setBackupState(state);
    onBackupStateChangeRef.current?.(state);
  };
  const verifiedRef = useRef(false);
  const publishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // R2: the highest checkpoint sequence this device has ever recorded, read
  // once per fetch. `nextCheckpointSeq` takes the max of this and whatever the
  // relay served, so a rollback cannot walk the sequence backwards.
  const persistedSeqRef = useRef<number | null>(null);
  // M5: guards against two publish callbacks running concurrently — the
  // debounce timer firing while a PREVIOUS invocation is still awaiting a
  // relay call (a deps change can create a new timer before the old
  // callback's own async work has settled; `clearTimeout` in the effect
  // cleanup cannot cancel a callback that has already started running).
  const inFlightRef = useRef(false);
  // Fix round 2, point 2: a cycle that collided with an in-flight one (and
  // was skipped, above) must not be dropped silently — this flags that a
  // follow-up is owed, so the in-flight cycle's own `finally` can re-arm
  // ONE more debounce once it finishes, rather than the collided-with
  // mutation/fetch sitting unpublished until some LATER unrelated event.
  const pendingRef = useRef(false);
  // M6: identifies "the same identity, still unlocked with the same key" —
  // `${authorPubkey}:${encryptionKey}`. Compared at the top of the fetch
  // effect so a genuinely NEW identity/unlock resets the refs below, while a
  // relay-list edit (which also re-runs that effect) does not — I1 depends
  // on `persistedSeqRef` surviving exactly that.
  const identityGenerationRef = useRef<string | null>(null);
  // I1: true unmount only — a dedicated empty-deps effect below, distinct
  // from every dependency-driven re-run of the publish effect (an opsVersion
  // bump re-runs that effect constantly and must NOT be mistaken for the
  // hook itself going away).
  const mountedRef = useRef(true);
  // I1: the publish effect's OWN identity/unlock fingerprint — deliberately
  // separate from `identityGenerationRef` above (which the FETCH effect
  // owns and only updates while `identity` is non-null). A lock clears
  // `identity` to null, which makes the fetch effect's own guard skip that
  // update entirely — so a fingerprint that must go BACK to null on lock
  // needs its own ref, updated unconditionally at the top of the publish
  // effect on every run, guard or no guard.
  const publishIdentityRef = useRef<string | null>(null);

  const readRelaysKey = relays.read.join('|');
  const writeRelaysKey = relays.write.join('|');

  // I1: true-unmount signal for the publish effect's in-flight/collision
  // re-arm — empty deps, so this only fires on the hook instance actually
  // going away, never on a same-identity dependency-driven re-run.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!identity || !npBackend || !authorPubkey || !deviceId || !checkpointTag) return;

    // M6/Fix round 2 point 3: a genuinely new identity/unlock must not
    // inherit stale per-relay in-memory state from a previous one.
    // Compared against a fingerprint rather than reset unconditionally,
    // because THIS effect also re-runs on a mere relay-list edit
    // (readRelaysKey) — I1's fix depends on `persistedSeqRef` surviving
    // exactly that, so only an actual identity/key change may clear it.
    //
    // Computed and applied BEFORE the `relays.read.length === 0` bail below
    // — a write-only relay config means the fetch below never runs at all
    // for this identity, so the OLD reset-only-inside-the-async-block
    // version left `checkpointRef`/`hydrated` holding the PREVIOUS
    // identity's state forever, which the publish effect (gated only on
    // `relays.write`, not `relays.read`) would run against. `hydrated` is
    // reset here too: a brand-new identity has not hydrated under this hook
    // instance yet, and without read relays it never can — staying
    // un-hydrated forever in that case is the correct, conservative
    // behaviour (publishing blind, having never read the current
    // checkpoint, is exactly the data loss R2 exists to prevent).
    const identityGeneration = `${authorPubkey}:${encryptionKey}`;
    if (identityGenerationRef.current !== identityGeneration) {
      identityGenerationRef.current = identityGeneration;
      checkpointRef.current = null;
      checkpointStateRef.current = 'absent';
      lastPublishedHashRef.current = '';
      verifiedRef.current = false;
      persistedSeqRef.current = null;
      setHydrated(false);
    }

    if (relays.read.length === 0 || !encryptionKey) return;

    let cancelled = false;
    setHydrated(false); // new sync target — re-gate publish until this run completes

    (async () => {
      try {
        const seen = await getSyncSeen(authorPubkey, checkpointTag, { legacyAuthorScopedTag: true });
        // I1: MAX, never overwrite — `seen` is this device's LOCAL record of
        // the last checkpoint IT SAW ON A RELAY READ, which a successful
        // PUBLISH does not update (only a subsequent successful fetch does,
        // below). A relay-list edit or re-unlock re-runs this effect, and a
        // stale/absent local `seen` must not walk the in-memory high-water
        // mark backwards under a device that already published past it —
        // that republishes at a USED sequence, which every other device
        // reads as an R2 rollback and wedges on.
        persistedSeqRef.current = Math.max(persistedSeqRef.current ?? 0, seen?.seq ?? 0) || null;
        if (cancelled) return;

        const remote = await fetchContactsV2Sync({
          authorPubkey,
          backend: npBackend,
          relayUrls: relays.read,
          localDeviceId: deviceId,
          // R2: what this device already recorded, so the fetch can refuse to
          // adopt a checkpoint the relay has rolled back.
          persisted: { seq: seen?.seq ?? null, eventCreatedAt: seen?.createdAt ?? null },
          cacheFor,
        });
        if (cancelled) return;

        if (remote === 'unreachable') {
          setRemoteState('unreachable');
          return;
        }
        if (remote === null) {
          // M2: a malformed author is a caller bug, not a relay fact — but
          // Task 12's publish effect only gates off `remoteState ===
          // 'unreachable'`. Leaving this null (e.g. this device's very
          // first-ever fetch) would let the publish effect read "unknown" as
          // "safe to proceed" and publish blind.
          setRemoteState('unreachable');
          return;
        }

        checkpointStateRef.current = remote.checkpointState;
        checkpointRef.current = remote.checkpoint
          ? {
              seq: remote.checkpoint.seq,
              createdAt: remote.checkpoint.createdAt,
              deviceIds: remote.checkpoint.deviceIds,
              frontierOpIds: remote.checkpoint.frontierOpIds,
              frontierMaxClock: remote.checkpoint.frontierMaxClock,
            }
          : null;

        if (remote.checkpoint) {
          await setSyncSeen(authorPubkey, checkpointTag, {
            eventId: remote.checkpoint.eventId,
            createdAt: remote.checkpoint.eventCreatedAt,
            seq: remote.checkpoint.seq,
          });
          persistedSeqRef.current = Math.max(persistedSeqRef.current ?? 0, remote.checkpoint.seq);
          if (cancelled) return;
          setRemoteState('present');
          // R10: a checkpoint we could read that NAMES this device is proof
          // that a full round trip works here. Only then may the legacy
          // publishers stand down.
          if (!verifiedRef.current && remote.checkpoint.deviceIds.includes(deviceId)) {
            verifiedRef.current = true;
            onVerifiedChangeRef.current?.(true);
          }
        } else if (remote.checkpointState === 'unusable') {
          // R9: a record exists; we just could not use it. Reporting a missing
          // backup here would be both wrong and alarming. `syncSeen` is
          // deliberately NOT written — an unreadable event must not overwrite
          // the sequence we are protecting.
          setRemoteState('present');
        } else {
          const seenBefore = !!seen;
          setRemoteState(classifyFetchOutcome({
            found: false,
            reachableRelays: remote.reachableRelays,
            seenBefore,
          }));
        }

        // M3: a LOCAL failure past this point (IDB quota, a thrown decrypt)
        // is not a relay fact — `remoteState` above already reflects what
        // the fetch itself learned, correctly, and this nested try/catch
        // keeps a merge-step failure from falling into the outer catch and
        // being misreported as `'unreachable'`.
        try {
          const local = await db.listAllContactOperationsV2(encryptionKey);
          if (cancelled) return;
          const known = new Set(local.map((o: ContactOperation) => o.operationId));
          const incoming = remote.ops.filter((o) => !known.has(o.operationId));
          if (incoming.length > 0) {
            // I2 perf: one PBKDF2 derivation for the whole incoming batch
            // instead of one per operation.
            await db.saveContactOperationsV2(incoming, encryptionKey);
            // M1: fire even if `cancelled` flipped while this awaited — the
            // writes just above are already durable in IDB regardless, so a
            // caller reload must still follow them. Suppressing this
            // callback here would leave a merged operation sitting
            // unreflected in the caller's own state.
            onRemoteMergedRef.current?.();
          }
          // M9: recompute `backupState` right here too, not only in the
          // publish cycle — a stale `'too-large'`/`'stalled'` from a prior
          // cycle must clear as soon as THIS fetch shows a readable
          // checkpoint or a shrunk log, since the next publish cycle may be
          // seconds away or gated off entirely while unreachable.
          if (!cancelled) {
            const allLocalOps = incoming.length > 0 ? [...local, ...incoming] : local;
            const outboxOps = selectOutboxOps(allLocalOps, checkpointRef.current?.frontierOpIds ?? []);
            publishBackupState(computeBackupState({
              localOpsCount: allLocalOps.length,
              outboxOpsCount: outboxOps.length,
              checkpointState: checkpointStateRef.current,
              maxCheckpointOps,
              maxOutboxOps,
            }));
          }
        } catch {
          // Non-fatal — the fetch succeeded and `remoteState` already
          // reflects that; a re-reduce on the next load recovers the rest.
        }
      } catch {
        // R2/S11: a THROWN fetch is the state in which we know least about the
        // relay. Reporting `'unreachable'` gates Task 12's publish effect off;
        // leaving `remoteState` null would let it publish a fresh checkpoint
        // over whatever is actually out there.
        if (!cancelled) setRemoteState('unreachable');
      } finally {
        // Hydrated even on failure: blocking the publish gate for the rest of
        // the session would strand this device's local-only operations. The
        // `'unreachable'` state above is what actually holds publishing back,
        // and it lifts the moment a later fetch succeeds.
        if (!cancelled) setHydrated(true);
      }
    })().catch(() => { /* non-fatal — next unlock retries */ });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readRetry,identity, npBackend, authorPubkey, deviceId, readRelaysKey, encryptionKey, cacheFor, checkpointTag]);

  // Debounced, jittered publish. Gated on `hydrated` (M7) AND on the last
  // fetch outcome not being `'unreachable'` — `remoteState` is in the deps, so
  // the moment a later fetch succeeds the effect re-evaluates and resumes.
  //
  // `computePublishDelayMs` IS the debounce: the personas rail folds its one
  // second into the same number as the 5–90 s jitter, and this rail reuses it
  // verbatim. The old one-second contacts debounce is retired with it, so
  // adding a contact no longer produces an immediately observable relay event.
  useEffect(() => {
    // I1: updated UNCONDITIONALLY, before the guard below — this is what
    // lets a lock (which zeroes `identity`/`encryptionKey`, making the guard
    // fail and short-circuiting the rest of this effect) still be visible to
    // an in-flight cycle scheduled under a PREVIOUS identity. Deliberately
    // its own ref rather than `identityGenerationRef` (owned by the fetch
    // effect, which only updates it while `identity` is non-null and pairs
    // the update with a reset of unrelated fetch-side state) — this one
    // exists solely so `runCycle` below can tell "the identity/unlock this
    // cycle was scheduled under" apart from "whatever is current now",
    // including the "now there isn't one" case.
    const currentPublishIdentity = (identity && authorPubkey && encryptionKey)
      ? `${authorPubkey}:${encryptionKey}:${publishEnabled}:${excludedKey}`
      : null;
    publishIdentityRef.current = currentPublishIdentity;
    if (!publishEnabled) return;

    if (!identity || !npBackend || !authorPubkey || !deviceId) return;
    if (relays.write.length === 0 || !encryptionKey) return;
    if (!hydrated) return;
    if (remoteState === 'unreachable') return;

    const delay = publishDelayMs ?? computePublishDelayMs(random ?? Math.random);

    // I1: captured at schedule time, compared at fire time — the identity/
    // unlock this cycle was meant for.
    const generationAtSchedule = currentPublishIdentity;
    // The timer handle THIS effect instance scheduled — tracked locally, not
    // just read back off `publishTimerRef`, so cleanup and the collision
    // re-arm below only ever clear/replace a timer this closure actually
    // owns, never one a newer effect instance scheduled after this one's
    // own timer already fired.
    let myTimerHandle: ReturnType<typeof setTimeout> | null = null;
    const schedule = (ms: number) => {
      myTimerHandle = setTimeout(runCycle, ms);
      publishTimerRef.current = myTimerHandle;
    };
    // I1: is it still safe for a cycle scheduled under `generationAtSchedule`
    // to do work / re-arm right now? False on true unmount (`mountedRef`,
    // empty-deps effect above — never on a mere same-identity re-run) OR
    // once `publishIdentityRef` has moved on to a different identity/unlock
    // (including "gone", on a lock) — deliberately NOT gated on whether
    // ANOTHER effect instance has since run (a same-identity opsVersion
    // bump does that constantly, and the collision re-arm below exists
    // precisely so that case still completes via THIS closure).
    const stillCurrent = () => mountedRef.current && publishIdentityRef.current === generationAtSchedule;
    const publishingBackend = guardedSigningBackend(npBackend, stillCurrent);

    // Named so the `finally` below can re-arm it directly (Fix round 2,
    // point 2) rather than needing a second, differently-shaped scheduling
    // path for the collision case.
    const runCycle = async () => {
      // I1: bail before any work — no decrypt, no publish, no re-arm — when
      // this cycle's identity/unlock has moved on, or the hook has actually
      // unmounted, since it was scheduled.
      if (!stillCurrent()) return;
      if (publishTimerRef.current === myTimerHandle) publishTimerRef.current = null;
      // M5: a fresh debounce timer can fire while a PREVIOUS invocation
      // (from before a deps change replaced it, or from the re-arm below)
      // is still awaiting a relay call. Skip rather than run two publish
      // cycles concurrently against the same mutable refs — flag that a
      // follow-up is owed instead of dropping it (Fix round 2, point 2).
      if (inFlightRef.current) {
        pendingRef.current = true;
        return;
      }
      inFlightRef.current = true;
      // M4: a rejecting local read/write (IDB failure, a thrown decrypt)
      // must not escape a bare `setTimeout` callback as an unhandled
      // rejection — the next debounce cycle retries from scratch.
      try {
        // The authoritative set is IDB, not a prop — `opsVersion` is only the
        // signal that it changed.
        const localOps = (await db.listAllContactOperationsV2(encryptionKey)).filter(op => !publishExcludedDirectories.includes(op.directoryId));
        // I1 residual: re-check after the await — a lock or identity switch
        // that lands WHILE this decrypt is in flight must not let the rest
        // of this cycle run against the old identity's data, and must not
        // fire `onBackupStateChange` (below) with a value computed for an
        // identity/unlock that has since moved on.
        if (!stillCurrent()) return;
        const checkpoint = checkpointRef.current;
        const checkpointState = checkpointStateRef.current;
        const outboxOps = selectOutboxOps(localOps, checkpoint?.frontierOpIds ?? []);

        // R6/M9: `computeBackupState` is the ONE derivation, shared with the
        // fetch effect, so the two can never disagree about where the
        // ceiling is or when the rail is stalled. `tooLarge`/`stalled` below
        // are read back off its result rather than recomputed, purely so the
        // control flow further down (which needs the individual booleans,
        // not just the aggregate state) stays readable.
        const backupStateNow = computeBackupState({
          localOpsCount: localOps.length,
          outboxOpsCount: outboxOps.length,
          checkpointState,
          maxCheckpointOps,
          maxOutboxOps,
        });
        const tooLarge = backupStateNow === 'too-large';
        const stalled = backupStateNow === 'stalled';

        publishBackupState(backupStateNow);

        if (shouldPublishCheckpoint({
          remoteCheckpoint: checkpoint
            ? { seq: checkpoint.seq, createdAt: checkpoint.createdAt, deviceIds: checkpoint.deviceIds }
            : null,
          checkpointState,
          selfDeviceId: deviceId,
          outboxOpCount: outboxOps.length,
          now: Date.now(),
        }) && !tooLarge) {
          // Never publish an information-free record — an empty checkpoint
          // carries nothing and can only destroy a real one.
          if (localOps.length === 0) return;
          // R2: max of what the relay served and what we have ever recorded.
          const seq = nextCheckpointSeq(checkpoint?.seq ?? null, persistedSeqRef.current);
          const deviceIds = mergeDeviceIds(checkpoint?.deviceIds ?? [], deviceId);
          const now = Date.now();
          const ok = await publishContactsV2Checkpoint({
            seq, deviceIds, ops: localOps, now, backend: publishingBackend, relayUrls: relays.write,
          });
          if (ok) {
            // Adopt what we just wrote as the checkpoint this device has seen,
            // so the next cycle's outbox is empty rather than a full replay.
            checkpointRef.current = {
              seq,
              createdAt: now,
              deviceIds,
              frontierOpIds: localOps.map((o: ContactOperation) => o.operationId),
              frontierMaxClock: localOps.reduce((max: number, o: ContactOperation) => Math.max(max, o.logicalClock), 0),
            };
            checkpointStateRef.current = 'present';
            persistedSeqRef.current = seq;
            // No `lastPublishedHashRef` reset here: the next cycle's outbox is
            // derived from `checkpointRef.current.frontierOpIds` above, which
            // now names every op just folded in, so `selectOutboxOps` already
            // returns `[]` and the outbox leg below short-circuits on the
            // length check before it ever consults the hash ref.
          }
          // A refused publish (`ok === false`) leaves `checkpointRef` and
          // `persistedSeqRef` exactly as they were — nothing above this
          // `if` mutates them, so a failed attempt is simply retried next
          // cycle with the same inputs.
          return;
        }

        // The outbox leg runs even when the checkpoint was refused: it only ever
        // ADDS operations under this device's own tag, so it is lossless
        // whatever state the checkpoint is in (R2).
        if (stalled) return;                  // no relay call — it would always be refused
        if (outboxOps.length === 0) return;   // information-free guard
        const hash = hashOps(outboxOps);
        if (hash === lastPublishedHashRef.current) return;
        const ok = await publishContactsV2Outbox({
          deviceId,
          ops: outboxOps,
          baseFrontierMaxClock: checkpoint?.frontierMaxClock ?? 0,
          backend: publishingBackend,
          relayUrls: relays.write,
        });
        if (ok) lastPublishedHashRef.current = hash;
      } catch {
        // Non-fatal — the next debounce cycle (another local mutation, or a
        // later fetch flipping `remoteState`) retries from scratch.
      } finally {
        inFlightRef.current = false;
        // Fix round 2, point 2: a cycle collided with this one while it was
        // running and got skipped above — re-arm exactly once, at the same
        // debounce delay, so whatever changed during the in-flight window
        // (a mutation, a fetch outcome) still gets published rather than
        // waiting on some unrelated later event to trigger it. `runCycle`
        // re-checks `inFlightRef` itself, so a further collision during
        // THIS re-armed run queues its own follow-up the same way.
        //
        // I1: only re-arm when this cycle is STILL current — a leftover
        // `pendingRef` flag from a stale (unmounted, or identity/unlock
        // moved on) cycle is simply dropped rather than scheduled: on a
        // genuine identity/unlock change, the NEW effect instance's own
        // fresh schedule already covers whatever changed; on true unmount,
        // there is nothing left to schedule for. A same-identity opsVersion
        // bump does NOT fail `stillCurrent()` — that is exactly the case
        // this re-arm exists for.
        if (pendingRef.current) {
          pendingRef.current = false;
          if (stillCurrent()) schedule(delay);
        }
      }
    };

    schedule(delay);

    return () => {
      // I1 residual: `clearTimeout` is unconditional — a collision re-arm
      // from an OLDER, already-cleaned-up closure's `finally` can overwrite
      // `publishTimerRef.current` with ITS OWN new handle after this
      // closure's timer was scheduled, leaving THIS closure's own
      // still-pending timer with nothing in the shared ref pointing at it.
      // Clearing `myTimerHandle` directly still cancels it regardless of
      // what the ref currently holds. Nulling the shared ref stays
      // conditional — never stomp on a DIFFERENT, still-live handle a later
      // re-arm has since installed there.
      if (myTimerHandle !== null) {
        clearTimeout(myTimerHandle);
        if (publishTimerRef.current === myTimerHandle) publishTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishEnabled, excludedKey, opsVersion, identity, npBackend, authorPubkey, deviceId, writeRelaysKey, encryptionKey, hydrated, remoteState, random, maxCheckpointOps, maxOutboxOps, publishDelayMs]);

  return { remoteState, backupState };
}
