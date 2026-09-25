import { useSyncReadRetry } from './useSyncReadRetry';
import { guardedSigningBackend } from '../lib/guarded-signing-backend';
/**
 * Owner personas cross-device sync hook (personas-sync rail, follow-on to
 * the earlier sync-rail phases). Cloned from `useDependantsSync` / `useGrantsSync`'s
 * shape — fetch-and-merge on identity/backend/relay/key change, plus a
 * jittered debounced publish-on-change — extended to fan out over the
 * whole configured relay pool (`relays.read` / `relays.write`, see
 * `sync-relays.ts`) rather than a single relay, and to surface a
 * `remoteState` the UI can render (present / never-seen /
 * missing-after-seen / unreachable — see `sync-seen.ts`).
 *
 * Bunker-mode addendum (family-bunker §11.1.8 posture): when this device
 * holds no mnemonic but does hold family keys on a Heartwood signer
 * (`deviceHeldKeys`), a second best-effort reconcile runs after every
 * fetch attempt — `heartwood_list_identities` is asked what `persona-N`
 * slots the device already knows about, and any not yet reflected locally
 * are added keyless (`privateKey: ''`). The device list only ever ADDS —
 * it is never used to remove a persona, and any failure (timeout,
 * malformed response, request rejected) is silent and non-fatal to the
 * rest of hydration.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExtraPersona, RemotePersonasPatch, SignetIdentity } from '../types';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import type { HeartwoodRequestFn } from '../lib/heartwood-dependant-create';
import { parseHeartwoodIdentities } from '../lib/heartwood-identities';
import { isNaturalPersonActive } from '../lib/identity-display';
import { deriveProfessionalPersona } from '../lib/professional/pro-persona';
import {
  publishPersonasSync,
  fetchPersonasSync,
  mergePersonas,
  toWire,
  isWireRicherThan,
  computePublishDelayMs,
  SYNC_D_TAG,
} from '../lib/personas-sync';
import { getSyncSeen, setSyncSeen, classifyFetchOutcome, type SyncRemoteState } from '../lib/sync-seen';
import { createSyncDecryptCache } from '../lib/sync-decrypt-cache';

/** Timeout for the best-effort `heartwood_list_identities` reconcile round-trip. */
const HEARTWOOD_LIST_TIMEOUT_MS = 6000;

/** Matches a purpose string ending in `persona-N` (e.g. `nostr:persona:persona-2`). Capture group 1 is the derivationName. */
const PERSONA_PURPOSE_RE = /(?:^|:)(persona-(\d+))$/;

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

interface Options {
  /** False after a verified private-vault migration; legacy reads remain permanent. */
  publishEnabled?: boolean;
  identity: SignetIdentity | null;
  npBackend: DecryptingSigningBackend | null;
  relays: { read: string[]; write: string[] };
  encryptionKey: string | null;
  /** Owner's mnemonic (decrypted). null in bunker mode — never `identity.mnemonic` there. */
  mnemonic: string | null;
  /**
   * True when this phone's own family keys live on a Heartwood device (no
   * mnemonic on this device at all — family-bunker §11.1.8). Lets a
   * remote-derived persona sync in keyless, and gates the Heartwood
   * `heartwood_list_identities` reconcile.
   */
  deviceHeldKeys: boolean;
  /** Bunker-mode reconcile transport. Absent/null when no Heartwood-capable signer is connected. */
  heartwoodRequestFn?: HeartwoodRequestFn | null;
  applyRemotePersonas: (patch: RemotePersonasPatch) => Promise<void>;
  /** Jitter injection for tests. Defaults to Math.random. */
  random?: () => number;
}

