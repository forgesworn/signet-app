/**
 * Child-side dependant-status subscriber + cache.
 *
 * Runs only in `paired-child` signingMode. Loads the PairedChildRecord,
 * extracts the endpoint pubkey from the stored bunker URI, builds a
 * LocalSigningBackend over the child's transport private key, fetches
 * the guardian-published NIP-44-encrypted status event, decrypts it,
 * and caches the result in IDB so the home surface can render dormant
 * UX pre-emptively.
 *
 * On cache miss (never synced, decrypt failure, unknown stage token)
 * callers default to dormant per the OQ1-139 conservative consensus —
 * the child UI gates before hitting the bunker. An unreachable relay
 * means the last-known-stage renders; a never-synced device renders
 * dormant until the next online fetch.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AutonomyStage, DependantStatusRecord, PairedChildRecord } from '../types';
import { LocalSigningBackend } from '../lib/signing-backend';
import {
  extractEndpointPubkey,
  fetchDependantStatus,
} from '../lib/dependant-status-sync';
import * as db from '../lib/db';

interface Options {
  relayUrl: string;
  encryptionKey: string | null;
  /**
   * Which dependant pairing on this device is currently active. After multi-pairing support,
   * a shared family iPad can hold multiple pairings keyed by dependant
   * pubkey; this field selects the one the status hook subscribes to.
   */
  dependantPubkey: string | null;
  /**
   * True when the hook should run. Callers gate on
   * `preferences.signingMode === 'paired-child'`.
   */
  enabled: boolean;
}

interface Result {
  /** Cached status — undefined while loading, null when never synced. */
  status: DependantStatusRecord | null | undefined;
  /**
   * Convenience flag — dormant whenever the cache says full-control,
   * or there's no cache yet (conservative default).
   */
  isDormant: boolean;
  /** Display name of the guardian, when known. Surfaces in dormant copy. */
  guardianName?: string;
  /** Manual re-fetch; useful after a background resume. */
  refresh: () => Promise<void>;
}

const DORMANT_STAGES: AutonomyStage[] = ['full-control'];

export function useDependantStatus({ relayUrl, encryptionKey, dependantPubkey, enabled }: Options): Result {
  const [status, setStatus] = useState<DependantStatusRecord | null | undefined>(undefined);
  const recordRef = useRef<PairedChildRecord | null>(null);
  const backendRef = useRef<LocalSigningBackend | null>(null);
  // M10 (2026-07-02 audit): always holds the CURRENTLY active dependant
  // pubkey, kept fresh on every render (no effect needed — a plain
  // synchronous assignment during render is safe for a ref). runFetch
  // captures its target pubkey as a local at the start of each call and
  // compares against this ref after every await — if the active pairing
  // has switched by the time an in-flight step resolves (e.g. a slow
  // relay fetch for child A while the user has already switched to
  // child B), the stale result is dropped instead of being written into
  // the shared `status` state under the wrong child.
  const activeDependantRef = useRef(dependantPubkey);
  activeDependantRef.current = dependantPubkey;

  const runFetch = useCallback(async (): Promise<void> => {
    if (!enabled || !encryptionKey || !dependantPubkey) return;
    const targetPubkey = dependantPubkey;
    const isStale = () => activeDependantRef.current !== targetPubkey;

    // M10: the cache row is keyed by dependantPubkey — see db.ts.
    const cached = await db.loadPairedChildStatus(targetPubkey).catch(() => null);
    if (isStale()) return;
    setStatus(cached);

    // Load the PairedChildRecord lazily the first time we need the
    // transport private key. Cached in a ref so subsequent refreshes
    // don't re-decrypt. Keyed on the active dependant pubkey so a
    // multi-paired device picks the right row.
    if (!recordRef.current || recordRef.current.dependantPubkey !== targetPubkey) {
      const r = await db.loadPairedChild(targetPubkey, encryptionKey).catch(() => null);
      if (isStale()) return;
      if (!r) return;
      recordRef.current = r;
      backendRef.current?.destroy();
      backendRef.current = null;
    }
    const record = recordRef.current;

    if (!backendRef.current) {
      try {
        backendRef.current = new LocalSigningBackend(record.clientKeypair.privateKey);
      } catch {
        return;
      }
    }
    const backend = backendRef.current;

    const endpointPubkey = extractEndpointPubkey(record.bunkerUri);
    if (!endpointPubkey) return;

    const sinceCreatedAt = cached?.updatedAt ?? undefined;
    const remote = await fetchDependantStatus(endpointPubkey, backend, relayUrl, sinceCreatedAt);
    // The critical guard: this relay round-trip is the slow step, and the
    // active pairing may well have changed while it was in flight.
    if (isStale()) return;
    if (!remote) return;

    const next: Omit<DependantStatusRecord, 'id'> = {
      dependantPubkey: targetPubkey,
      stage: remote.payload.stage,
      updatedAt: remote.payload.updatedAt,
      lastSyncedAt: Date.now(),
      ...(remote.payload.guardianName ? { guardianName: remote.payload.guardianName } : {}),
    };
    await db.savePairedChildStatus(next);
    if (isStale()) return;
    setStatus({ id: targetPubkey, ...next });
  }, [enabled, encryptionKey, dependantPubkey, relayUrl]);

  // Tear down the backend + record ref when the active pairing changes.
  useEffect(() => {
    return () => {
      backendRef.current?.destroy();
      backendRef.current = null;
      recordRef.current = null;
    };
  }, [enabled, encryptionKey, dependantPubkey]);

  useEffect(() => {
    // M10: reset synchronously on every dependant switch too, not just on
    // disable — otherwise the PREVIOUS child's status stays on screen
    // (mis-attributed to the newly-active child) for the async gap before
    // runFetch below resolves with the new child's own cached/fresh value.
    setStatus(undefined);
    if (!enabled) return;
    runFetch().catch(() => { /* non-fatal */ });
  }, [enabled, dependantPubkey, runFetch]);

  const isDormant = !status || DORMANT_STAGES.includes(status.stage);

  return {
    status,
    isDormant,
    guardianName: status?.guardianName,
    refresh: runFetch,
  };
}
