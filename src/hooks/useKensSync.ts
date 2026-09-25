import { guardedSigningBackend } from '../lib/guarded-signing-backend';
/**
 * Ken cross-device sync (kindred integration).
 *
 * - Fetches the user's remote kens once on unlock, merges by LWW
 *   into the local IndexedDB store, and invokes `onRemoteMerged` so the
 *   caller can reload its derived state.
 * - Watches the local kens list and publishes a fresh NIP-44-encrypted
 *   kind-30078 event (d-tag `signet:kens`) to the user's relay on every
 *   change (debounced 1s). Uses a payload hash to dedupe — events echoed
 *   back from the relay don't cause a republish loop.
 * - Silent: no user-facing UI. Failures (relay down, decrypt mismatch)
 *   leave the local IDB as the authoritative copy and retry on the next
 *   mutation.
 * - The publish half is GATED, not removed. `publishEnabled` (default true) is
 *   passed `!contactsV2Verified` by App: the contacts v2 rail
 *   (`useContactsV2Sync`) becomes the single writer for both contacts and
 *   kens only once it has read back a checkpoint naming this device (ruling
 *   R10). The FETCH half stays unconditional and permanent so a restore still
 *   finds pre-v2 state for Phase B's import to lift.
 * - Ruling R12: this rail keeps its shape. Single `relayUrl`, its own
 *   `RelayClient`, no author pin, no `syncSeen`, no `remoteState`. It is on
 *   its way out; do not bring it onto the relay pool.
 *
 * Mirrors useContactsSync exactly — same wiring pattern, same echo-
 * avoidance, same sinceCreatedAt replay guard.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KenEntry } from '@forgesworn/kenspeckle';
import type { SignetIdentity } from '../types';
import * as db from '../lib/db';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import {
  publishKensSync,
  fetchKensSync,
  mergeKenLists,
  SYNC_D_TAG as KENS_SYNC_D_TAG,
} from '../lib/ken-sync';
import { createSyncDecryptCache } from '../lib/sync-decrypt-cache';
import { identityKeypairs } from '../lib/contacts-sync';

const PUBLISH_DEBOUNCE_MS = 1000;

/** Stable hash of a kens list for publish-idempotency checks. */
function hashKens(kens: KenEntry[]): string {
  // Normalise: sort by pubkey. JSON-stringify is deterministic for our
  // known schema. Good enough for dedupe — not a security primitive.
  const sorted = [...kens].sort((a, b) => a.pubkey.localeCompare(b.pubkey));
  return JSON.stringify(sorted);
}

interface Options {
  identity: SignetIdentity | null;
  /** Signing backend for the user's natural-person keypair. */
  npBackend: DecryptingSigningBackend | null;
  relayUrl: string;
  /**
   * Unlock key. Not required to sync (kens are re-encrypted per keypair on
   * save) — it's the at-rest key for the §11.1.10 decrypt cache, so an
   * unchanged remote event doesn't cost a device round-trip.
   */
  encryptionKey: string | null;
  /**
   * Current local kens — the hook publishes a fresh event (debounced 1s,
   * hash-deduped) whenever this array's content changes. Passing a stable
   * array reference is not required; we compare by stable hash.
   */
  kens?: KenEntry[];
  /**
   * Publish local changes to the legacy `signet:kens` tag. Default true.
   * App passes `!contactsV2Verified` — see the header note.
   */
  publishEnabled?: boolean;
  /** Called after remote kens are merged so the caller can reload state. */
  onRemoteMerged?: () => void;
}

