import { useSyncReadRetry } from './useSyncReadRetry';
import { guardedSigningBackend } from '../lib/guarded-signing-backend';
/**
 * Dependants sync hook, Phase 2.
 *
 * Mirrors useContactsSync's shape: fetch-and-merge on identity/backend/
 * relay/key change, plus debounced publish-on-change. Diverges in how
 * it handles the payload — dependants go through `toSyncWire` /
 * `fromSyncWire` which strip/re-derive private keys so nothing
 * sensitive ever touches the relay.
 *
 * Fetching requires the **guardian mnemonic** on the receiving device:
 * view-only imports sync without it, but derived dependants need to
 * re-derive their NP + persona + extras from the same mnemonic that
 * created them. If mnemonic is unavailable (e.g. bunker mode), the
 * hook falls back to fetching only view-only dependants and skipping
 * the rest — UNLESS `deviceHeldKeys` is set (family-bunker §11.1.8):
 * a second guardian phone whose own family keys live on Heartwood has
 * no mnemonic either, but should still accept derived dependants —
 * keyless, from the wire's public keys, same as a stripped record.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DependantIdentity, SignetIdentity } from '../types';
import * as db from '../lib/db';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import {
  publishDependantsSync,
  fetchDependantsSync,
  toSyncWire,
  fromSyncWire,
  mergeDependantWithLocal,
  SYNC_D_TAG as DEPENDANTS_SYNC_D_TAG,
} from '../lib/dependants-sync';
import { createSyncDecryptCache } from '../lib/sync-decrypt-cache';
import { resolveHookRelays } from '../lib/sync-relays';
import { getSyncSeen, setSyncSeen, classifyFetchOutcome, type SyncRemoteState } from '../lib/sync-seen';

const PUBLISH_DEBOUNCE_MS = 1000;

/** Stable hash for publish idempotency. Uses wire-shape so we don't
 *  churn on benign at-rest changes (encryption wrapping, etc.). */
function hashDependants(deps: DependantIdentity[]): string {
  const wires = deps.map(toSyncWire).filter((w): w is NonNullable<typeof w> => w !== null);
  wires.sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(wires);
}

interface Options {
  /** False after a verified private-vault migration; legacy reads remain permanent. */
  publishEnabled?: boolean;
  identity: SignetIdentity | null;
  npBackend: DecryptingSigningBackend | null;
  /** Whole configured relay pool (see `sync-relays.ts`). Wins over `relayUrl` when present. */
  relays?: { read: string[]; write: string[] };
  /** @deprecated Use `relays`. Mapped to both read and write lists when `relays` is absent. */
  relayUrl?: string;
  encryptionKey: string | null;
  /**
   * Guardian's mnemonic (decrypted). Required to reconstitute derived
   * dependants on fetch. When absent, view-only imports still sync.
   */
  guardianMnemonic: string | null;
  /**
   * True when this phone's own family keys live on a Heartwood device
   * (no mnemonic on this device at all — family-bunker §11.1.8). Lets
   * a `derived` dependant sync in keyless, matching a stripped record,
   * instead of being skipped for want of a mnemonic to re-derive from.
   */
  deviceHeldKeys?: boolean;
  dependants?: DependantIdentity[];
  onRemoteMerged?: () => void;
}

