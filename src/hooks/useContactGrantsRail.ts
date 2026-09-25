import { useSyncReadRetry } from './useSyncReadRetry';
import { guardedSigningBackend } from '../lib/guarded-signing-backend';
/**
 * The contacts-v2 grant registry's own rail (R-2).
 *
 * Deliberately NOT part of the contacts checkpoint: that payload is chunked
 * across numbered events behind a manifest, and a registry riding it would
 * lose every grant's rail private key — silently — whenever a chunk failed.
 * This is one sealed replaceable event, small by construction.
 *
 * Shape follows `useContactsV2Sync` / `usePersonasSync`: fetch on unlock,
 * merge, then a debounced jittered publish gated on `hydrated` AND on the
 * last fetch not having reported `'unreachable'`. Publishing over a pool
 * that just failed to answer a read cannot add anything and can destroy a
 * real registry.
 *
 * R-8: `enabled` is false on a paired-child install. The kid's device holds
 * no owner grants and must not publish under the owner's author tag.
 *
 * Codes against `contacts-v2-grants-rail.ts`'s fix round 1 (58bc447):
 * `publishGrantsV2` returns `GrantsPublishOutcome` (`'published' | 'empty' |
 * 'too-large' | 'failed'`), mapped below — `'published'` reseeds the
 * publish-dedupe hash and reports `backupState: 'ok'`; `'empty'` is a no-op
 * (should not occur in practice, since the publish cycle already refuses to
 * call `publishGrantsV2` at all with zero local grants, but is handled
 * defensively rather than assumed unreachable); `'too-large'` reports
 * `backupState: 'too-large'` (mirroring the contacts checkpoint rail's own
 * `'too-large'` `ContactsV2BackupState`) and leaves the hash unseeded so a
 * later shrink retries automatically; `'failed'` likewise leaves the hash
 * unseeded so the next debounce cycle retries. `fetchGrantsV2` reporting
 * `remoteState: 'present'` with `payload: null` (an event exists but could
 * not be opened/parsed, Phase D R9) is treated as "do not publish this
 * cycle", the same as `'unreachable'`, via `canPublishRef` rather than
 * overloading the UI-facing `remoteState` value itself; a fetch that DOES
 * yield a readable registry (`payload !== null`) resets `backupState` back
 * to `'ok'`, since a readable registry is evidence the rail is not
 * (currently) stuck too-large.
 */
import { useEffect, useRef, useState } from 'react';
import * as db from '../lib/db';
import {
  fetchGrantsV2, mergeGrantRegistry, isRegistryRicherThan, publishGrantsV2, toWireGrant,
} from '../lib/contacts-v2-grants-rail';
import type { WireGrantV2 } from '../lib/contacts-v2-grants-rail';
import { computePublishDelayMs } from '../lib/personas-sync';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import type { SyncRemoteState } from '../lib/sync-seen';
import type { AppGrantV2 } from '../types';

/** Mirrors `useContactsV2Sync`'s `ContactsV2BackupState`, narrowed to the
 *  two outcomes this rail's byte-fitting can actually produce: there is no
 *  `'stalled'` equivalent here (a single sealed replaceable event has no
 *  outbox leg that could be stalled independently of the whole registry). */
export type ContactGrantsRailBackupState = 'ok' | 'too-large';

export interface UseContactGrantsRailOptions {
  publishEnabled?: boolean;
  publishExcludedDirectories?: readonly string[];
  enabled: boolean;
  encryptionKey: string | null;
  backend: DecryptingSigningBackend | null;
  relays: { read: string[]; write: string[] };
  /** R-35: the grant SET version — bumped when a grant is approved, revoked,
   *  forgotten or adopted off the rail, NOT for an app-label or publish-state
   *  row write. It drives both the publish debounce and (B/I6) the fetch. */
  grantsVersion: number;
  onMerged?: () => void;
  /** Fired every time `backupState` is (re)computed — from the fetch effect
   *  as well as the publish cycle — mirroring `useContactsV2Sync`'s
   *  `onBackupStateChange`. */
  onBackupStateChange?: (state: ContactGrantsRailBackupState) => void;
  /**
   * MUST be referentially stable (a module constant, or memoised by the
   * caller). It sits in the publish effect's dependency list BY REFERENCE, so
   * a fresh arrow literal on every render tears down and re-arms the debounce
   * timer on every render — including the renders this hook's own state
   * updates cause — and the publish never fires.
   *
   * The same is true of `relays`: its two arrays are read through joined
   * string keys rather than by reference, so a fresh object literal is safe
   * there, but the ARRAY CONTENTS must be stable for the publish to settle.
   */
  random?: () => number;
  /** Test-only: overrides the real 6–91 s jittered delay. */
  publishDelayMs?: number;
}

