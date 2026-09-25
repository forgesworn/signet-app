import { guardedSigningBackend } from '../lib/guarded-signing-backend';
import { useSyncReadRetry } from './useSyncReadRetry';
/**
 * Contacts-sync hook, Phase 1.
 *
 * - Fetches the user's remote contacts once on unlock, merges by LWW
 *   into the local IndexedDB store, and invokes `onRemoteMerged` so the
 *   caller can reload its derived state.
 * - Watches the local contacts list and publishes a fresh NIP-44-
 *   encrypted kind-30078 event to the user's relay pool on every change
 *   (debounced 1s). Uses a payload hash to dedupe — events echoed back
 *   from the relay don't cause a republish loop.
 * - The publish half is GATED, not removed. `publishEnabled` (default true)
 *   is passed `!contactsV2Verified` by App: the contacts v2 rail
 *   (`useContactsV2Sync`) becomes the single writer only once it has read
 *   back a checkpoint naming this device, which is the cheap stand-in for the
 *   spec's `v2-canonical` publish/fetch-back/verify ceremony (ruling R10).
 *   The FETCH half stays unconditional and permanent: a user who never opened
 *   the new build and then restores from words has empty v2 tags and their
 *   real state on the legacy tag, which Phase B's import lifts.
 * - Silent: no user-facing UI. Failures (relay down, decrypt mismatch)
 *   leave the local IDB as the authoritative copy and retry on the
 *   next mutation.
 *
 * Extended (task 5, persona-sync-rail follow-on) to fan out over the
 * whole configured relay pool (`relays.read` / `relays.write`, see
 * `sync-relays.ts`) rather than a single relay, and to surface a
 * `remoteState` the UI can render (present / never-seen /
 * missing-after-seen / unreachable — see `sync-seen.ts`), same posture
 * as `usePersonasSync`. `relayUrl` is kept as a deprecated single-relay
 * alias, mapped to both lists when `relays` is absent.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Contact, SignetIdentity } from '../types';
import * as db from '../lib/db';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import {
  publishContactsSync,
  fetchContactsSync,
  mergeContactLists,
  identityKeypairs,
  SYNC_D_TAG as CONTACTS_SYNC_D_TAG,
} from '../lib/contacts-sync';
import { createSyncDecryptCache } from '../lib/sync-decrypt-cache';
import { resolveHookRelays } from '../lib/sync-relays';
import { getSyncSeen, setSyncSeen, classifyFetchOutcome, type SyncRemoteState } from '../lib/sync-seen';

const PUBLISH_DEBOUNCE_MS = 1000;

/** Stable hash of a contacts list for publish-idempotency checks. */
function hashContacts(contacts: Contact[]): string {
  // Normalise: sort by pubkey, strip transient fields. JSON-stringify
  // and let the intrinsic object-key ordering be deterministic for our
  // known schema. Good enough for dedupe — not a security primitive.
  const sorted = [...contacts].sort((a, b) => a.pubkey.localeCompare(b.pubkey));
  return JSON.stringify(sorted);
}

interface Options {
  identity: SignetIdentity | null;
  /** Signing backend for the user's natural-person keypair. */
  npBackend: DecryptingSigningBackend | null;
  /** Whole configured relay pool (see `sync-relays.ts`). Wins over `relayUrl` when present. */
  relays?: { read: string[]; write: string[] };
  /** @deprecated Use `relays`. Mapped to both read and write lists when `relays` is absent. */
  relayUrl?: string;
  encryptionKey: string | null;
  /**
   * Current local contacts — the hook publishes a fresh event (debounced
   * 1s, hash-deduped) whenever this array's content changes. Passing a
   * stable array reference is not required; we compare by stable hash.
   */
  contacts?: Contact[];
  /**
   * Publish local changes to the legacy `signet:contacts` tag. Default true.
   * App passes `!contactsV2Verified` — see the header note.
   */
  publishEnabled?: boolean;
  /** Called after remote contacts are merged so the caller can reload state. */
  onRemoteMerged?: () => void;
}