export function usePersonasSync({ publishEnabled = true,
  identity,
  npBackend,
  relays,
  encryptionKey,
  mnemonic,
  deviceHeldKeys,
  heartwoodRequestFn,
  applyRemotePersonas,
  random,
}: Options): { remoteState: SyncRemoteState | null; skipped: string[] } {
  // Encrypted per-rail decrypt cache (family-bunker §11.1.10). Post-migration
  // `nip44_decrypt` is a NIP-46 round-trip to the signing device; an unchanged
  // replaceable sync event can be served from the last decryption instead.
  // Memoised so the PBKDF2 derivation happens once per unlock, not per fetch.
  const decryptCache = useMemo(
    () => (identity?.naturalPerson.publicKey && encryptionKey)
      ? createSyncDecryptCache({
          dTag: SYNC_D_TAG,
          authorPubkey: identity.naturalPerson.publicKey,
          encryptionKey,
        })
      : undefined,
    [identity?.naturalPerson.publicKey, encryptionKey],
  );

  const syncAuthorRef = useRef<string | undefined>(undefined);
  const hydratedAuthorRef = useRef<string | null>(null);
  const lastPublishedHashRef = useRef<string>('');
  const lastPublishedAtRef = useRef<number>(0);
  const lastRemoteCreatedAtRef = useRef<number>(0);
  const publishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref-latched so the fetch effect doesn't need `applyRemotePersonas`
  // itself in its dependency array — callers (App.tsx) typically pass a
  // fresh `useCallback` each render whose identity is stable in practice
  // but isn't guaranteed to be; latching keeps the fetch effect's re-run
  // conditions limited to things that actually mean "re-sync".
  const applyRef = useRef(applyRemotePersonas);
  applyRef.current = applyRemotePersonas;
  // M7-style gate (see useContactsSync / useDependantsSync): don't let the
  // publish effect race the fetch-and-merge effect below on a fresh mount.
  const [hydrated, setHydrated] = useState(false);
  const [remoteState, setRemoteState] = useState<SyncRemoteState | null>(null);
  const readRetry = useSyncReadRetry(remoteState === 'unreachable');
  const [skipped, setSkipped] = useState<string[]>([]);

  const readRelaysKey = relays.read.join('|');
  const writeRelaysKey = relays.write.join('|');

  // Fetch + merge (+ Heartwood reconcile) on unlock / identity change.
  useEffect(() => {
    const author = identity?.naturalPerson.publicKey;
    if (syncAuthorRef.current !== author) {
      syncAuthorRef.current = author;
      hydratedAuthorRef.current = null;
      lastRemoteCreatedAtRef.current = 0;
      lastPublishedHashRef.current = '';
      setRemoteState(null);
      lastPublishedAtRef.current = 0;
    }
    if (!identity || !npBackend || relays.read.length === 0 || !encryptionKey) return;

    let cancelled = false;
    setHydrated(false); // new sync target — re-gate publish until this run completes

    (async () => {
      try {
        const authorPubkey = identity.naturalPerson.publicKey;
        if (!authorPubkey) return;

        let currentExtras = identity.extraPersonas ?? [];
        let currentTombstones = identity.extraPersonaTombstones ?? [];

        const remote = await fetchPersonasSync(
          authorPubkey,
          npBackend,
          relays.read,
          lastRemoteCreatedAtRef.current || undefined,
          decryptCache,
        );
        if (cancelled) return;

        if (remote === 'unreachable') {
          setRemoteState('unreachable');
          setSkipped((prev) => (prev.length === 0 ? prev : []));
        } else if (remote === null) {
          // `fetchPersonasSync` returns `null` for two genuinely different
          // situations that must not be conflated:
          //  1. Cursor-suppressed — a relay answered, but nothing it has is
          //     newer than our `since` cursor (`lastRemoteCreatedAtRef.current
          //     > 0`, i.e. we've successfully fetched a record before). The
          //     record we already have is still the current one, so this is
          //     a no-op re-confirmation of 'present', not a fresh
          //     "was there ever a record here" question.
          //  2. Not found — the cursor is 0 (this is genuinely our first
          //     fetch, or it was reset), so nothing being returned really
          //     might mean "never published" vs "published once, now gone"
          //     — that's what `getSyncSeen`/`classifyFetchOutcome` distinguish.
          // `reachableRelays: 1` is safe in both cases: `fetchPersonasSync`
          // only ever returns `null` when at least one relay WAS reachable
          // — a fully-unreachable pool returns the separate `'unreachable'`
          // sentinel handled above, never `null`.
          if (lastRemoteCreatedAtRef.current > 0) {
            setRemoteState('present');
          } else {
            const seenBefore = !!(await getSyncSeen(authorPubkey, SYNC_D_TAG));
            if (cancelled) return;
            setRemoteState(classifyFetchOutcome({ found: false, reachableRelays: 1, seenBefore }));
          }
          setSkipped((prev) => (prev.length === 0 ? prev : []));
        } else {
          const localRecordAt = Math.max(lastPublishedAtRef.current, lastRemoteCreatedAtRef.current);
          const localNpActive = isNaturalPersonActive(identity);
          const merge = mergePersonas({
            local: currentExtras,
            localTombstones: currentTombstones,
            localRecordAt,
            remote: remote.payload,
            remoteCreatedAt: remote.createdAt,
            mnemonic,
            deviceHeldKeys,
            localNaturalPersonActive: localNpActive,
            localNaturalPersonDisplayName: identity.naturalPerson.displayName,
          });

          // Name + stamp travel as one pair or not at all — see
          // `RemotePersonasPatch.professional`.
          let professional: { displayName: string; updatedAt: number } | undefined;
          if (remote.payload.professional) {
            const localProUpdatedAt = identity.professionalPersona?.updatedAt ?? 0;
            if (remote.payload.professional.updatedAt > localProUpdatedAt) {
              professional = {
                displayName: remote.payload.professional.displayName,
                updatedAt: remote.payload.professional.updatedAt,
              };
            }
          }

          // A device that has never opened the Pro surface has no
          // `professionalPersona` slot. Without conjuring one it would drop
          // the inbound Pro name AND publish a record with no `professional`
          // block, destroying the other device's Pro-name backup. Key
          // material is proved here, never down in the write path: a local
          // mnemonic must RE-DERIVE the exact pubkey on the wire, and a
          // device-held-keys install accepts it keyless (trust comes from
          // the NIP-44-to-self envelope + signature, same posture as a
          // keyless persona). Neither available ⇒ no slot, no adoption.
          let professionalSlot: { publicKey: string; privateKey: string } | undefined;
          if (professional && !identity.professionalPersona && remote.payload.professional) {
            const wirePubkey = remote.payload.professional.publicKey.toLowerCase();
            if (mnemonic) {
              const derived = deriveProfessionalPersona(mnemonic);
              if (derived.publicKey.toLowerCase() === wirePubkey) {
                professionalSlot = { publicKey: derived.publicKey, privateKey: derived.privateKey };
              }
            } else if (deviceHeldKeys) {
              professionalSlot = { publicKey: remote.payload.professional.publicKey, privateKey: '' };
            }
          }
          // Nothing to write the rename into — drop it rather than stamp a
          // name onto a slot that doesn't exist.
          if (professional && !identity.professionalPersona && !professionalSlot) {
            professional = undefined;
          }

          const npActivation = merge.naturalPersonActive && !localNpActive;
          if (merge.changed || professional || npActivation) {
            await applyRef.current({
              extraPersonas: merge.extraPersonas,
              tombstones: merge.tombstones,
              professional,
              professionalSlot,
              ...(npActivation ? { naturalPersonActive: true as const } : {}),
              // Only ever set when the merge found our own NP name empty —
              // without it a remote activation lands as an active but NAMELESS
              // real identity, since no other owner rail carries that name.
              ...(merge.naturalPersonDisplayName !== undefined
                ? { naturalPersonDisplayName: merge.naturalPersonDisplayName }
                : {}),
            });
            if (cancelled) return;
          }

          currentExtras = merge.extraPersonas;
          currentTombstones = merge.tombstones;

          setSkipped((prev) => (sameStringArray(prev, merge.skipped) ? prev : merge.skipped));
          await setSyncSeen(authorPubkey, SYNC_D_TAG, { eventId: remote.eventId, createdAt: remote.createdAt });
          if (cancelled) return;
          lastRemoteCreatedAtRef.current = remote.createdAt;

          // Mirrors `applyRemotePersonasPatch` EXACTLY, conjured slot
          // included — if the two diverge, the hash seeded below describes
          // a record the app never actually holds.
          const mergedIdentity: SignetIdentity = {
            ...identity,
            extraPersonas: merge.extraPersonas,
            extraPersonaTombstones: merge.tombstones,
            naturalPersonActive: merge.naturalPersonActive,
            ...(merge.naturalPersonDisplayName !== undefined
              ? { naturalPerson: { ...identity.naturalPerson, displayName: merge.naturalPersonDisplayName } }
              : {}),
            ...(professional
              ? identity.professionalPersona
                ? {
                    professionalPersona: {
                      ...identity.professionalPersona,
                      displayName: professional.displayName,
                      updatedAt: professional.updatedAt,
                    },
                  }
                : professionalSlot
                  ? {
                      professionalPersona: {
                        ...professionalSlot,
                        displayName: professional.displayName,
                        updatedAt: professional.updatedAt,
                      },
                    }
                  : {}
              : {}),
          };
          // Suppress the next publish unless the merge produced something
          // the relay does not hold. Deliberately NOT a plain inequality:
          // the merged wire also differs when the RELAY is the richer side
          // (a `professional` block this device can't represent, personas
          // in `merge.skipped`), and publishing then would overwrite the
          // richer record with a poorer one and flap once per app start.
          // Only a genuine local win — a newer rename, a local-only
          // persona, a newer tombstone — or a local ordering that should
          // win (our own record is at least as new as the relay's, and the
          // order actually differs) leaves the ref alone so the publish
          // effect pushes the merge after the jittered delay.
          const mergedWire = toWire(mergedIdentity);
          const orderKey = (payload: { personas: Array<{ derivationName: string }> }) =>
            payload.personas.map((x) => x.derivationName).join('|');
          const localOrderWon =
            remote.createdAt <= localRecordAt && orderKey(mergedWire) !== orderKey(remote.payload);
          if (!isWireRicherThan(mergedWire, remote.payload) && !localOrderWon) {
            lastPublishedHashRef.current = JSON.stringify(mergedWire);
          }

          setRemoteState('present');
        }

        // Heartwood reconcile (bunker mode only) — best-effort, silent on
        // failure, runs after the fetch above whether it found a payload or
        // not. Never removes a persona based on the device list, and never
        // shadows a derivationName the rail already knows under a
        // different pubkey (dedupe by BOTH pubkey and derivationName).
        if (deviceHeldKeys && heartwoodRequestFn) {
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          try {
            const raw = await Promise.race([
              heartwoodRequestFn('heartwood_list_identities', []),
              new Promise<string>((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('timeout')), HEARTWOOD_LIST_TIMEOUT_MS);
              }),
            ]);
            if (cancelled) return;

            const deviceIdentities = parseHeartwoodIdentities(raw);
            const existingPubkeys = new Set(currentExtras.map((p) => p.publicKey.toLowerCase()));
            const existingNames = new Set(currentExtras.map((p) => p.derivationName).filter(Boolean));
            // A slot the user deleted stays deleted. The Heartwood keeps the
            // derived key forever (it can't forget a tree slot), so without
            // this the device list would resurrect every tombstoned persona
            // on the next unlock — and the tombstone would delete it again on
            // the next merge, flapping forever.
            const tombstoned = new Set(currentTombstones.map((t) => t.derivationName));
            const additions: ExtraPersona[] = [];
            for (const dev of deviceIdentities) {
              const m = PERSONA_PURPOSE_RE.exec(dev.purpose);
              if (!m) continue;
              const pubkeyLower = dev.pubkey.toLowerCase();
              if (existingPubkeys.has(pubkeyLower)) continue;
              const derivationName = m[1];
              if (tombstoned.has(derivationName)) continue; // removed on this rail — never re-add
              if (existingNames.has(derivationName)) continue; // never shadow a known slot under a different key
              existingPubkeys.add(pubkeyLower);
              existingNames.add(derivationName);
              additions.push({
                publicKey: dev.pubkey,
                privateKey: '',
                displayName: dev.personaName ?? derivationName,
                derivationName,
                updatedAt: 0,
              });
            }

            if (additions.length > 0) {
              await applyRef.current({
                extraPersonas: [...currentExtras, ...additions],
                tombstones: currentTombstones,
              });
            }
          } catch {
            // Silent — best-effort reconcile, never surfaces to the UI.
          } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
          }
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
  }, [readRetry,identity, npBackend, readRelaysKey, encryptionKey, decryptCache, mnemonic, deviceHeldKeys, heartwoodRequestFn]);

  // Debounced, jittered publish-on-change. Gated on `hydrated` (M7-style)
  // AND on the last fetch outcome not being `'unreachable'` — publishing
  // over a relay pool we just failed to reach would be pointless, and
  // worse, would let this device's local state silently diverge from
  // what's actually on the relay without ever re-checking it. `remoteState`
  // already carries this (it's set on every fetch outcome, including
  // `'unreachable'`), so no separate ref is needed: including it in this
  // effect's deps means the moment a later fetch succeeds and flips
  // `remoteState` away from `'unreachable'`, the publish effect
  // re-evaluates and resumes normally.
  useEffect(() => {
    if (!publishEnabled) return;
    if (!identity || !npBackend || relays.write.length === 0 || !encryptionKey) return;
    if (!hydrated || hydratedAuthorRef.current !== identity.naturalPerson.publicKey) return;
    if (remoteState === 'unreachable') return;

    let cancelled = false;
    const publishingBackend = guardedSigningBackend(npBackend, () => !cancelled);
    if (publishTimerRef.current) clearTimeout(publishTimerRef.current);
    publishTimerRef.current = setTimeout(async () => {
      publishTimerRef.current = null;
      try {
        const hash = JSON.stringify(toWire(identity));
        if (hash === lastPublishedHashRef.current) return;
        const ok = await publishPersonasSync(identity, publishingBackend, relays.write);
        if (ok && syncAuthorRef.current === identity.naturalPerson.publicKey) {
          lastPublishedHashRef.current = hash;
          lastPublishedAtRef.current = Math.floor(Date.now() / 1000);
        }
      } catch {
        // I2: a rejecting signEvent/nip44Encrypt must not escape a bare
        // setTimeout callback as an unhandled rejection — the next
        // debounce cycle retries from scratch.
      }
    }, computePublishDelayMs(random ?? Math.random));

    return () => {
      cancelled = true;
      if (publishTimerRef.current) {
        clearTimeout(publishTimerRef.current);
        publishTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishEnabled, identity, npBackend, writeRelaysKey, encryptionKey, hydrated, remoteState, random]);

  return { remoteState, skipped };
}