/**
 * Recursively sort object keys (and drop `undefined`-valued ones, matching
 * `JSON.stringify`'s own behaviour for plain objects) so two records that
 * are logically identical but were built via different code paths — a
 * fresh decrypt off `db.ts` always carries every optional key, explicitly
 * `undefined`, while a freshly merged record omits an absent optional key
 * entirely — still compare equal. Arrays keep their own element order.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashWireGrants(grants: WireGrantV2[]): string {
  return stableStringify([...grants].sort((a, b) => a.grantId.localeCompare(b.grantId)));
}

/** Same hash space as `hashWireGrants` — hashing the WIRE shape (not the
 *  full local record) is what lets device-local churn (a bumped
 *  `seenOperationIds`, a fresh `lastProjectionHash`) NOT force a republish. */
function hashAppGrantsAsWire(grants: AppGrantV2[]): string {
  return hashWireGrants(grants.map(toWireGrant));
}

/**
 * R-22/item 3: overlay a merged record's WIRE fields onto the row as it
 * stands in storage right now, keeping every device-local field
 * (`seenOperationIds`, `lastProjectionHash`, `lastProjectionAt`,
 * `lastPublishState`) from `current` rather than from the merge input, which
 * may be seconds stale by the time the write actually runs.
 *
 * `grantId` and `createdAt` come from `current` too: they are immutable key
 * material, not something a remote payload gets to restate. `revokedAt` is
 * written only when the merge produced one — a local revocation that landed
 * while the fetch was in flight is preserved by the spread and never
 * un-revoked, which matches the rail's own monotonic-revocation rule.
 */
function withWireFields(current: AppGrantV2, merged: AppGrantV2): AppGrantV2 {
  return {
    ...current,
    directoryId: merged.directoryId,
    appPubkey: merged.appPubkey,
    updatedAt: merged.updatedAt,
    appName: merged.appName,
    capabilities: merged.capabilities,
    railPubkey: merged.railPubkey,
    railPrivateKey: merged.railPrivateKey,
    relay: merged.relay,
    maxStalenessSeconds: merged.maxStalenessSeconds,
    appLabels: merged.appLabels,
    ...(merged.revokedAt !== undefined ? { revokedAt: merged.revokedAt } : {}),
  };
}