export function useDependantsSync({ publishEnabled = true,  identity, npBackend, relays, relayUrl, encryptionKey, guardianMnemonic, deviceHeldKeys, dependants, onRemoteMerged }: Options): { remoteState: SyncRemoteState | null } {
  const effectiveRelays = resolveHookRelays(relays, relayUrl);
  const readRelaysKey = effectiveRelays.read.join('|');
  const writeRelaysKey = effectiveRelays.write.join('|');

  // Encrypted per-rail decrypt cache (family-bunker §11.1.10). Post-migration
  // `nip44_decrypt` is a NIP-46 round-trip to the signing device; an unchanged
  // replaceable sync event can be served from the last decryption instead.
  // Memoised so the PBKDF2 derivation happens once per unlock, not per fetch.
  const decryptCache = useMemo(
    () => (identity?.naturalPerson.publicKey && encryptionKey)
      ? createSyncDecryptCache({
          dTag: DEPENDANTS_SYNC_D_TAG,
          authorPubkey: identity.naturalPerson.publicKey,
          encryptionKey,
        })
      : undefined,
    [identity?.naturalPerson.publicKey, encryptionKey],
  );

  const syncAuthorRef = useRef<string | undefined>(undefined);
  const hydratedAuthorRef = useRef<string | null>(null);
  const lastPublishedHashRef = useRef<string>('');
  const lastRemoteCreatedAtRef = useRef<number>(0);
  const publishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // M7 (2026-07-02 audit): gate the publish effect on the fetch-and-merge
  // effect below having resolved at least once for the current tuple —
  // see useContactsSync for the full rationale (fresh-device data-loss race).
  const [hydrated, setHydrated] = useState(false);
  const [remoteState, setRemoteState] = useState<SyncRemoteState | null>(null);
  const readRetry = useSyncReadRetry(remoteState === 'unreachable');

  // Fetch + merge on unlock.
  useEffect(() => {
    const author = identity?.naturalPerson.publicKey;
    if (syncAuthorRef.current !== author) {
      syncAuthorRef.current = author;
      hydratedAuthorRef.current = null;
      lastRemoteCreatedAtRef.current = 0;
      lastPublishedHashRef.current = '';
      setRemoteState(null);
    }
    if (!identity || !npBackend || effectiveRelays.read.length === 0 || !encryptionKey) return;

    let cancelled = false;
    setHydrated(false); // new sync target — re-gate publish until this run completes

    (async () => {
      try {
        const authorPubkey = identity.naturalPerson.publicKey;
        if (!authorPubkey) return;

        const remote = await fetchDependantsSync(
          authorPubkey,
          npBackend,
          effectiveRelays.read,
          lastRemoteCreatedAtRef.current || undefined,
          decryptCache,
        );
        if (cancelled) return;

        if (remote === 'unreachable') {
          setRemoteState('unreachable');
          return;
        }
        if (remote === null) {
          // See usePersonasSync for the full rationale: a cursor-suppressed
          // "nothing newer" answer is still 'present', not a fresh
          // never-seen/missing-after-seen question.
          if (lastRemoteCreatedAtRef.current > 0) {
            setRemoteState('present');
          } else {
            const seenBefore = !!(await getSyncSeen(authorPubkey, DEPENDANTS_SYNC_D_TAG));
            if (cancelled) return;
            setRemoteState(classifyFetchOutcome({ found: false, reachableRelays: 1, seenBefore }));
          }
          return;
        }

        let savedAny = false;
        for (const wire of remote.dependants) {
          // Skip records that need the mnemonic when we don't have it.
          const needsMnemonic = wire.derivationPath.startsWith('dependant-');
          if (needsMnemonic && !guardianMnemonic && !deviceHeldKeys) continue;
          const reconstructed = fromSyncWire(wire, guardianMnemonic ?? '', { deviceHeldKeys });
          if (!reconstructed) continue;
          // LWW guard: keep local if it has a strictly newer createdAt.
          // This only catches the delete-then-recreate edge case — for the
          // common "local has fresh extras / bunker endpoint, remote is
          // pre-mutation" case createdAt is identical on both sides and the
          // guard is a no-op. The merge below is what protects local-only
          // fields and not-yet-published extras from being clobbered.
          const existing = await db.getDependants(reconstructed.guardianPubkey, encryptionKey);
          const localHit = existing.find(d => d.id === reconstructed.id);
          if (localHit && localHit.createdAt > reconstructed.createdAt) continue;
          const merged = mergeDependantWithLocal(reconstructed, localHit ?? null);
          await db.saveDependant(merged, encryptionKey);
          savedAny = true;
        }
        if (cancelled) return;
        lastRemoteCreatedAtRef.current = remote.createdAt;
        await setSyncSeen(authorPubkey, DEPENDANTS_SYNC_D_TAG, { eventId: remote.eventId, createdAt: remote.createdAt });
        if (cancelled) return;
        setRemoteState('present');

        // Seed last-published hash so we don't immediately republish what
        // we just pulled. Hash against the current local set (post-merge).
        const merged = await db.getDependants(identity.naturalPerson.publicKey, encryptionKey);
        lastPublishedHashRef.current = hashDependants(merged);

        if (savedAny) onRemoteMerged?.();
      } finally {
        if (!cancelled) {
          hydratedAuthorRef.current = identity.naturalPerson.publicKey;
          setHydrated(true);
        }
      }
    })().catch(() => { /* non-fatal — next unlock retries */ });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readRetry,identity, npBackend, readRelaysKey, encryptionKey, decryptCache, guardianMnemonic, deviceHeldKeys, onRemoteMerged]);

  // Debounced publish-on-change. Gated on `hydrated` (M7) — see above.
  useEffect(() => {
    if (!publishEnabled) return;
    if (!identity || !npBackend || effectiveRelays.write.length === 0 || !encryptionKey) return;
    if (!hydrated || hydratedAuthorRef.current !== identity.naturalPerson.publicKey) return;
    // Don't publish over a relay pool we just failed to reach — see
    // usePersonasSync for the full rationale. `remoteState` is in this
    // effect's deps, so the moment a later fetch succeeds the publish
    // effect re-evaluates and resumes normally.
    if (remoteState === 'unreachable') return;
    if (!dependants) return;

    let cancelled = false;
    const publishingBackend = guardedSigningBackend(npBackend, () => !cancelled);
    if (publishTimerRef.current) clearTimeout(publishTimerRef.current);
    publishTimerRef.current = setTimeout(async () => {
      publishTimerRef.current = null;
      try {
        const hash = hashDependants(dependants);
        if (hash === lastPublishedHashRef.current) return;
        const ok = await publishDependantsSync(dependants, publishingBackend, effectiveRelays.write);
        if (ok && syncAuthorRef.current === identity.naturalPerson.publicKey) lastPublishedHashRef.current = hash;
      } catch {
        // I2: a rejecting signEvent/nip44Encrypt must not escape a bare
        // setTimeout callback as an unhandled rejection — the next
        // debounce cycle retries from scratch.
      }
    }, PUBLISH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (publishTimerRef.current) {
        clearTimeout(publishTimerRef.current);
        publishTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishEnabled, dependants, identity, npBackend, writeRelaysKey, encryptionKey, hydrated, remoteState]);

  return { remoteState };
}