export function useKensSync({ identity, npBackend, relayUrl, encryptionKey, kens, publishEnabled = true, onRemoteMerged }: Options) {
  // Encrypted per-rail decrypt cache (family-bunker §11.1.10). Post-migration
  // `nip44_decrypt` is a NIP-46 round-trip to the signing device; an unchanged
  // replaceable sync event can be served from the last decryption instead.
  // Memoised so the PBKDF2 derivation happens once per unlock, not per fetch.
  const decryptCache = useMemo(
    () => (identity?.naturalPerson.publicKey && encryptionKey)
      ? createSyncDecryptCache({
          dTag: KENS_SYNC_D_TAG,
          authorPubkey: identity.naturalPerson.publicKey,
          encryptionKey,
        })
      : undefined,
    [identity?.naturalPerson.publicKey, encryptionKey],
  );

  // Track the last payload hash we published, so echo-back from the relay
  // during an active subscription doesn't retrigger publishing.
  const lastPublishedHashRef = useRef<string>('');
  // Track the last remote event's created_at for rollback/replay protection
  // (a relay can't serve us a strictly-older version than we've already applied).
  const lastRemoteCreatedAtRef = useRef<number>(0);
  // Debounce handle.
  const publishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // M7 (2026-07-02 audit): gate the publish effect on the fetch-and-merge
  // effect below having resolved at least once for the current tuple —
  // see useContactsSync for the full rationale (fresh-device data-loss race).
  const [hydrated, setHydrated] = useState(false);

  // Fetch-and-merge on unlock. Runs once per (identity, backend, relayUrl) tuple.
  useEffect(() => {
    if (!identity || !npBackend || !relayUrl) return;

    let cancelled = false;
    setHydrated(false); // new sync target — re-gate publish until this run completes

    (async () => {
      try {
        const authorPubkey = identity.naturalPerson.publicKey;
        if (!authorPubkey) return;

        const remote = await fetchKensSync(
          authorPubkey,
          npBackend,
          relayUrl,
          lastRemoteCreatedAtRef.current || undefined,
          decryptCache,
        );
        if (cancelled || !remote) return;

        // Load all local kens across every keypair on the identity.
        const ownerPubkeys = identityKeypairs(identity);
        const localByOwner = await Promise.all(
          ownerPubkeys.map(pk => db.getKens(pk)),
        );
        const local = localByOwner.flat();

        const { toSave } = mergeKenLists(local, remote.kens);
        if (cancelled) return;
        for (const k of toSave) {
          await db.saveKen(k);
        }
        lastRemoteCreatedAtRef.current = remote.createdAt;

        // Seed the last-published hash with the merged state so we don't
        // immediately republish what we just fetched.
        const merged = mergeKenLists(local, remote.kens).merged;
        lastPublishedHashRef.current = hashKens(merged);

        if (toSave.length > 0) onRemoteMerged?.();
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })().catch(() => { /* non-fatal — next unlock retries */ });

    return () => { cancelled = true; };
  }, [identity, npBackend, relayUrl, decryptCache, onRemoteMerged]);

  // Publish on `kens` change, debounced. Seeded ref ensures the
  // fetch-and-merge useEffect doesn't cause a round-trip publish of
  // what we just pulled. Gated on `hydrated` (M7) — see above.
  useEffect(() => {
    // R10: the v2 rail is the single writer once it has proved a round trip.
    if (!publishEnabled) return;
    if (!identity || !npBackend || !relayUrl) return;
    if (!hydrated) return;
    if (!kens) return;

    let cancelled = false;
    const publishingBackend = guardedSigningBackend(npBackend, () => !cancelled);
    if (publishTimerRef.current) clearTimeout(publishTimerRef.current);
    publishTimerRef.current = setTimeout(async () => {
      publishTimerRef.current = null;
      try {
      // Read the authoritative set from IDB (may differ from the scoped
      // `kens` prop — useKens loads only the primary keypair's kens, but we
      // sync across all keypairs via identityKeypairs below).
      const ownerPubkeys = identityKeypairs(identity);
      const localByOwner = await Promise.all(
        ownerPubkeys.map(pk => db.getKens(pk)),
      );
      const all = localByOwner.flat();
      const hash = hashKens(all);
      if (hash === lastPublishedHashRef.current) return; // no-op
      const ok = await publishKensSync(all, publishingBackend, relayUrl);
      if (ok) lastPublishedHashRef.current = hash;
      } catch { /* A cancelled or declined signature leaves the old backup intact. */ }
    }, PUBLISH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (publishTimerRef.current) {
        clearTimeout(publishTimerRef.current);
        publishTimerRef.current = null;
      }
    };
  }, [kens, identity, npBackend, relayUrl, hydrated, publishEnabled]);
}
