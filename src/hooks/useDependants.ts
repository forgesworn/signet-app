import { useState, useEffect, useCallback, useRef } from 'react';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { DependantIdentity, AutonomyStage, ExtraPersona, DependantBunkerEndpoint } from '../types';
import type { AuditVisibilityOverride } from '../lib/audit-visibility';
import { getDependants, saveDependant, deleteDependant, deleteGrantsForDependant, loadIdentityDecrypted, deletePublicProfileSignAuthByClient, mutateDependant } from '../lib/db';
import { deriveDependantIdentity, importFromMnemonic, deriveExtraPersona } from '../lib/signet';
import { liftDependantPublicProfileConfig } from '../lib/lift-public-profile-config';
import { liftDependantNaturalPersonActive } from '../lib/lift-natural-person-active';
import { isDependantNaturalPersonActive } from '../lib/identity-display';
import { forgetCardBackdrop } from './useCardBackdrop';
import { buildPersonaFirstDependant } from '../lib/dependant-record';
import { nextDependantIndex } from '../lib/heartwood-dependant-create';
import type { DerivedKeypair, ExtraPersonaDeviceDerive } from '../lib/heartwood-dependant-create';
import type { Nip05CheckResult } from '../lib/nip05-check';
import { resolvePublicProfileBase } from '../lib/public-profile-base';
import { nextDependantPersonaName, dependantPersonaTombstones, applyDependantPersonaTombstones } from '../lib/dependant-persona-allocation';
import { createSerialQueue } from '../lib/contacts-v2-queue';
import { listIndependenceArchives } from '../lib/independence-store';
import { sanitizeDisplayName } from '../lib/text-sanitize';
import { supersedeBackdropSends } from '../lib/backdrop-send';
import { collectSlotBlobsToDelete, deleteRemovedBlobs, type BlobDeleter, type SlotBlobToDelete } from '../lib/blob-deletion';

// Serialize allocation/deletion across hook instances in this app.
const personaMutations = createSerialQueue();

type SlotTarget = 'natural-person' | 'persona' | string;
type SlotPatch = Partial<ExtraPersona>;

/** `dep` with `patch` applied to the slot `target` (NP, persona, or an extra's pubkey). */
function patchSlot(dep: DependantIdentity, target: SlotTarget, patch: SlotPatch | ((slot: Partial<ExtraPersona>) => SlotPatch)): DependantIdentity {
  const apply = <S extends object>(slot: S): S => ({ ...slot, ...(typeof patch === 'function' ? patch(slot as Partial<ExtraPersona>) : patch) });
  if (target === 'natural-person') return { ...dep, naturalPerson: apply(dep.naturalPerson) };
  if (target === 'persona') return { ...dep, persona: apply(dep.persona) };
  return { ...dep, extraPersonas: (dep.extraPersonas ?? []).map(p => (p.publicKey === target ? apply(p) : p)) };
}

/** The slot `target` of `dep`, or undefined when it has no such slot. */
function findSlot(dep: DependantIdentity, target: SlotTarget): Partial<ExtraPersona> | undefined {
  if (target === 'natural-person') return dep.naturalPerson;
  if (target === 'persona') return dep.persona;
  return (dep.extraPersonas ?? []).find(p => p.publicKey === target);
}

const NO_BACKDROP = { backdropHash: undefined, backdropBlossomUrl: undefined, backdropKey: undefined, backdropUpdatedAt: undefined, backdropSentDigest: undefined };

/** The slot targets of a dependant as the backdrop lookup keys them. */
function slotTargetsOf(dep: DependantIdentity): string[] {
  return ['natural-person', 'persona', ...(dep.extraPersonas ?? []).map(p => p.publicKey)];
}

/** Whether a slot names any part of a sent backdrop. */
function slotHasBackdrop(slot: Partial<ExtraPersona>): boolean {
  return !!(slot.backdropHash || slot.backdropBlossomUrl || slot.backdropKey || slot.backdropSentDigest || slot.backdropUpdatedAt);
}

/** `dep` with every slot's sent-backdrop pointer cleared (null when none names one). The local `backdrop:` rows are not touched. */
function withoutBackdropPointers(dep: DependantIdentity): DependantIdentity | null {
  const slots: Array<Partial<ExtraPersona>> = [dep.naturalPerson, dep.persona, ...(dep.extraPersonas ?? [])];
  if (!slots.some(slotHasBackdrop)) return null;
  return {
    ...dep,
    naturalPerson: { ...dep.naturalPerson, ...NO_BACKDROP },
    persona: { ...dep.persona, ...NO_BACKDROP },
    extraPersonas: dep.extraPersonas?.map(p => ({ ...p, ...NO_BACKDROP })),
  };
}

/**
 * Bunker-mode dependant creation (family-bunker §11.1.8 D4). When supplied,
 * the caller's device derivation is used INSTEAD of the guardian mnemonic —
 * App.tsx wires this to the paired Heartwood signer once the phone has been
 * stripped of local key material. Returned slots always have
 * `privateKey: ''`.
 */
export type DependantDeviceDerive = (derivationPath: string) => Promise<{ naturalPerson: DerivedKeypair; persona: DerivedKeypair }>;
/** Re-exported from `lib/heartwood-dependant-create` — `useIdentity` needs the
 *  same type for the owner's own "+ Add persona", and hooks shouldn't import
 *  types from each other. Existing `useDependants` call sites are unchanged. */
export type { ExtraPersonaDeviceDerive };

