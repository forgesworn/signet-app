import { useSyncReadRetry } from './useSyncReadRetry';
import { guardedSigningBackend } from '../lib/guarded-signing-backend';
/**
 * Credentials sync hook, Phase 3.
 *
 * Same shape as useContactsSync and useDependantsSync: fetch-and-merge
 * on identity/backend/relay/key change, debounced publish on credential
 * list change. Publishes the full `StoredCredential[]` — including the
 * private `merkleLeaves` — via NIP-44 encrypted kind 30078 so selective
 * disclosure keeps working on receiving devices.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SignetIdentity, StoredCredential } from '../types';
import * as db from '../lib/db';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import {
  publishCredentialsSync,
  fetchCredentialsSync,
  mergeCredentialLists,
  SYNC_D_TAG as CREDENTIALS_SYNC_D_TAG,
} from '../lib/credentials-sync';
import { createSyncDecryptCache } from '../lib/sync-decrypt-cache';
import { resolveHookRelays } from '../lib/sync-relays';
import { getSyncSeen, setSyncSeen, classifyFetchOutcome, type SyncRemoteState } from '../lib/sync-seen';

const PUBLISH_DEBOUNCE_MS = 1000;

function hashCredentials(credentials: StoredCredential[]): string {
  const sorted = [...credentials].sort((a, b) => a.id.localeCompare(b.id));
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
  credentials?: StoredCredential[];
  onRemoteMerged?: () => void;
}

export function useCredentialsSync({ publishEnabled = true,  identity, npBackend, relays, relayUrl, encryptionKey, credentials, onRemoteMerged }: Options): { remoteState: SyncRemoteState | null } {
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
          dTag: CREDENTIALS_SYNC_D_TAG,
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

        const remote = await fetchCredentialsSync(
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
            const seenBefore = !!(await getSyncSeen(authorPubkey, CREDENTIALS_SYNC_D_TAG));
            if (cancelled) return;
            setRemoteState(classifyFetchOutcome({ found: false, reachableRelays: 1, seenBefore }));
          }
          return;
        }

        const local = await db.getAllCredentials(encryptionKey);
        const { toSave } = mergeCredentialLists(local, remote.credentials);
        if (cancelled) return;
        for (const c of toSave) {
          await db.saveCredential(c, encryptionKey);
        }
        if (cancelled) return;
        lastRemoteCreatedAtRef.current = remote.createdAt;
        await setSyncSeen(authorPubkey, CREDENTIALS_SYNC_D_TAG, { eventId: remote.eventId, createdAt: remote.createdAt });
        if (cancelled) return;
        setRemoteState('present');

        // Seed the last-published hash post-merge so we don't echo-publish.
        const merged = mergeCredentialLists(local, remote.credentials).merged;
        lastPublishedHashRef.current = hashCredentials(merged);

        if (toSave.length > 0) onRemoteMerged?.();
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

  // Debounced publish on mutation. Gated on `hydrated` (M7) — see above.
  useEffect(() => {
    if (!publishEnabled) return;
    if (!identity || !npBackend || effectiveRelays.write.length === 0 || !encryptionKey) return;
    if (!hydrated || hydratedAuthorRef.current !== identity.naturalPerson.publicKey) return;
    // Don't publish over a relay pool we just failed to reach — see
    // usePersonasSync for the full rationale. `remoteState` is in this
    // effect's deps, so the moment a later fetch succeeds the publish
    // effect re-evaluates and resumes normally.
    if (remoteState === 'unreachable') return;
    if (!credentials) return;

    let cancelled = false;
    const publishingBackend = guardedSigningBackend(npBackend, () => !cancelled);
    if (publishTimerRef.current) clearTimeout(publishTimerRef.current);
    publishTimerRef.current = setTimeout(async () => {
      publishTimerRef.current = null;
      try {
        const hash = hashCredentials(credentials);
        if (hash === lastPublishedHashRef.current) return;
        const ok = await publishCredentialsSync(credentials, publishingBackend, effectiveRelays.write);
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
  }, [publishEnabled, credentials, identity, npBackend, writeRelaysKey, encryptionKey, hydrated, remoteState]);

  return { remoteState };
}