export function useContactsSync({ identity, npBackend, relays, relayUrl, encryptionKey, contacts, publishEnabled = true, onRemoteMerged }: Options): { remoteState: SyncRemoteState | null } {
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
          dTag: CONTACTS_SYNC_D_TAG,
          authorPubkey: identity.naturalPerson.publicKey,
          encryptionKey,
        })
      : undefined,
    [identity?.naturalPerson.publicKey, encryptionKey],
  );
  const [remoteState, setRemoteState] = useState<SyncRemoteState | null>(null);
  const readRetry = useSyncReadRetry(remoteState === 'unreachable');

  // Track the last payload hash we published, so echo-back from the
  // relay during an active subscription (future Phase 2) doesn't
  // retrigger publishing.
  const syncAuthorRef = useRef<string | undefined>(undefined);
  const hydratedAuthorRef = useRef<string | null>(null);
  const lastPublishedHashRef = useRef<string>('');
  // Track the last remote event's created_at for rollback/replay
  // protection (a relay can't serve us a strictly-older version than
  // we've already applied).
  const lastRemoteCreatedAtRef = useRef<number>(0);
  // Debounce handle.
  const publishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // M7 (2026-07-02 audit): the publish effect must not fire until the
  // fetch-and-merge effect below has resolved at least once for the
  // current (identity, backend, relayUrl, encryptionKey) tuple. Without
  // this, a fresh device — local contacts empty, remote has the real
  // data — can have its debounced publish race ahead of the fetch and
  // overwrite the relay's canonical replaceable record with a thin
  // local-only snapshot, permanently losing the synced data.
  const [hydrated, setHydrated] = useState(false);

  // Fetch-and-merge on unlock. Runs once per (identity, backend,
  // relays.read, encryptionKey) tuple.
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

        const remote = await fetchContactsSync(
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
          // "nothing newer" answer (we've fetched successfully before) is
          // still 'present', not a fresh never-seen/missing-after-seen
          // question.
          if (lastRemoteCreatedAtRef.current > 0) {
            setRemoteState('present');
          } else {
            const seenBefore = !!(await getSyncSeen(authorPubkey, CONTACTS_SYNC_D_TAG));
            if (cancelled) return;
            setRemoteState(classifyFetchOutcome({ found: false, reachableRelays: 1, seenBefore }));
          }
          return;
        }

        // Load all local contacts across every keypair on the identity.
        const ownerPubkeys = identityKeypairs(identity);
        const localByOwner = await Promise.all(
          ownerPubkeys.map(pk => db.getContacts(pk, encryptionKey)),
        );
        const local = localByOwner.flat();

        const { toSave } = mergeContactLists(local, remote.contacts);
        if (cancelled) return;
        for (const c of toSave) {
          await db.saveContact(c, encryptionKey);
        }
        if (cancelled) return;
        lastRemoteCreatedAtRef.current = remote.createdAt;
        await setSyncSeen(authorPubkey, CONTACTS_SYNC_D_TAG, { eventId: remote.eventId, createdAt: remote.createdAt });
        if (cancelled) return;
        setRemoteState('present');

        // Seed the last-published hash with the merged state so we don't
        // immediately republish what we just fetched.
        const merged = mergeContactLists(local, remote.contacts).merged;
        lastPublishedHashRef.current = hashContacts(merged);

        if (toSave.length > 0) onRemoteMerged?.();
      } finally {
        // Marks hydrated even on failure (fetch throws, relay unreachable):
        // blocking the publish gate indefinitely would strand the user's
        // local-only changes for the rest of the session. The pre-existing
        // "retry next unlock" comment below covers re-attempting the fetch;
        // this only controls whether local edits made THIS session may sync
        // out. `cancelled` guards a stale run from hydrating a newer tuple
        // that's already mid-flight (account switch, relay change).
        if (!cancelled) {
          hydratedAuthorRef.current = identity.naturalPerson.publicKey;
          setHydrated(true);
        }
      }
    })().catch(() => { /* non-fatal — next unlock retries */ });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readRetry,identity, npBackend, readRelaysKey, encryptionKey, decryptCache, onRemoteMerged]);

  // Publish on `contacts` change, debounced. Seeded ref ensures the
  // fetch-and-merge useEffect doesn't cause a round-trip publish of
  // what we just pulled. Gated on `hydrated` (M7) — see above.
  useEffect(() => {
    // R10: the v2 rail is the single writer once it has proved a round trip.
    if (!publishEnabled) return;
    if (!identity || !npBackend || effectiveRelays.write.length === 0 || !encryptionKey) return;
    if (!hydrated || hydratedAuthorRef.current !== identity.naturalPerson.publicKey) return;
    // Don't publish over a relay pool we just failed to reach — see
    // usePersonasSync for the full rationale. `remoteState` is in this
    // effect's deps, so the moment a later fetch succeeds the publish
    // effect re-evaluates and resumes normally.
    if (remoteState === 'unreachable') return;
    if (!contacts) return;

    let cancelled = false;
    const publishingBackend = guardedSigningBackend(npBackend, () => !cancelled);
    if (publishTimerRef.current) clearTimeout(publishTimerRef.current);
    publishTimerRef.current = setTimeout(async () => {
      publishTimerRef.current = null;
      try {
      // Read the authoritative set from IDB (may differ from the
      // scoped `contacts` prop that was passed in — useContacts only
      // loads the primary keypair's contacts).
      const ownerPubkeys = identityKeypairs(identity);
      const localByOwner = await Promise.all(
        ownerPubkeys.map(pk => db.getContacts(pk, encryptionKey)),
      );
      const all = localByOwner.flat();
      const hash = hashContacts(all);
      if (hash === lastPublishedHashRef.current) return; // no-op
      const ok = await publishContactsSync(all, publishingBackend, effectiveRelays.write);
      if (ok && syncAuthorRef.current === identity.naturalPerson.publicKey) lastPublishedHashRef.current = hash;
      } catch { /* A cancelled or declined signature leaves the old backup intact. */ }
    }, PUBLISH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (publishTimerRef.current) {
        clearTimeout(publishTimerRef.current);
        publishTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts, identity, npBackend, writeRelaysKey, encryptionKey, hydrated, remoteState, publishEnabled]);

  return { remoteState };
}