export function useDependants(
  guardianPubkey?: string,
  /**
   * Guardian identity's primary-key id (the IDB lookup key). Used by
   * `addDependant` / `addDependantPersona` to fresh-decrypt the mnemonic
   * at the moment of use, rather than reading it out of React state —
   * which can be stale ciphertext if the app briefly re-locked during an
   * auth prompt (visibilitychange handler sets `encryptionKey` to null,
   * `loadPublic` repopulates identity records with their ciphertext
   * mnemonic). Without this fresh-decrypt, those callers would pass
   * ciphertext to `deriveExtraPersona` and throw "Invalid BIP-39 mnemonic".
   */
  guardianIdentityId?: string,
  encryptionKey?: string | null,
  options?: {
    /**
     * Deletes one of this install's Blossom blobs (App's `deleteOwnBlob`: R1
     * is enforced there). Without it, removal and unpair leave blobs alone.
     */
    deleteBlob?: BlobDeleter;
  },
) {
  /**
   * Fresh-decrypt the guardian identity from IDB for the caller's key.
   * Use this for every derive — see the constructor comment for why.
   */
  const loadGuardianMnemonic = useCallback(async (key: string): Promise<string> => {
    if (!guardianIdentityId) {
      throw new Error('Cannot derive keys: no guardian identity');
    }
    const decrypted = await loadIdentityDecrypted(guardianIdentityId, key);
    if (!decrypted?.mnemonic) {
      throw new Error('Cannot derive keys: guardian has no mnemonic');
    }
    return decrypted.mnemonic;
  }, [guardianIdentityId]);
  const [dependants, setDependants] = useState<DependantIdentity[]>([]);
  const [loading, setLoading] = useState(true);
  // Whether `dependants` is the result of a finished read made WITH the key
  // (decrypted), not the keyless read before unlock, nor an empty list while
  // the guardian identity is not there. `loading` cannot say this: it goes
  // false after the first, keyless, read and never comes back.
  const [loadedWithKey, setLoadedWithKey] = useState(false);
  const loadSeqRef = useRef(0);
  // The key as of the latest render. A setter that awaits slow work (an upload
  // finishing) holds the key of the render that created it; after a lock that
  // closure would still save with the old key and push decrypted records into
  // state AFTER the lock cleared them. Compare against this before writing.
  const liveKeyRef = useRef(encryptionKey);
  useEffect(() => { liveKeyRef.current = encryptionKey; }, [encryptionKey]);
  const deleteBlobRef = useRef(options?.deleteBlob);
  deleteBlobRef.current = options?.deleteBlob;

  /**
   * Delete blobs whose slot just left the stored record (removal, unpair).
   * Starts at once and settles when done; never throws and never fails the
   * change that called it. Locked or unreachable: recorded as orphans.
   */
  const deleteGoneBlobs = useCallback((blobs: readonly SlotBlobToDelete[]): Promise<void> => {
    const deleteBlob = deleteBlobRef.current;
    if (blobs.length === 0 || !deleteBlob) return Promise.resolve();
    return deleteRemovedBlobs(blobs, { deleteBlob, isLive: () => !!liveKeyRef.current });
  }, []);

  /**
   * Change one dependant record through the serialised fresh-read writer
   * (`db.mutateDependant`): `fn` gets the record as stored NOW (lifted the same
   * way `loadDependants` lifts it), never the `dependants` snapshot this
   * closure holds, so a sync merge or another setter that landed meanwhile is
   * kept. `fn(null)` = no such dependant; return null to write nothing. `fn`
   * must not write a dependant itself.
   */
  const mutate = useCallback((
    depId: string,
    key: string,
    fn: (dep: DependantIdentity | null) => DependantIdentity | null,
  ): Promise<DependantIdentity | null> => {
    if (!guardianPubkey) return Promise.resolve(null);
    return mutateDependant(guardianPubkey, depId, key, cur => fn(cur ? liftDependantNaturalPersonActive(cur) : null));
  }, [guardianPubkey]);

  /**
   * Shared lift + sort step used by both effect-driven `loadDependants`
   * (which reads `encryptionKey` from closure) and the imperative
   * `loadFreshDependants` (which takes a key argument and bypasses the
   * closure entirely).
   */
  const migrateAndSort = useCallback((results: DependantIdentity[]): DependantIdentity[] => {
    // Lift any legacy publicProfile.{name,displayName,about,...} fields up
    // to the slot top-level on every decrypt — idempotent. See 2026-05-17
    // persona-card-as-source-of-truth design §6 migration.
    const migrated = results.map(d => liftDependantNaturalPersonActive(liftDependantPublicProfileConfig(d)));
    // Sort by manual sortIndex (set via Manage Carousel). Undefined sortIndex
    // is treated as +Infinity so unordered dependants land at the bottom of
    // the carousel group — they keep their existing relative order via
    // stable Array.prototype.sort.
    return [...migrated].sort((a, b) => {
      const ai = a.sortIndex ?? Number.POSITIVE_INFINITY;
      const bi = b.sortIndex ?? Number.POSITIVE_INFINITY;
      return ai - bi;
    });
  }, []);

  const loadDependants = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    if (!guardianPubkey) {
      setDependants([]);
      setLoading(false);
      setLoadedWithKey(false);
      return;
    }
    const results = await getDependants(guardianPubkey, encryptionKey ?? undefined);
    setDependants(migrateAndSort(results));
    setLoading(false);
    // Only the newest read speaks for the key: an older one finishing late must not.
    if (seq === loadSeqRef.current) setLoadedWithKey(!!encryptionKey);
  }, [guardianPubkey, encryptionKey, migrateAndSort]);

  useEffect(() => {
    loadDependants();
  }, [loadDependants]);

  /**
   * Imperative fresh-decrypt — fetches dependants from IDB with the caller-
   * supplied key, sets React state, and returns the decrypted array
   * synchronously to the caller. Use this when the React-state copy of
   * `dependants` might be stale ciphertext (e.g. the auto-lock fired
   * during a pending auth flow, repopulating records keylessly; the user
   * has since re-unlocked but the effect-driven reload hasn't completed
   * yet). Mirrors the `loadGuardianMnemonic` fresh-decrypt pattern above
   * and closes the dep-flavour of the same race documented at line 17.
   *
   * Throws if `guardianPubkey` is unset (caller must guard first).
   */
  const loadFreshDependants = useCallback(async (key: string): Promise<DependantIdentity[]> => {
    if (!guardianPubkey) throw new Error('Cannot load dependants: no guardian pubkey');
    const results = await getDependants(guardianPubkey, key);
    const sorted = migrateAndSort(results);
    setDependants(sorted);
    return sorted;
  }, [guardianPubkey, migrateAndSort]);

  const addDependant = useCallback(async (
    displayName: string,
    dateOfBirth?: string,
    opts?: { deviceDerive?: DependantDeviceDerive },
  ): Promise<DependantIdentity> => {
    if (!guardianPubkey) throw new Error('No guardian pubkey');
    if (!encryptionKey) throw new Error('Encryption key required');

    const closed = await listIndependenceArchives(guardianPubkey, encryptionKey);
    const derivationPath = `dependant-${nextDependantIndex([...dependants, ...closed])}`;

    // Bunker mode (family-bunker §11.1.8 D4): the device derives; we keep
    // public keys only. Local mode: derive from the guardian mnemonic as
    // before.
    const { naturalPerson, persona } = opts?.deviceDerive
      ? await opts.deviceDerive(derivationPath)
      : deriveDependantIdentity(await loadGuardianMnemonic(encryptionKey), derivationPath);

    const dep = buildPersonaFirstDependant({
      guardianPubkey,
      enteredName: displayName,
      dateOfBirth,
      derivationPath,
      naturalPerson,
      persona,
      createdAt: Math.floor(Date.now() / 1000),
    });

    await saveDependant(dep, encryptionKey);
    await loadDependants();
    return dep;
  }, [guardianPubkey, encryptionKey, dependants, loadDependants, loadGuardianMnemonic]);

  const importDependant = useCallback(async (
    publicKey: string,
    displayName: string,
    dateOfBirth?: string,
    mnemonic?: string,
  ): Promise<DependantIdentity> => {
    if (!guardianPubkey) throw new Error('No guardian pubkey');
    if (!encryptionKey) throw new Error('Encryption key required');

    let naturalPerson: { publicKey: string; privateKey: string; displayName: string };
    let persona: { publicKey: string; privateKey: string; displayName: string };
    let derivationPath: string;

    if (mnemonic) {
      // Full key access — derive keypairs from the mnemonic
      const tempIdentity = importFromMnemonic(mnemonic, displayName, 'natural-person', false);
      naturalPerson = { ...tempIdentity.naturalPerson, displayName };
      persona = { ...tempIdentity.persona, displayName: `${displayName} (anonymous)` };
      derivationPath = `imported-${publicKey.slice(0, 8)}`;
    } else {
      // View-only — store public key only, no private keys
      naturalPerson = { publicKey, privateKey: '', displayName };
      persona = { publicKey: '', privateKey: '', displayName: `${displayName} (anonymous)` };
      derivationPath = `imported-view-${publicKey.slice(0, 8)}`;
    }

    const dep: DependantIdentity = {
      id: publicKey,
      guardianPubkey,
      displayName,
      dateOfBirth,
      naturalPerson,
      persona,
      derivationPath,
      createdAt: Math.floor(Date.now() / 1000),
      autonomyStage: 'full-control',
      primaryKeypair: 'natural-person',
    };

    await saveDependant(dep, encryptionKey);
    await loadDependants();
    return dep;
  }, [guardianPubkey, encryptionKey, loadDependants]);

  const removeDependant = useCallback(async (
    pubkey: string,
    opts?: {
      /**
       * Leave the avatar and backdrop blobs on the server. The independence
       * handover sets it: the handed-over child's own install still points at
       * the avatars the guardian uploaded (its inventory merge copied them onto
       * its slots), so deleting them would blank the child's pictures.
       */
      keepBlobs?: boolean;
    },
  ): Promise<{ deletion: Promise<void> }> => {
    // Clear grants + identity together. Dependant pubkeys are derived
    // deterministically from the guardian mnemonic + index (see
    // `deriveDependantIdentity`) — re-adding a dependant at the same index
    // produces the same pubkey, so stale grants from the previous instance
    // would otherwise silently re-apply to the new one. The bunker endpoint
    // keypair lives on the identity row and is deleted with it.
    //
    // Sweep any dep-keyed records that don't cascade with the dep identity
    // row: §5.4.1 pre-auth records (publicProfileSignAuth) and any local
    // paired-child cache for this dep. Re-adding the dep at the same index
    // would otherwise re-attach to leftover pre-auth grants for personas
    // whose keypairs may or may not be the same after re-derive.
    let dep = dependants.find(d => d.id === pubkey);
    // The blobs to delete are read from the record as stored NOW (a sync or an
    // avatar change may have landed since the snapshot), before it is deleted.
    if (!opts?.keepBlobs) {
      const key = liveKeyRef.current;
      if (key) {
        try {
          await mutate(pubkey, key, fresh => { if (fresh) dep = fresh; return null; });
        } catch { /* fall back to the snapshot */ }
      }
    }
    if (dep) {
      try {
        const dbMod = await import('../lib/db');
        await dbMod.deletePublicProfileSignAuthByPersona(pubkey, dep.naturalPerson.publicKey);
        await dbMod.deletePublicProfileSignAuthByPersona(pubkey, dep.persona.publicKey);
        for (const ep of dep.extraPersonas ?? []) {
          await dbMod.deletePublicProfileSignAuthByPersona(pubkey, ep.publicKey);
        }
        await dbMod.clearPairedChild(pubkey);
      } catch {
        // Best-effort sweep — proceed with delete even if cleanup partially fails.
      }
    }
    await deleteGrantsForDependant(pubkey);
    await deleteDependant(pubkey);
    // Device-local card backdrops for every key the dependant could show a
    // card for (the dependant row's own key, its default persona, its extras).
    if (dep) {
      const keys = new Set<string>([
        dep.id,
        dep.naturalPerson.publicKey,
        dep.persona.publicKey,
        ...(dep.extraPersonas ?? []).map(ep => ep.publicKey),
      ]);
      for (const key of keys) await forgetCardBackdrop(key);
    }
    // The record is gone, so nothing stored points at its blobs any more (R1
    // is still checked by the deleter against every other row).
    const deletion = opts?.keepBlobs ? Promise.resolve() : deleteGoneBlobs(collectSlotBlobsToDelete(dep, ['avatar', 'backdrop']));
    await loadDependants();
    return { deletion };
  }, [dependants, loadDependants, mutate, deleteGoneBlobs]);

  const updateAutonomyStage = useCallback(async (pubkey: string, stage: AutonomyStage) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    await mutate(pubkey, encryptionKey, dep => dep && { ...dep, autonomyStage: stage });
    await loadDependants();
  }, [mutate, encryptionKey, loadDependants]);

  /**
   * Set (or replace) the avatar for one of a dependant's persona slots
   * (NP, persona, or an extra-persona pubkey). Caller has uploaded the
   * encrypted blob to Blossom and is passing the resulting metadata
   * `{ hash, blossomUrl, keyHex, updatedAt }`. The `keyHex` gets
   * encrypted at rest by `saveDependant`, same pattern as the dep's
   * keypair `privateKey`.
   *
   * Mirrors `useIdentity.setPersonaAvatar` but for the guardian's
   * deps. Reads the dep fresh in the dependant write queue (an upload takes
   * seconds; the `dependants` snapshot may predate a sync or a backdrop save).
   * Resolves with the avatar the slot held BEFORE, read from that same record,
   * so the caller deletes the right blob. Throws (saves nothing) when the key
   * is no longer live or the dependant or slot is gone.
   */
  const setDependantPersonaAvatar = useCallback(async (
    depPubkey: string,
    target: SlotTarget,
    avatar: { hash: string; blossomUrl: string; keyHex: string; updatedAt: number },
  ): Promise<{ previous?: { hash: string; server: string } }> => {
    if (!encryptionKey) throw new Error('Encryption key required');
    if (!guardianPubkey) throw new Error('No guardian identity');
    let previous: { hash: string; server: string } | undefined;
    await mutate(depPubkey, encryptionKey, dep => {
      if (!dep) throw new Error('Dependant not found');
      const slot = findSlot(dep, target);
      if (!slot) throw new Error('Persona not found');
      // Locked while waiting for the write queue: save nothing.
      if (liveKeyRef.current !== encryptionKey) throw new Error('Encryption key required');
      previous = slot.avatarHash && slot.avatarBlossomUrl ? { hash: slot.avatarHash, server: slot.avatarBlossomUrl } : undefined;
      return patchSlot(dep, target, {
        avatarHash: avatar.hash,
        avatarBlossomUrl: avatar.blossomUrl,
        avatarKey: avatar.keyHex,
        avatarUpdatedAt: avatar.updatedAt,
      });
    });
    // Locked while saving: the lock effect owns state now; do not reload into it.
    if (liveKeyRef.current === encryptionKey) await loadDependants();
    return { previous };
  }, [mutate, guardianPubkey, encryptionKey, loadDependants]);

  /**
   * Guardian-side write of a dep persona's public-profile config + state.
   *
   * The design (§5.4 step 2) splits responsibility: guardian writes config
   * (enabled/name/displayName/about/pictureUrl/etc.) as POLICY INTENT;
   * KID writes publication state (lastEventId / lastPublishedAt /
   * lastPublishedRelay) after its own publish. Phase D ships a divergence
   * — the guardian publishes from its own device because multi-key NIP-46
   * (needed for kid-side signing as non-NP personas) isn't wired this phase.
   * So this helper accepts state fields too; the inventory sync rail
   * (`publicProfileToInventoryBlock`) still strips them from the wire so
   * the kid never sees them and the wire-format invariant holds.
   *
   * When kid-side publish lands (multi-key NIP-46 ready), the
   * App.tsx caller will revert to passing config-only and the kid's
   * `mergePublicProfile` will fill in state — no change needed here.
   */
  const setDependantPersonaPublicProfile = useCallback(async (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
    config: import('../types').PublicProfileConfig | undefined,
    state: import('../types').PersonaPublicProfile | undefined,
    /** Device-local kind-0 base, written with `state`. Absent = keep; `null` = clear. */
    base?: import('../types').PublicProfileBase | null,
  ) => {
    if (!encryptionKey) throw new Error('Encryption key required');

    // Build slot-config patch — explicit undefined for each key to ensure
    // spread replaces existing values cleanly (matches partial-config =
    // full-replace semantics). displayName is intentionally NOT included —
    // it has its own dedicated `updateDependantPersonaName` callback.
    const cfgPatch = config
      ? {
          about: config.about,
          pictureUrl: config.pictureUrl,
          pictureBlossomHash: config.pictureBlossomHash,
          bannerUrl: config.bannerUrl,
          bannerBlossomHash: config.bannerBlossomHash,
          nip05: config.nip05,
          lud16: config.lud16,
          website: config.website,
        }
      : {
          about: undefined,
          pictureUrl: undefined,
          pictureBlossomHash: undefined,
          bannerUrl: undefined,
          bannerBlossomHash: undefined,
          nip05: undefined,
          lud16: undefined,
          website: undefined,
        };
    const ppValue = state;

    // Same posture as useIdentity.setPersonaPublicProfile — a stored NIP-05
    // check result is only meaningful for the exact identifier it was
    // computed against, so drop it whenever the incoming nip05 differs from
    // what's currently stored (including clearing it to empty).
    function nip05CheckClear(prevNip05: string | undefined): {
      nip05CheckResult?: undefined;
      nip05CheckedAt?: undefined;
    } {
      return cfgPatch.nip05 === prevNip05 ? {} : { nip05CheckResult: undefined, nip05CheckedAt: undefined };
    }

    let personaPubkey = '';
    const saved = await mutate(depPubkey, encryptionKey, dep => {
      if (!dep) return null;
      personaPubkey = target === 'natural-person' ? dep.naturalPerson.publicKey
        : target === 'persona' ? dep.persona.publicKey
        : target;
      return patchSlot(dep, target, slot => ({
        ...cfgPatch,
        ...nip05CheckClear(slot.nip05),
        publicProfile: ppValue,
        publicProfileBase: resolvePublicProfileBase(slot.publicProfileBase, base, ppValue),
      }));
    });
    if (!saved) return;

    // §5.4.1 pre-auth provisioning. When the guardian enables a dep's
    // publicProfile AND there's a paired kid client, save (refresh) the
    // pre-auth records for kind 0 (publish) and kind 5 (retract) scoped
    // to the specific persona pubkey and the specific kid-client pubkey.
    // Without this the kid's first kind-0 publish would prompt the
    // guardian a second time — annoying since the guardian just clicked
    // Save with their explicit intent. Refresh (overwrite) on every
    // Save tap so the TTL keeps rolling as long as the guardian remains
    // engaged with the persona.
    //
    // When `enabled === false` we CLEAR the pre-auth records. The Phase D
    // divergence (guardian publishes the kind-5 retraction directly via
    // App.tsx, not the kid) means there's no remaining use for an
    // auto-approve scope after disable — leaving the records around would
    // expand the auto-approve surface for up to 24h without serving any
    // post-disable flow. When kid-side publish lands (multi-key NIP-46),
    // this clear-on-disable can be reconsidered.
    //
    // Fresh-decrypt the dep before reading `bunkerEndpoint` (audit pass 4).
    // A concurrent clearDependantBunkerEndpoint/bindDependantBunkerClient
    // race would leave React state stale; if we resurrected pre-auth
    // records under the OLD revoked client pubkey, a previously-paired
    // device could still auto-approve publishes after revocation. Reading
    // out of IDB here costs one decrypt but closes the resurrection
    // window — saveDependant above already serialised the write.
    let kidClientPubkey: string | undefined;
    try {
      const freshList = await getDependants(guardianPubkey ?? '', encryptionKey);
      const freshDep = freshList.find(d => d.id === depPubkey);
      kidClientPubkey = freshDep?.bunkerEndpoint?.authorizedClientPubkey;
    } catch {
      kidClientPubkey = undefined;
    }
    if (personaPubkey && kidClientPubkey) {
      try {
        const dbMod = await import('../lib/db');
        if (state?.enabled === true) {
          await Promise.all([
            dbMod.savePublicProfileSignAuth(depPubkey, personaPubkey, kidClientPubkey, 0),
            dbMod.savePublicProfileSignAuth(depPubkey, personaPubkey, kidClientPubkey, 5),
          ]);
        } else {
          await Promise.all([
            dbMod.deletePublicProfileSignAuth(depPubkey, personaPubkey, kidClientPubkey, 0),
            dbMod.deletePublicProfileSignAuth(depPubkey, personaPubkey, kidClientPubkey, 5),
          ]);
        }
      } catch {
        // Pre-auth provisioning is best-effort — failure means kid's next
        // publish prompts the guardian as a regular sign_event, which is
        // the safe fallback (manual approval).
      }
    }

    await loadDependants();
  }, [mutate, encryptionKey, guardianPubkey, loadDependants]);

  /** Clear dep persona public-profile config. */
  const clearDependantPersonaPublicProfile = useCallback(async (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
  ) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    await mutate(depPubkey, encryptionKey, dep => dep && patchSlot(dep, target, { publicProfile: undefined, publicProfileBase: undefined }));
    await loadDependants();
  }, [mutate, encryptionKey, loadDependants]);

  /** Remove avatar metadata from a dep persona slot. This only clears the
   *  record: the caller (App.tsx) deletes the old blob from Blossom afterwards
   *  (`blob-deletion.ts`, R3). */
  const clearDependantPersonaAvatar = useCallback(async (
    depPubkey: string,
    target: SlotTarget,
  ): Promise<{ previous?: { hash: string; server: string } }> => {
    if (!encryptionKey) throw new Error('Encryption key required');
    if (!guardianPubkey) throw new Error('No guardian identity');
    let previous: { hash: string; server: string } | undefined;
    await mutate(depPubkey, encryptionKey, dep => {
      if (!dep) throw new Error('Dependant not found');
      const slot = findSlot(dep, target);
      if (!slot) throw new Error('Persona not found');
      if (liveKeyRef.current !== encryptionKey) throw new Error('Encryption key required');
      previous = slot.avatarHash && slot.avatarBlossomUrl ? { hash: slot.avatarHash, server: slot.avatarBlossomUrl } : undefined;
      if (!previous && !slot.avatarKey) return null;
      return patchSlot(dep, target, {
        avatarHash: undefined,
        avatarBlossomUrl: undefined,
        avatarKey: undefined,
        avatarUpdatedAt: undefined,
      });
    });
    if (liveKeyRef.current === encryptionKey) await loadDependants();
    return { previous };
  }, [mutate, guardianPubkey, encryptionKey, loadDependants]);

  /**
   * Set (or replace) the contact-card avatar for one of a dependant's persona
   * slots. Mirrors `useIdentity.setPersonaContactAvatar` for the guardian's
   * deps.
   *
   * Reads the dep FRESH from IDB (not the React-state `dependants` snapshot).
   * This call is frequently chained right after `setDependantPersonaAvatar`
   * in the same handler (avatar change → contact-avatar republish in
   * `App.pushContactAvatar`). The in-memory array captured by that handler's
   * closure is the PRE-change snapshot — `loadDependants()` schedules a state
   * update but doesn't mutate the closure — so patching contactAvatar* fields
   * onto the stale dep and saving it would silently revert the avatar that the
   * preceding `setDependantPersonaAvatar` just wrote. A fresh read mirrors the
   * user-side `loadIdentityDecrypted` path, which is why the user equivalents
   * never had this bug. See the internal issue tracker C1.
   */
  const setDependantPersonaContactAvatar = useCallback(async (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
    contact: { contactAvatarKey: string; contactAvatarHash: string; contactAvatarBlossomUrl: string; contactAvatarUpdatedAt: number; contactAvatarStale: boolean },
  ) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    if (!guardianPubkey) return;
    const patch = {
      contactAvatarKey: contact.contactAvatarKey,
      contactAvatarHash: contact.contactAvatarHash,
      contactAvatarBlossomUrl: contact.contactAvatarBlossomUrl,
      contactAvatarUpdatedAt: contact.contactAvatarUpdatedAt,
      contactAvatarStale: contact.contactAvatarStale,
    };
    await mutate(depPubkey, encryptionKey, dep => dep && patchSlot(dep, target, patch));
    await loadDependants();
  }, [mutate, guardianPubkey, encryptionKey, loadDependants]);

  /**
   * Set (or, with `null`, clear) the encrypted copy of a card backdrop that the
   * guardian sends to the dependant's own phone. Only the pointer lives on the
   * slot (`backdropHash/BlossomUrl/Key/UpdatedAt`); the picture itself is the
   * device-local `backdrop:<pubkey>` row. Reads the dep FRESH from IDB, like
   * the contact-avatar setters (C1), because an upload takes seconds and the
   * `dependants` snapshot this closure holds may be older than a sync that
   * landed meanwhile. Resolves with the blob the slot pointed at BEFORE the
   * change, read from that same fresh record, so the caller deletes the right
   * one (and only after this save, so the row no longer references it).
   * Throws (never resolves as if saved) when the key is gone or the dependant
   * or slot no longer exists, so the caller deletes the blob it just uploaded.
   */
  const setDependantPersonaBackdrop = useCallback(async (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
    backdrop: { hash: string; blossomUrl: string; keyHex: string; updatedAt: number; sentDigest?: string } | null,
    opts?: {
      /**
       * Asked INSIDE the write queue, once the record is read: false means a
       * newer change (an unpair, a remove) outranked this save while it waited,
       * so nothing is written.
       */
      stillCurrent?: () => boolean;
    },
  ): Promise<{ previous?: { hash: string; server: string } }> => {
    if (!encryptionKey) throw new Error('Encryption key required');
    if (!guardianPubkey) throw new Error('No guardian identity');
    let previous: { hash: string; server: string } | undefined;
    await mutate(depPubkey, encryptionKey, dep => {
      if (!dep) throw new Error('Dependant not found');
      const slot = findSlot(dep, target);
      if (!slot) throw new Error('Persona not found');
      // Checked after the write queue's wait: a lock during it saves nothing.
      if (liveKeyRef.current !== encryptionKey) throw new Error('Encryption key required');
      if (backdrop) {
        // An unpair or a newer change ran while this save waited its turn: a
        // pointer written now would outlive the phone it was sent for.
        if (opts?.stillCurrent && !opts.stillCurrent()) throw new Error('Superseded');
        if (!dep.bunkerEndpoint?.authorizedClientPubkey) throw new Error('No phone paired');
      }
      previous = slot.backdropHash && slot.backdropBlossomUrl
        ? { hash: slot.backdropHash, server: slot.backdropBlossomUrl }
        : undefined;
      // Clearing a slot that names nothing has nothing to save.
      if (!backdrop && !previous && !slot.backdropKey && !slot.backdropSentDigest) return null;
      return patchSlot(dep, target, backdrop
        ? { backdropHash: backdrop.hash, backdropBlossomUrl: backdrop.blossomUrl, backdropKey: backdrop.keyHex, backdropUpdatedAt: backdrop.updatedAt, backdropSentDigest: backdrop.sentDigest }
        : { backdropHash: undefined, backdropBlossomUrl: undefined, backdropKey: undefined, backdropUpdatedAt: undefined, backdropSentDigest: undefined });
    });
    // Locked while saving: the lock effect owns state now; do not reload into it.
    if (liveKeyRef.current === encryptionKey) await loadDependants();
    return { previous };
  }, [mutate, guardianPubkey, encryptionKey, loadDependants]);

  /** Remove contact-card avatar metadata from a dep persona slot. This only
   *  clears the record: Stop sharing (App.tsx) deletes the share blob (R5).
   *  Reads the dep FRESH from IDB for the same stale-snapshot reason as
   *  `setDependantPersonaContactAvatar` (C1). */
  const clearDependantPersonaContactAvatar = useCallback(async (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
  ) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    if (!guardianPubkey) return;
    const patch = {
      contactAvatarKey: undefined,
      contactAvatarHash: undefined,
      contactAvatarBlossomUrl: undefined,
      contactAvatarUpdatedAt: undefined,
      contactAvatarStale: undefined,
    };
    await mutate(depPubkey, encryptionKey, dep => dep && patchSlot(dep, target, patch));
    await loadDependants();
  }, [mutate, guardianPubkey, encryptionKey, loadDependants]);

  /**
   * Persist a NIP-05 check result for one of a dependant's persona slots.
   * Device-local — never synced. Mirrors `useIdentity.setSlotNip05Check`.
   * Reads the dep FRESH from IDB for the same stale-snapshot reason as
   * `setDependantPersonaContactAvatar` (C1).
   */
  const setDependantSlotNip05Check = useCallback(async (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
    check: { result: Nip05CheckResult; checkedAt: number },
  ) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    if (!guardianPubkey) return;
    const patch = { nip05CheckResult: check.result, nip05CheckedAt: check.checkedAt };
    await mutate(depPubkey, encryptionKey, dep => dep && patchSlot(dep, target, patch));
    await loadDependants();
  }, [mutate, guardianPubkey, encryptionKey, loadDependants]);

  /**
   * Per-dep audit-visibility override (v2).
   * `'default'` (or `undefined`) defers to the autonomy-stage rule;
   * `'force-visible'` / `'force-hidden'` flip the resolver. Stored
   * verbatim on `DependantIdentity.auditVisibility`. The audit
   * publisher and child-side surface read it via the resolver in
   * `src/lib/audit-visibility.ts`.
   */
  const updateAuditVisibility = useCallback(async (
    pubkey: string,
    override: AuditVisibilityOverride,
  ) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    await mutate(pubkey, encryptionKey, dep => dep && { ...dep, auditVisibility: override });
    await loadDependants();
  }, [mutate, encryptionKey, loadDependants]);

  /**
   * Guardian opt-in for C4 petitions on device auto-deny (family-bunker
   * §11.1.4/9). Device-local like `auditVisibility` — read by the C3
   * policy compiler (`policy-compiler.ts` `buildCompilerInput`) and pushed
   * to the Heartwood slot as `petition_on_deny`.
   */
  const updatePetitionOnDeny = useCallback(async (
    pubkey: string,
    on: boolean,
  ) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    await mutate(pubkey, encryptionKey, dep => dep && { ...dep, petitionOnDeny: on });
    await loadDependants();
  }, [mutate, encryptionKey, loadDependants]);

  /**
   * Update photo metadata on a dependant. Photo fields are device-local
   * — they don't propagate via cross-device sync (mirror of
   * `bunkerEndpoint`/`appBunkerEndpoint`/`auditVisibility` posture in
   * `mergeDependantWithLocal`).
   */
  const updateDependantPhoto = useCallback(async (
    pubkey: string,
    photoHash: string,
    blossomUrl: string,
    photoKey: string,
  ) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    await mutate(pubkey, encryptionKey, dep => dep && {
      ...dep,
      photoHash,
      blossomUrl,
      photoKey,
      photoUpdatedAt: Math.floor(Date.now() / 1000),
    });
    await loadDependants();
  }, [mutate, encryptionKey, loadDependants]);

  const updateDependantName = useCallback(async (pubkey: string, displayName: string) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    // The top-level label is the guardian-private family label. It may also be
    // the NP's display name — but ONLY for an already-active real identity.
    // Writing it onto a dormant slot would name the real identity behind the
    // guardian's back and (pre-lift records aside) flip it active.
    await mutate(pubkey, encryptionKey, dep => dep && (isDependantNaturalPersonActive(dep)
      ? { ...dep, displayName, naturalPerson: { ...dep.naturalPerson, displayName } }
      : { ...dep, displayName }));
    await loadDependants();
  }, [mutate, encryptionKey, loadDependants]);

  /**
   * Reorder dependants in the carousel parent ring. Writes a sortIndex
   * onto each dep matching its position in `orderedIds`. Dependants not
   * in the list keep their existing sortIndex (or remain unsorted) and
   * fall through to the bottom — never silently dropped, even if the
   * caller's view is stale (e.g. a sync arrived mid-edit).
   */
  const reorderDependants = useCallback(async (orderedIds: string[]) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    let nextIdx = 0;
    for (const id of orderedIds) {
      const idx = nextIdx;
      const saved = await mutate(id, encryptionKey, dep => dep && { ...dep, sortIndex: idx });
      if (saved) nextIdx++;
    }
    await loadDependants();
  }, [mutate, encryptionKey, loadDependants]);

  const switchDependantPrimary = useCallback(async (pubkey: string, keypair: string, overrideEncryptionKey?: string) => {
    const key = overrideEncryptionKey || encryptionKey;
    if (!key) throw new Error('Encryption key required');
    await mutate(pubkey, key, dep => dep && { ...dep, primaryKeypair: keypair });
    await loadDependants();
  }, [mutate, encryptionKey, loadDependants]);

  const updateDependantPersonaName = useCallback(async (
    pubkey: string,
    target: 'natural-person' | 'persona' | string,
    name: string,
    overrideEncryptionKey?: string,
  ) => {
    const key = overrideEncryptionKey || encryptionKey;
    if (!key) throw new Error('Encryption key required');
    await mutate(pubkey, key, dep => dep && patchSlot(dep, target, { displayName: name }));
    await loadDependants();
  }, [mutate, encryptionKey, loadDependants]);

  /**
   * Activate a dependant's real identity (spec §7.6). Writes ONLY the legal
   * name and the flag. Derives nothing — the natural-person keypair has existed
   * since `addDependant` — and deliberately does NOT touch `primaryKeypair`, so
   * the child keeps landing and signing as their handle unless someone picks
   * the real identity for an eligible action.
   */
  const activateDependantNaturalPerson = useCallback(async (
    depId: string,
    legalName: string,
    overrideEncryptionKey?: string,
  ) => {
    const key = overrideEncryptionKey || encryptionKey;
    if (!key) throw new Error('Encryption key required');
    const name = sanitizeDisplayName(legalName, 100);
    if (!name) throw new Error('Enter their legal name');
    await mutate(depId, key, dep => {
      if (!dep) throw new Error('Dependant not found');
      if (!dep.naturalPerson.publicKey) {
        throw new Error('This dependant has no real-name key.');
      }
      return {
        ...dep,
        naturalPerson: { ...dep.naturalPerson, displayName: name },
        naturalPersonActive: true,
      };
    });
    await loadDependants();
  }, [mutate, encryptionKey, loadDependants]);

  const addDependantPersona = useCallback(async (
    pubkey: string,
    displayName: string,
    overrideEncryptionKey?: string,
    opts?: { deviceDerive?: ExtraPersonaDeviceDerive },
  ) => personaMutations.run(async () => {
    const key = overrideEncryptionKey || encryptionKey;
    if (!key) throw new Error('Encryption key required');
    const dep = (await loadFreshDependants(key)).find(d => d.id === pubkey);
    if (!dep) return;

    const derivationName = nextDependantPersonaName(dep);

    const { publicKey, privateKey } = opts?.deviceDerive
      ? await opts.deviceDerive(derivationName)
      : deriveExtraPersona(await loadGuardianMnemonic(key), derivationName);

    const newPersona: ExtraPersona = {
      publicKey,
      privateKey,
      displayName,
      derivationName,
    };

    // The derive above can take a device round trip: append to the record as it
    // is now, and not twice if a sync brought the same persona in meanwhile.
    await mutate(pubkey, key, cur => {
      if (!cur || (cur.extraPersonas ?? []).some(p => p.publicKey === publicKey)) return null;
      return { ...cur, extraPersonas: [...(cur.extraPersonas ?? []), newPersona] };
    });
    await loadDependants();
  }), [mutate, encryptionKey, loadFreshDependants, loadDependants, loadGuardianMnemonic]);

  /**
   * Toggle a persona's visibility on the paired-child device. `visible: true`
   * removes the pubkey from `hiddenOnPairedDeviceKeys`; `visible: false`
   * appends it (idempotent). NP is unhidable by construction — callers must
   * never pass the NP pubkey here. The persona-inventory publisher reads
   * the resulting list on next render and re-publishes the filtered
   * payload to the paired child.
   * See 2026-05-15-persona-inventory-sync-to-paired-child-design.md §2.2.
   */
  const updatePersonaVisibility = useCallback(async (
    depPubkey: string,
    personaPubkey: string,
    visible: boolean,
  ) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    await mutate(depPubkey, encryptionKey, dep => {
      if (!dep) return null;
      const current = dep.hiddenOnPairedDeviceKeys ?? [];
      const next: string[] = visible
        ? current.filter(k => k !== personaPubkey)
        : current.includes(personaPubkey) ? current : [...current, personaPubkey];
      return { ...dep, hiddenOnPairedDeviceKeys: next };
    });
    await loadDependants();
  }, [mutate, encryptionKey, loadDependants]);

  /**
   * Hard-delete an extra persona from a dependant record. Mirror of
   * useIdentity.removeExtraPersona — used by PersonaAdvanced's DeleteBlock
   * on dep extras. Caller does any best-effort relay retraction first
   * (PersonaAdvanced's onDeletePersona handler in App.tsx).
   */
  const removeDependantExtraPersona = useCallback(async (
    depPubkey: string,
    personaPubkey: string,
  ) => personaMutations.run(async () => {
    if (!encryptionKey) throw new Error('Encryption key required');
    let blobs: SlotBlobToDelete[] = [];
    const saved = await mutate(depPubkey, encryptionKey, dep => {
      if (!dep) return null;
      const persona = dep.extraPersonas?.find(p => p.publicKey === personaPubkey);
      if (!persona) return null;
      blobs = collectSlotBlobsToDelete(dep, ['avatar', 'backdrop'], [personaPubkey]);
      const extraPersonaTombstones = dependantPersonaTombstones(dep.derivationPath, [
        ...(dep.extraPersonaTombstones ?? []),
        { derivationName: persona.derivationName, removedAt: Date.now() },
      ]);
      return applyDependantPersonaTombstones({
        ...dep,
        extraPersonas: (dep.extraPersonas ?? []).filter(p => p.publicKey !== personaPubkey),
        extraPersonaTombstones,
        primaryKeypair: dep.primaryKeypair === personaPubkey ? 'persona' : dep.primaryKeypair,
      });
    });
    if (!saved) return { deletion: Promise.resolve() };
    // Sweep any §5.4.1 pre-auth records keyed on the removed persona so they
    // don't linger for up to 24h after the persona is gone. Best-effort —
    // an IDB hiccup here shouldn't block the reload.
    try {
      const dbMod = await import('../lib/db');
      await dbMod.deletePublicProfileSignAuthByPersona(depPubkey, personaPubkey);
    } catch { /* best-effort — 24h TTL is the fallback */ }
    // The persona is gone from the stored record: its avatar and backdrop
    // blobs go too (R1 still guards a blob another row references).
    const deletion = deleteGoneBlobs(blobs);
    await loadDependants();
    return { deletion };
  }), [mutate, encryptionKey, loadDependants, deleteGoneBlobs]);

  /**
   * Soft-delete a dep's extra persona via the `ExtraPersona.hidden` flag.
   * Mirror of `useIdentity.setExtraPersonaHidden` for the GUARDIAN-side
   * carousel — the guardian's carousel filter (`carousel-utils.ts`) reads
   * `ExtraPersona.hidden`, NOT `DependantIdentity.hiddenOnPairedDeviceKeys`
   * (that latter one filters what the PAIRED-CHILD device sees). The two
   * filters are intentionally separate. Use this helper to hide a dep
   * extra from the guardian's view; use `updatePersonaVisibility` to
   * hide from the kid's paired-device view.
   */
  const setDepExtraPersonaHidden = useCallback(async (
    depPubkey: string,
    personaPubkey: string,
    hidden: boolean,
  ) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    await mutate(depPubkey, encryptionKey, dep => dep && {
      ...dep,
      extraPersonas: (dep.extraPersonas ?? []).map(p => (p.publicKey === personaPubkey ? { ...p, hidden } : p)),
    });
    await loadDependants();
  }, [mutate, encryptionKey, loadDependants]);

  /**
   * Return the dependant's NIP-46 transport keypair, generating + persisting
   * a fresh one if this is the first pair. Private key is random (NOT derived
   * from mnemonic — re-pair generates a new transport identity). See
   * 2026-04-22 dependant-accounts spec §Path 2.
   */
  const ensureDependantBunkerEndpoint = useCallback(async (
    pubkey: string,
    overrideEncryptionKey?: string,
  ): Promise<DependantBunkerEndpoint> => {
    const key = overrideEncryptionKey || encryptionKey;
    if (!key) throw new Error('Encryption key required');
    const dep = dependants.find(d => d.id === pubkey);
    if (!dep) throw new Error('Dependant not found');
    // View-only dependants (imported without a mnemonic) have no signing
    // private key. Pairing a device to them would create a dead-letter
    // endpoint — the bunker would decrypt the transport envelope but
    // have no signing key for the inner template. Refuse upfront with a
    // clear message rather than minting a QR the child can never use.
    if (!dep.naturalPerson.privateKey) {
      throw new Error(`${dep.displayName} can't be paired — this dependant was imported without a signing key.`);
    }
    if (dep.bunkerEndpoint?.privateKey && dep.bunkerEndpoint?.publicKey) {
      return dep.bunkerEndpoint;
    }

    let endpoint: DependantBunkerEndpoint | undefined;
    await mutate(pubkey, key, cur => {
      if (!cur) throw new Error('Dependant not found');
      // Minted meanwhile (a second tap): keep that one.
      if (cur.bunkerEndpoint?.privateKey && cur.bunkerEndpoint?.publicKey) {
        endpoint = cur.bunkerEndpoint;
        return null;
      }
      const sk = generateSecretKey();
      const privHex = bytesToHex(sk);
      const pubHex = getPublicKey(sk);
      sk.fill(0);
      endpoint = {
        publicKey: pubHex,
        privateKey: privHex,
        createdAt: Math.floor(Date.now() / 1000),
      };
      return { ...cur, bunkerEndpoint: endpoint };
    });
    await loadDependants();
    if (!endpoint) throw new Error('Dependant not found');
    return endpoint;
  }, [mutate, dependants, encryptionKey, loadDependants]);

  /**
   * Persist a fresh pairing secret on the dependant's endpoint record so
   * the bunker server (which reads routes synchronously at inbound-event
   * time) can compare it against the `connect` secret. Called by the pair-
   * to-device UI on each secret mint / rotation.
   */
  const saveDependantPairingSecret = useCallback(async (
    pubkey: string,
    secret: string,
    overrideEncryptionKey?: string,
  ): Promise<void> => {
    const key = overrideEncryptionKey || encryptionKey;
    if (!key) throw new Error('Encryption key required');
    // Fresh-read the dep from IDB rather than the closure-captured `dependants`
    // array. PairDependantDevice calls `ensureDependantBunkerEndpoint` (which
    // appends `bunkerEndpoint` to the dep in IDB and schedules a React state
    // update) immediately before this — but `await loadDependants()` resolving
    // doesn't trigger a synchronous re-render, so our `useCallback` closure
    // still holds the PRE-ensure `dependants` array where the dep has no
    // `bunkerEndpoint` yet. That stale read would throw
    // `'Dependant has no bunker endpoint yet'`, the caller's `.catch(() => {})`
    // would swallow it, and the URI would carry a secret that exists only
    // in PairDependantDevice's React state — never persisted, so the bunker
    // server's route has no `pairingSecret` to validate against when the kid
    // connects. Mirrors the `loadGuardianMnemonic` fresh-decrypt pattern
    // documented at the top of this file. See internal tracker (kid pair
    // "pairing not active" — multi-word dep name was a separate fix).
    if (!guardianPubkey) throw new Error('Cannot save pairing secret: no guardian pubkey');
    const saved = await mutate(pubkey, key, dep => {
      if (!dep || !dep.bunkerEndpoint) throw new Error('Dependant has no bunker endpoint yet');
      if (dep.bunkerEndpoint.pairingSecret === secret) return null;
      return { ...dep, bunkerEndpoint: { ...dep.bunkerEndpoint, pairingSecret: secret } };
    });
    if (!saved) return;
    await loadDependants();
  }, [mutate, guardianPubkey, encryptionKey, loadDependants]);

  /**
   * Record the client pubkey that successfully completed a `connect`
   * handshake, and clear the one-shot pairing secret. Subsequent requests
   * from OTHER client pubkeys will be rejected server-side.
   */
  const bindDependantBunkerClient = useCallback(async (
    pubkey: string,
    clientPubkey: string,
    overrideEncryptionKey?: string,
  ): Promise<void> => {
    const key = overrideEncryptionKey || encryptionKey;
    if (!key) throw new Error('Encryption key required');
    const lcClient = clientPubkey.toLowerCase();
    // Snapshot the OLD authorizedClientPubkey BEFORE we overwrite. If a
    // non-empty old client is being replaced (re-pair to a different device
    // via a freshly-minted pairing secret), sweep its pre-auth records so the
    // old client can't auto-sign for the remainder of the 24h TTL. Mirrors
    // the sweep in `clearDependantBunkerEndpoint`.
    let oldClientPubkey: string | undefined;
    const saved = await mutate(pubkey, key, dep => {
      if (!dep || !dep.bunkerEndpoint) return null;
      // Idempotent — if the same client is already bound we're done.
      if (dep.bunkerEndpoint.authorizedClientPubkey === lcClient) return null;
      // Defence against double-bind race: if someone else is already bound
      // AND the pairing secret has been cleared, a concurrent connect
      // handler shouldn't silently overwrite the binding. The server-side
      // bindingInFlightRef catches most cases; reading the record fresh in
      // the write queue closes the rest.
      if (dep.bunkerEndpoint.authorizedClientPubkey && !dep.bunkerEndpoint.pairingSecret) return null;
      oldClientPubkey = dep.bunkerEndpoint.authorizedClientPubkey;
      return {
        ...dep,
        bunkerEndpoint: {
          ...dep.bunkerEndpoint,
          authorizedClientPubkey: lcClient,
          pairingSecret: undefined, // one-shot — clear after first successful bind
        },
      };
    });
    if (!saved) return;
    if (oldClientPubkey && oldClientPubkey !== lcClient) {
      try {
        const dbMod = await import('../lib/db');
        await dbMod.deletePublicProfileSignAuthByClient(pubkey, oldClientPubkey);
      } catch {
        // Best-effort. Worst case the old records expire via their 24h TTL.
      }
    }
    await loadDependants();
  }, [mutate, encryptionKey, loadDependants]);

  /**
   * Clear the dependant's NIP-46 transport keypair (revoke). Any paired child
   * device loses its ability to reach the bunker until a fresh pair.
   *
   * Security: sweeps any `publicProfileSignAuth` records keyed on the
   * outgoing `authorizedClientPubkey`. Without this, an attacker who
   * captured the old client pubkey (e.g. via a compromised paired device)
   * could continue to auto-sign kind-0 / kind-5 events for up to the
   * record TTL (24h) even after the endpoint is revoked. See security
   * audit 2026-05-18.
   */
  const clearDependantBunkerEndpoint = useCallback(async (
    pubkey: string,
    overrideEncryptionKey?: string,
  ): Promise<void> => {
    const key = overrideEncryptionKey || encryptionKey;
    if (!key) throw new Error('Encryption key required');
    let oldClientPubkey: string | undefined;
    let blobs: SlotBlobToDelete[] = [];
    const saved = await mutate(pubkey, key, dep => {
      if (!dep || !dep.bunkerEndpoint) return null;
      oldClientPubkey = dep.bunkerEndpoint.authorizedClientPubkey;
      // The phone is unpaired: what was sent to it goes with it. The pointers
      // are cleared in the same write; the guardian's own `backdrop:` rows and
      // every avatar stay, so the cards still show (a re-pair reads as unsent).
      blobs = collectSlotBlobsToDelete(dep, ['backdrop']);
      // A send still uploading must not save a pointer after this.
      supersedeBackdropSends(dep.id, slotTargetsOf(dep));
      return { ...(withoutBackdropPointers(dep) ?? dep), bunkerEndpoint: undefined };
    });
    if (!saved) return;
    void deleteGoneBlobs(blobs);
    // Sweep pre-auth records bound to the outgoing client pubkey BEFORE
    // anyone can mint a new endpoint. Skipped when the old endpoint had
    // never completed a `connect` handshake (no client pubkey, no records).
    // Wrapped in try/catch to mirror `bindDependantBunkerClient` — an IDB
    // error in the sweep must not block the loadDependants() refresh.
    if (oldClientPubkey) {
      try {
        await deletePublicProfileSignAuthByClient(pubkey, oldClientPubkey);
      } catch {
        // Best-effort. Worst case the old records expire via their 24h TTL.
      }
    }
    await loadDependants();
  }, [mutate, encryptionKey, loadDependants, deleteGoneBlobs]);

  /**
   * Unpair side of the card backdrops: clear every slot's sent-backdrop
   * pointer (the child's phone no longer gets it) and delete the blobs behind
   * them, once the record has saved. The guardian's own `backdrop:` rows and
   * every avatar are untouched, so the cards still show; a re-pair finds the
   * slots unsent and the backfill sends them again. Best effort: resolves
   * either way, and never throws (an unpair must not fail on a picture).
   */
  const clearDependantBackdrops = useCallback(async (depId: string): Promise<void> => {
    const key = liveKeyRef.current;
    if (!key) return;
    let blobs: SlotBlobToDelete[] = [];
    try {
      const saved = await mutate(depId, key, dep => {
        if (!dep) return null;
        // Checked after the write queue's wait: a lock during it saves nothing.
        if (liveKeyRef.current !== key) throw new Error('Encryption key required');
        blobs = collectSlotBlobsToDelete(dep, ['backdrop']);
        supersedeBackdropSends(dep.id, slotTargetsOf(dep));
        return withoutBackdropPointers(dep);
      });
      if (!saved) return;
    } catch {
      return;
    }
    void deleteGoneBlobs(blobs);
    if (liveKeyRef.current === key) await loadDependants();
  }, [mutate, loadDependants, deleteGoneBlobs]);

  /** `mutate` for App-level writers (child-device fields, the migration strip). */
  const mutateDependantRecord = useCallback((
    depId: string,
    key: string,
    fn: (dep: DependantIdentity | null) => DependantIdentity | null,
  ) => mutate(depId, key, fn), [mutate]);

  return { dependants, loading, loadedWithKey, addDependant, importDependant, removeDependant, updateAutonomyStage, updateAuditVisibility, updatePetitionOnDeny, updateDependantName, updateDependantPhoto, switchDependantPrimary, updateDependantPersonaName, activateDependantNaturalPerson, addDependantPersona, updatePersonaVisibility, setDepExtraPersonaHidden, removeDependantExtraPersona, reorderDependants, ensureDependantBunkerEndpoint, clearDependantBunkerEndpoint, clearDependantBackdrops, saveDependantPairingSecret, bindDependantBunkerClient, setDependantPersonaAvatar, clearDependantPersonaAvatar, setDependantPersonaContactAvatar, clearDependantPersonaContactAvatar, setDependantPersonaBackdrop, setDependantPersonaPublicProfile, clearDependantPersonaPublicProfile, setDependantSlotNip05Check, reload: loadDependants, loadFreshDependants, mutateDependantRecord };
}