export function useContactGrantsRail({
  publishEnabled = true, publishExcludedDirectories = [],
  enabled,
  encryptionKey,
  backend,
  relays,
  grantsVersion,
  onMerged,
  onBackupStateChange,
  random,
  publishDelayMs,
}: UseContactGrantsRailOptions): {
  remoteState: SyncRemoteState | null;
  hydrated: boolean;
  backupState: ContactGrantsRailBackupState;
  skippedRemote: number;
} {
  const excludedKey = [...publishExcludedDirectories].sort().join('|');
  const authorPubkey = enabled && backend ? backend.activePublicKeyHex : null;

  const [remoteState, setRemoteState] = useState<SyncRemoteState | null>(null);
  const readRetry = useSyncReadRetry(remoteState === 'unreachable');
  const [hydrated, setHydrated] = useState(false);
  const [backupState, setBackupState] = useState<ContactGrantsRailBackupState>('ok');
  // R-26: how many grants connected on ANOTHER device could not be adopted
  // here because this one is already at `CONTACT_GRANT_V2_CAP` active grants.
  // Surfaced so App can say so (`GRANTS_SKIPPED_REMOTE_COPY`, Task 22) rather
  // than leaving an app the owner connected elsewhere quietly absent.
  const [skippedRemote, setSkippedRemote] = useState(0);

  const onMergedRef = useRef(onMerged);
  onMergedRef.current = onMerged;
  const onBackupStateChangeRef = useRef(onBackupStateChange);
  onBackupStateChangeRef.current = onBackupStateChange;
  // The one place `backupState` is ever written — keeps the React state and
  // the change notification from being able to drift apart.
  const publishBackupState = (state: ContactGrantsRailBackupState) => {
    setBackupState(state);
    onBackupStateChangeRef.current?.(state);
  };

  // True unmount only — distinct from every dependency-driven re-run of the
  // publish effect (a `grantsVersion` bump re-runs that effect constantly
  // and must not be mistaken for the hook itself going away).
  const mountedRef = useRef(true);
  // "The same identity, still unlocked with the same key" — resets the
  // publish-dedupe hash on a genuine identity/unlock change, but NOT on a
  // mere relay-list edit (which also re-runs the fetch effect).
  const identityGenerationRef = useRef<string | null>(null);
  // The publish effect's OWN identity/unlock fingerprint, updated
  // unconditionally on every run of that effect (including back to `null`
  // on a lock) so an in-flight cycle scheduled under a previous identity can
  // tell it has been superseded.
  const publishIdentityRef = useRef<string | null>(null);
  // Guards two publish cycles from ever running concurrently against the
  // same mutable refs; a collision re-arms once more rather than being
  // dropped silently.
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const publishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPublishedHashRef = useRef<string>('');
  // Set at the end of every fetch attempt. False for `'unreachable'` and for
  // the "an event exists but could not be opened" combination
  // (`remoteState === 'present'` with `payload === null`) — both are states
  // in which publishing could only clobber a real registry we failed to
  // read, not states the UI-facing `remoteState` alone can distinguish from
  // "nothing there yet".
  const canPublishRef = useRef(false);

  const readRelaysKey = relays.read.join('|');
  const writeRelaysKey = relays.write.join('|');

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Fetch + merge on unlock / identity / relay change, and — B/I6 — whenever
  // the grant SET changes.
  //
  // `skippedRemote` is only ever recomputed by this effect, and
  // `GRANTS_SKIPPED_REMOTE_COPY` tells the owner to "disconnect one here to
  // make room for them". Without the set version in these dependencies,
  // disconnecting did neither: the skipped grants were not adopted and the
  // banner went on naming a count whose evidence was stale until the next
  // unlock or relay edit. R-35 is what makes this affordable — `grantsVersion`
  // is now the SET version, so it moves on approve/revoke/forget/adopt and no
  // longer on every app-label or publish-state row write. A merge that changed
  // something re-runs this once more and then converges, because the second
  // pass finds the rows already equal and reports no change.
  useEffect(() => {
    if (!enabled || !backend || !encryptionKey || !authorPubkey) return;

    // A genuinely new identity/unlock must not inherit the previous one's
    // publish-dedupe state. Computed and applied before the
    // `relays.read.length === 0` bail below, mirroring `useContactsV2Sync`.
    const identityGeneration = `${authorPubkey}:${encryptionKey}`;
    if (identityGenerationRef.current !== identityGeneration) {
      identityGenerationRef.current = identityGeneration;
      lastPublishedHashRef.current = '';
      canPublishRef.current = false;
      setSkippedRemote(0);
      setHydrated(false);
    }

    if (relays.read.length === 0) return;

    let cancelled = false;
    setHydrated(false); // new sync target — re-gate publish until this run completes

    (async () => {
      try {
        const { payload, remoteState: fetchedState } = await fetchGrantsV2({
          authorPubkey,
          backend,
          relayUrls: relays.read,
        });
        if (cancelled) return;
        setRemoteState(fetchedState);

        // See the module header / DEFERRED note: a `'present'` state with no
        // payload means the event exists but could not be opened — publish
        // must be gated off for this cycle exactly as for `'unreachable'`.
        const unreadableExisting = fetchedState === 'present' && payload === null;
        canPublishRef.current = fetchedState !== 'unreachable' && !unreadableExisting;

        // Fix round 1, minor 4: `skippedRemote` describes what THIS fetch's
        // payload could not be adopted from. A fetch that produced no payload
        // at all — unreachable, never-seen, or an event that could not be
        // opened — has nothing to report, so a count left over from an earlier
        // fetch would go on claiming "2 apps from another device could not be
        // added" long after the evidence for it stopped arriving, and would
        // never clear on its own once the relay went quiet.
        if (!payload) setSkippedRemote(0);

        if (payload) {
          // A readable registry is evidence the rail is not (currently)
          // stuck too-large — clears a stale `'too-large'` from a prior
          // cycle without waiting for the next debounced publish, which may
          // be seconds away or gated off entirely.
          publishBackupState('ok');

          const local = await db.listContactGrantsV2(encryptionKey);
          if (cancelled) return;

          const localById = new Map(local.map((g) => [g.grantId, g] as const));
          const { grants: merged, skippedRemote: skippedByCap } = mergeGrantRegistry(local, payload.grants);

          let changed = false;
          // R-26: the merge already refuses to adopt past the cap, so
          // `saveContactGrantV2`'s own cap throw should now be unreachable on
          // this path. "Should be" is not "is" — if it ever fires it is
          // counted with the merge's own refusals rather than swallowed, and
          // the rest of the merge still applies.
          let capThrew = 0;
          for (const g of merged) {
            const existing = localById.get(g.grantId);
            if (existing && stableStringify(existing) === stableStringify(g)) continue;
            if (cancelled) return;
            try {
              if (existing) {
                // R-22/item 3: an EXISTING row is updated through `db.ts`'s
                // serialised writer, writing only the wire fields plus
                // `revokedAt` and preserving every device-local field from
                // the row as it stands at write time — a projection publish
                // or a proposal batch that landed while this fetch was in
                // flight is not clobbered. `revokedAt` is written only when
                // the merge produced one, so a local revocation that arrived
                // mid-fetch is never un-revoked. The merge never deletes.
                // B/M1: `wrote` is set INSIDE the mutate, not inferred from
                // the outer `stableStringify` comparison. That outer compare
                // is against the row as the LIST read it, which may be
                // seconds stale; the mutate sees the row as it stands at
                // write time and can decline. `updateContactGrantV2` hands
                // back the current row either way, so without this flag a
                // merge that wrote nothing still fired `onMerged` → a full
                // proposal-inbox teardown and re-fetch. Same pattern
                // `useContactProjections` already uses for its own writes.
                let wrote = false;
                const applied = await db.updateContactGrantV2(g.grantId, encryptionKey, (current) => {
                  const next = withWireFields(current, g);
                  if (stableStringify(next) === stableStringify(current)) return null;
                  wrote = true;
                  return next;
                });
                if (applied === null) {
                  // The row went away between the list and the write (a
                  // forget, R-13). Re-creating it would resurrect something
                  // the owner deliberately dropped, so it is left alone.
                  continue;
                }
                if (wrote) changed = true;
              } else {
                await db.saveContactGrantV2(g, encryptionKey);
                changed = true;
              }
            } catch (err) {
              // Fix round 1, minor 3: the TYPED cap error, not a regex over
              // prose. Matching on the message meant a future reword would
              // silently stop counting rather than fail a test — the exact
              // failure mode `skippedRemote` exists to prevent.
              if (db.isGrantCapError(err)) capThrew += 1;
              // Any other local failure — skip this row; the rest applies.
            }
            if (cancelled) return;
          }

          if (!cancelled) setSkippedRemote(skippedByCap + capThrew);
          if (!cancelled && changed) onMergedRef.current?.();

          // R-25: reseed the publish-dedupe hash UNLESS the merged registry is
          // strictly RICHER than the remote one. A merged registry is
          // routinely DIFFERENT without being richer — a remote-only revoked
          // row is never adopted (R-21), and a remote-only active row can be
          // turned away at the cap (R-26) — and the old plain-inequality test
          // republished in exactly those cases, overwriting the relay's
          // richer record with this device's poorer one, once per app start.
          // Only something this device HAS and the relay lacks earns a
          // republish.
          if (!cancelled && !isRegistryRicherThan(merged, payload.grants)) {
            lastPublishedHashRef.current = hashAppGrantsAsWire(merged);
          }
        }
      } catch {
        // A thrown fetch is the state in which we know least about the
        // relay — gate publishing off, same as an explicit 'unreachable'.
        if (!cancelled) {
          setRemoteState('unreachable');
          canPublishRef.current = false;
        }
      } finally {
        // Hydrated even on failure: blocking the publish gate for the rest
        // of the session would strand this device's local-only grants. The
        // gate above is what actually holds publishing back, and it lifts
        // the moment a later fetch succeeds.
        if (!cancelled) setHydrated(true);
      }
    })().catch(() => { /* non-fatal — next unlock retries */ });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readRetry,enabled, backend, authorPubkey, encryptionKey, readRelaysKey, grantsVersion]);

  // Debounced, jittered publish. Gated on `hydrated` AND on the last fetch
  // being usable (`canPublishRef`) — publishing over a pool that just
  // failed to answer a read, or over an event we could not open, can only
  // destroy a real registry.
  useEffect(() => {
    // Updated UNCONDITIONALLY, before the guard below — this is what lets a
    // lock (which zeroes `encryptionKey`/`backend`, failing the guard and
    // short-circuiting the rest of this effect) still be visible to an
    // in-flight cycle scheduled under a PREVIOUS identity.
    const currentPublishIdentity = (enabled && backend && encryptionKey && authorPubkey)
      ? `${authorPubkey}:${encryptionKey}:${publishEnabled}:${excludedKey}`
      : null;
    publishIdentityRef.current = currentPublishIdentity;
    if (!publishEnabled) return;

    if (!enabled || !backend || !encryptionKey || !authorPubkey) return;
    if (relays.write.length === 0) return;
    if (!hydrated) return;
    if (remoteState === 'unreachable') return;
    if (!canPublishRef.current) return;

    const delay = publishDelayMs ?? computePublishDelayMs(random ?? Math.random);
    const generationAtSchedule = currentPublishIdentity;
    // The timer handle THIS effect instance scheduled — tracked locally so
    // cleanup and the collision re-arm below only ever clear/replace a
    // timer this closure actually owns.
    let myTimerHandle: ReturnType<typeof setTimeout> | null = null;
    // Item 10: set by this effect's own cleanup. The `pendingRef` re-arm in
    // `finally` below can run AFTER the cleanup has already executed (the
    // cycle it belongs to was still awaiting a relay call when a dependency
    // changed or the hook unmounted), and a timer armed at that point would
    // never be cleared by anyone — the cleanup that owned it has been and
    // gone. Refusing to arm once disposed is what keeps every timer this
    // effect creates owned by the cleanup that can cancel it.
    let disposed = false;
    const schedule = (ms: number) => {
      if (disposed) return;
      myTimerHandle = setTimeout(runCycle, ms);
      publishTimerRef.current = myTimerHandle;
    };
    const stillCurrent = () => mountedRef.current && publishIdentityRef.current === generationAtSchedule;
    const publishingBackend = guardedSigningBackend(backend, stillCurrent);

    const runCycle = async () => {
      if (!stillCurrent()) return;
      if (publishTimerRef.current === myTimerHandle) publishTimerRef.current = null;
      // A fresh debounce timer can fire while a PREVIOUS invocation is still
      // awaiting a relay call. Skip rather than run two publish cycles
      // concurrently — flag that a follow-up is owed instead of dropping it.
      if (inFlightRef.current) {
        pendingRef.current = true;
        return;
      }
      inFlightRef.current = true;
      try {
        const grants = (await db.listContactGrantsV2(encryptionKey)).filter(grant => !publishExcludedDirectories.includes(grant.directoryId));
        if (!stillCurrent()) return;
        // Never publish an information-free registry — zero grants carries
        // nothing and can only destroy a real one.
        if (grants.length === 0) return;
        const hash = hashAppGrantsAsWire(grants);
        if (hash === lastPublishedHashRef.current) return;
        // SECONDS, not milliseconds (item 10). `publishGrantsV2`'s `now` seeds
        // both `GrantsRailPayload.createdAt` and the event's own NIP-01
        // `created_at`; a millisecond value is rejected by the rail's
        // `normaliseNow` and silently replaced, which works but hides the
        // caller bug. Passing the right unit means the stamp is the one this
        // cycle actually intended.
        const outcome = await publishGrantsV2({
          grants, now: Math.floor(Date.now() / 1000), backend: publishingBackend, relayUrls: relays.write,
        });
        if (!stillCurrent()) return;
        switch (outcome) {
          case 'published':
            lastPublishedHashRef.current = hash;
            publishBackupState('ok');
            break;
          case 'too-large':
            // Leave the hash unseeded — a later shrink (a revocation aging
            // out, a label trimmed) changes what `hashAppGrantsAsWire`
            // produces and the next debounce cycle retries automatically.
            publishBackupState('too-large');
            break;
          case 'empty':
          case 'failed':
            // 'empty' should not occur here (the length-0 guard above
            // already refuses to call `publishGrantsV2` at all), handled
            // defensively rather than assumed unreachable. 'failed' leaves
            // the hash unseeded so the next cycle retries. Neither is a
            // registry-size problem, so `backupState` is untouched.
            break;
          default:
            break;
        }
      } catch {
        // Non-fatal — the next debounce cycle (another local mutation, or a
        // later fetch flipping the gate) retries from scratch.
      } finally {
        inFlightRef.current = false;
        // A cycle collided with this one while it was running and got
        // skipped above — re-arm exactly once, at the same debounce delay,
        // so whatever changed during the in-flight window still gets
        // published rather than waiting on some unrelated later event.
        //
        // Item 10: only THIS effect's own cleanup can cancel a timer this
        // closure arms, so once disposed it arms nothing — and deliberately
        // leaves `pendingRef` set rather than consuming it, so the request
        // stays owed to whichever effect invocation is current instead of
        // being quietly eaten by a closure that can no longer serve it.
        if (pendingRef.current && !disposed) {
          pendingRef.current = false;
          if (stillCurrent()) schedule(delay);
        }
      }
    };

    schedule(delay);

    return () => {
      disposed = true;
      if (myTimerHandle !== null) {
        clearTimeout(myTimerHandle);
        if (publishTimerRef.current === myTimerHandle) publishTimerRef.current = null;
        myTimerHandle = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishEnabled, excludedKey, grantsVersion, enabled, backend, authorPubkey, encryptionKey, writeRelaysKey, hydrated, remoteState, random, publishDelayMs]);

  return { remoteState, hydrated, backupState, skippedRemote };
}
