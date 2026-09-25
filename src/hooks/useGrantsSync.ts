import { useSyncReadRetry } from './useSyncReadRetry';
import { guardedSigningBackend } from '../lib/guarded-signing-backend';
/**
 * Grants cross-device sync hook.
 *
 * Mirrors useContactsSync / useDependantsSync shape:
 *  - Fetch + merge on identity/backend/relay/key change
 *  - Debounced publish-on-change when any grant mutates
 *
 * Publishes the full grant set including tombstones so revocations
 * propagate under LWW. Local-only callers (`resolveApproval`,
 * `revokeGrant`) don't need to know about sync; the `grants` array
 * passed in triggers the publish effect.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RememberedGrant, SignetIdentity } from '../types';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import * as db from '../lib/db';
import {
  publishGrantsSync,
  fetchGrantsSync,
  mergeGrantLists,
  SYNC_D_TAG as GRANTS_SYNC_D_TAG,
} from '../lib/grants-sync';
import { createSyncDecryptCache } from '../lib/sync-decrypt-cache';
import { resolveHookRelays } from '../lib/sync-relays';
import { getSyncSeen, setSyncSeen, classifyFetchOutcome, type SyncRemoteState } from '../lib/sync-seen';

const PUBLISH_DEBOUNCE_MS = 2000;

/** Stable hash for publish idempotency — avoids re-emitting identical state. */
function hashGrants(grants: RememberedGrant[]): string {
  const sorted = [...grants].sort((a, b) => {
    const k = (g: RememberedGrant) => `${g.dependantId}|${g.scope}|${g.origin}`;
    return k(a).localeCompare(k(b));
  });
  return JSON.stringify(sorted);
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
   * Live view of all grants INCLUDING tombstones — the publisher needs
   * tombstones to ride along. Pass the result of
   * `listAllGrantsIncludingTombstones`, refreshed whenever a mutation
   * happens.
   */
  grants: RememberedGrant[] | null;
  /** Fires after an inbound fetch merges new/updated records locally. */
  onRemoteMerged?: () => void;
}

export function useGrantsSync({ publishEnabled = true,  identity, npBackend, relays, relayUrl, encryptionKey, grants, onRemoteMerged }: Options): { remoteState: SyncRemoteState | null } {
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
          dTag: GRANTS_SYNC_D_TAG,
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

  // Fetch + merge on unlock / identity change.
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

        const remote = await fetchGrantsSync(
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
            const seenBefore = !!(await getSyncSeen(authorPubkey, GRANTS_SYNC_D_TAG));
            if (cancelled) return;
            setRemoteState(classifyFetchOutcome({ found: false, reachableRelays: 1, seenBefore }));
          }
          return;
        }

        const local = await db.listAllGrantsIncludingTombstones();
        const { toSave } = mergeGrantLists(local, remote.grants);
        if (cancelled) return;

        for (const g of toSave) {
          await db.saveGrant(g);
        }
        if (cancelled) return;
        lastRemoteCreatedAtRef.current = remote.createdAt;
        await setSyncSeen(authorPubkey, GRANTS_SYNC_D_TAG, { eventId: remote.eventId, createdAt: remote.createdAt });
        if (cancelled) return;
        setRemoteState('present');

        // Seed last-published hash so we don't immediately republish what
        // we just pulled (family-bunker §11.1.10 addendum) — mirrors
        // useDependantsSync's "post-fetch reseed". Hash against the
        // current local set (post-merge), whether or not anything actually
        // changed, so the publish effect's next hash comparison is a
        // true no-op on an unchanged warm unlock.
        const currentLocal = await db.listAllGrantsIncludingTombstones();
        if (cancelled) return;
        lastPublishedHashRef.current = hashGrants(currentLocal);

        if (toSave.length > 0) {
          onRemoteMerged?.();
        }
      } finally {
        if (!cancelled) {
          hydratedAuthorRef.current = identity.naturalPerson.publicKey;
          setHydrated(true);
        }
      }
    })().catch(() => { /* non-fatal — next unlock retries */ });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readRetry,identity, npBackend, readRelaysKey, encryptionKey, decryptCache, onRemoteMerged]);

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
    if (!grants) return;

    let cancelled = false;
    const publishingBackend = guardedSigningBackend(npBackend, () => !cancelled);
    if (publishTimerRef.current) clearTimeout(publishTimerRef.current);
    publishTimerRef.current = setTimeout(async () => {
      publishTimerRef.current = null;
      try {
        const hash = hashGrants(grants);
        if (hash === lastPublishedHashRef.current) return;
        const ok = await publishGrantsSync(grants, publishingBackend, effectiveRelays.write);
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
  }, [publishEnabled, grants, identity, npBackend, writeRelaysKey, encryptionKey, hydrated, remoteState]);

  return { remoteState };
}
