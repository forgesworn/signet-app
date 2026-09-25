import { useState, useEffect, useCallback } from 'react';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { DependantIdentity, AutonomyStage, ExtraPersona, DependantBunkerEndpoint } from '../types';
import type { AuditVisibilityOverride } from '../lib/audit-visibility';
import { getDependants, saveDependant, deleteDependant, deleteGrantsForDependant, loadIdentityDecrypted, deletePublicProfileSignAuthByClient } from '../lib/db';
import { deriveDependantIdentity, importFromMnemonic, deriveExtraPersona } from '../lib/signet';
import { liftDependantPublicProfileConfig } from '../lib/lift-public-profile-config';
import { liftDependantNaturalPersonActive } from '../lib/lift-natural-person-active';
import { isDependantNaturalPersonActive } from '../lib/identity-display';
import { buildPersonaFirstDependant } from '../lib/dependant-record';
import { nextDependantIndex } from '../lib/heartwood-dependant-create';
import type { DerivedKeypair, ExtraPersonaDeviceDerive } from '../lib/heartwood-dependant-create';
import type { Nip05CheckResult } from '../lib/nip05-check';
import { nextDependantPersonaName, dependantPersonaTombstones, applyDependantPersonaTombstones } from '../lib/dependant-persona-allocation';
import { createSerialQueue } from '../lib/contacts-v2-queue';
import { sanitizeDisplayName } from '../lib/text-sanitize';

// Serialize allocation/deletion across hook instances in this app.
const personaMutations = createSerialQueue();

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
    if (!guardianPubkey) {
      setDependants([]);
      setLoading(false);
      return;
    }
    const results = await getDependants(guardianPubkey, encryptionKey ?? undefined);
    setDependants(migrateAndSort(results));
    setLoading(false);
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

    const derivationPath = `dependant-${nextDependantIndex(dependants)}`;

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

  const removeDependant = useCallback(async (pubkey: string) => {
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
    const dep = dependants.find(d => d.id === pubkey);
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
    await loadDependants();
  }, [dependants, loadDependants]);

  const updateAutonomyStage = useCallback(async (pubkey: string, stage: AutonomyStage) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    const dep = dependants.find(d => d.id === pubkey);
    if (!dep) return;
    const updated = { ...dep, autonomyStage: stage };
    await saveDependant(updated, encryptionKey);
    await loadDependants();
  }, [dependants, encryptionKey, loadDependants]);

  /**
   * Set (or replace) the avatar for one of a dependant's persona slots
   * (NP, persona, or an extra-persona pubkey). Caller has uploaded the
   * encrypted blob to Blossom and is passing the resulting metadata
   * `{ hash, blossomUrl, keyHex, updatedAt }`. The `keyHex` gets
   * encrypted at rest by `saveDependant`, same pattern as the dep's
   * keypair `privateKey`.
   *
   * Mirrors `useIdentity.setPersonaAvatar` but for the guardian's
   * deps. Reads the dep fresh from the React-state `dependants` array
   * rather than re-decrypting from IDB — the caller is the guardian
   * (always unlocked when invoked) and the array is the live source
   * of truth.
   */
  const setDependantPersonaAvatar = useCallback(async (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
    avatar: { hash: string; blossomUrl: string; keyHex: string; updatedAt: number },
  ) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    const dep = dependants.find(d => d.id === depPubkey);
    if (!dep) return;
    let updated: DependantIdentity;
    if (target === 'natural-person') {
      updated = {
        ...dep,
        naturalPerson: {
          ...dep.naturalPerson,
          avatarHash: avatar.hash,
          avatarBlossomUrl: avatar.blossomUrl,
          avatarKey: avatar.keyHex,
          avatarUpdatedAt: avatar.updatedAt,
        },
      };
    } else if (target === 'persona') {
      updated = {
        ...dep,
        persona: {
          ...dep.persona,
          avatarHash: avatar.hash,
          avatarBlossomUrl: avatar.blossomUrl,
          avatarKey: avatar.keyHex,
          avatarUpdatedAt: avatar.updatedAt,
        },
      };
    } else {
      const extras = (dep.extraPersonas ?? []).map(p =>
        p.publicKey === target
          ? {
              ...p,
              avatarHash: avatar.hash,
              avatarBlossomUrl: avatar.blossomUrl,
              avatarKey: avatar.keyHex,
              avatarUpdatedAt: avatar.updatedAt,
            }
          : p,
      );
      updated = { ...dep, extraPersonas: extras };
    }
    await saveDependant(updated, encryptionKey);
    await loadDependants();
  }, [dependants, encryptionKey, loadDependants]);

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
  ) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    const dep = dependants.find(d => d.id === depPubkey);
    if (!dep) return;

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

    let updated: DependantIdentity;
    let personaPubkey: string;
    if (target === 'natural-person') {
      updated = { ...dep, naturalPerson: { ...dep.naturalPerson, ...cfgPatch, ...nip05CheckClear(dep.naturalPerson.nip05), publicProfile: ppValue } };
      personaPubkey = dep.naturalPerson.publicKey;
    } else if (target === 'persona') {
      updated = { ...dep, persona: { ...dep.persona, ...cfgPatch, ...nip05CheckClear(dep.persona.nip05), publicProfile: ppValue } };
      personaPubkey = dep.persona.publicKey;
    } else {
      const extras = (dep.extraPersonas ?? []).map(p =>
        p.publicKey === target ? { ...p, ...cfgPatch, ...nip05CheckClear(p.nip05), publicProfile: ppValue } : p,
      );
      updated = { ...dep, extraPersonas: extras };
      personaPubkey = target;
    }
    await saveDependant(updated, encryptionKey);

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
            dbMod.savePublicProfileSignAuth(dep.id, personaPubkey, kidClientPubkey, 0),
            dbMod.savePublicProfileSignAuth(dep.id, personaPubkey, kidClientPubkey, 5),
          ]);
        } else {
          await Promise.all([
            dbMod.deletePublicProfileSignAuth(dep.id, personaPubkey, kidClientPubkey, 0),
            dbMod.deletePublicProfileSignAuth(dep.id, personaPubkey, kidClientPubkey, 5),
          ]);
        }
      } catch {
        // Pre-auth provisioning is best-effort — failure means kid's next
        // publish prompts the guardian as a regular sign_event, which is
        // the safe fallback (manual approval).
      }
    }

    await loadDependants();
  }, [dependants, encryptionKey, guardianPubkey, loadDependants]);

  /** Clear dep persona public-profile config. */
  const clearDependantPersonaPublicProfile = useCallback(async (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
  ) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    const dep = dependants.find(d => d.id === depPubkey);
    if (!dep) return;
    let updated: DependantIdentity;
    if (target === 'natural-person') {
      updated = { ...dep, naturalPerson: { ...dep.naturalPerson, publicProfile: undefined } };
    } else if (target === 'persona') {
      updated = { ...dep, persona: { ...dep.persona, publicProfile: undefined } };
    } else {
      const extras = (dep.extraPersonas ?? []).map(p =>
        p.publicKey === target ? { ...p, publicProfile: undefined } : p,
      );
      updated = { ...dep, extraPersonas: extras };
    }
    await saveDependant(updated, encryptionKey);
    await loadDependants();
  }, [dependants, encryptionKey, loadDependants]);

  /** Remove avatar metadata from a dep persona slot. Blossom blob is left
   *  in place (already encrypted; cleanup not required). */
  const clearDependantPersonaAvatar = useCallback(async (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
  ) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    const dep = dependants.find(d => d.id === depPubkey);
    if (!dep) return;
    const cleared = {
      avatarHash: undefined,
      avatarBlossomUrl: undefined,
      avatarKey: undefined,
      avatarUpdatedAt: undefined,
    };
    let updated: DependantIdentity;
    if (target === 'natural-person') {
      updated = { ...dep, naturalPerson: { ...dep.naturalPerson, ...cleared } };
    } else if (target === 'persona') {
      updated = { ...dep, persona: { ...dep.persona, ...cleared } };
    } else {
      const extras = (dep.extraPersonas ?? []).map(p =>
        p.publicKey === target ? { ...p, ...cleared } : p,
      );
      updated = { ...dep, extraPersonas: extras };
    }
    await saveDependant(updated, encryptionKey);
    await loadDependants();
  }, [dependants, encryptionKey, loadDependants]);

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
    const all = await getDependants(guardianPubkey, encryptionKey);
    const dep = all.find(d => d.id === depPubkey);
    if (!dep) return;
    const patch = {
      contactAvatarKey: contact.contactAvatarKey,
      contactAvatarHash: contact.contactAvatarHash,
      contactAvatarBlossomUrl: contact.contactAvatarBlossomUrl,
      contactAvatarUpdatedAt: contact.contactAvatarUpdatedAt,
      contactAvatarStale: contact.contactAvatarStale,
    };
    let updated: DependantIdentity;
    if (target === 'natural-person') {
      updated = { ...dep, naturalPerson: { ...dep.naturalPerson, ...patch } };
    } else if (target === 'persona') {
      updated = { ...dep, persona: { ...dep.persona, ...patch } };
    } else {
      const extras = (dep.extraPersonas ?? []).map(p =>
        p.publicKey === target ? { ...p, ...patch } : p,
      );
      updated = { ...dep, extraPersonas: extras };
    }
    await saveDependant(updated, encryptionKey);
    await loadDependants();
  }, [guardianPubkey, encryptionKey, loadDependants]);

  /** Remove contact-card avatar metadata from a dep persona slot. Blossom
   *  blob is left in place (already encrypted; cleanup not required).
   *  Reads the dep FRESH from IDB for the same stale-snapshot reason as
   *  `setDependantPersonaContactAvatar` (C1). */
  const clearDependantPersonaContactAvatar = useCallback(async (
    depPubkey: string,
    target: 'natural-person' | 'persona' | string,
  ) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    if (!guardianPubkey) return;
    const all = await getDependants(guardianPubkey, encryptionKey);
    const dep = all.find(d => d.id === depPubkey);
    if (!dep) return;
    const patch = {
      contactAvatarKey: undefined,
      contactAvatarHash: undefined,
      contactAvatarBlossomUrl: undefined,
      contactAvatarUpdatedAt: undefined,
      contactAvatarStale: undefined,
    };
    let updated: DependantIdentity;
    if (target === 'natural-person') {
      updated = { ...dep, naturalPerson: { ...dep.naturalPerson, ...patch } };
    } else if (target === 'persona') {
      updated = { ...dep, persona: { ...dep.persona, ...patch } };
    } else {
      const extras = (dep.extraPersonas ?? []).map(p =>
        p.publicKey === target ? { ...p, ...patch } : p,
      );
      updated = { ...dep, extraPersonas: extras };
    }
    await saveDependant(updated, encryptionKey);
    await loadDependants();
  }, [guardianPubkey, encryptionKey, loadDependants]);

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
    const all = await getDependants(guardianPubkey, encryptionKey);
    const dep = all.find(d => d.id === depPubkey);
    if (!dep) return;
    const patch = { nip05CheckResult: check.result, nip05CheckedAt: check.checkedAt };
    let updated: DependantIdentity;
    if (target === 'natural-person') {
      updated = { ...dep, naturalPerson: { ...dep.naturalPerson, ...patch } };
    } else if (target === 'persona') {
      updated = { ...dep, persona: { ...dep.persona, ...patch } };
    } else {
      const extras = (dep.extraPersonas ?? []).map(p =>
        p.publicKey === target ? { ...p, ...patch } : p,
      );
      updated = { ...dep, extraPersonas: extras };
    }
    await saveDependant(updated, encryptionKey);
    await loadDependants();
  }, [guardianPubkey, encryptionKey, loadDependants]);

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
    const dep = dependants.find(d => d.id === pubkey);
    if (!dep) return;
    const updated: DependantIdentity = { ...dep, auditVisibility: override };
    await saveDependant(updated, encryptionKey);
    await loadDependants();
  }, [dependants, encryptionKey, loadDependants]);

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
    const dep = dependants.find(d => d.id === pubkey);
    if (!dep) return;
    const updated: DependantIdentity = { ...dep, petitionOnDeny: on };
    await saveDependant(updated, encryptionKey);
    await loadDependants();
  }, [dependants, encryptionKey, loadDependants]);

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
    const dep = dependants.find(d => d.id === pubkey);
    if (!dep) return;
    const updated: DependantIdentity = {
      ...dep,
      photoHash,
      blossomUrl,
      photoKey,
      photoUpdatedAt: Math.floor(Date.now() / 1000),
    };
    await saveDependant(updated, encryptionKey);
    await loadDependants();
  }, [dependants, encryptionKey, loadDependants]);

  const updateDependantName = useCallback(async (pubkey: string, displayName: string) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    const dep = dependants.find(d => d.id === pubkey);
    if (!dep) return;
    // The top-level label is the guardian-private family label. It may also be
    // the NP's display name — but ONLY for an already-active real identity.
    // Writing it onto a dormant slot would name the real identity behind the
    // guardian's back and (pre-lift records aside) flip it active.
    const updated = isDependantNaturalPersonActive(dep)
      ? { ...dep, displayName, naturalPerson: { ...dep.naturalPerson, displayName } }
      : { ...dep, displayName };
    await saveDependant(updated, encryptionKey);
    await loadDependants();
  }, [dependants, encryptionKey, loadDependants]);

  /**
   * Reorder dependants in the carousel parent ring. Writes a sortIndex
   * onto each dep matching its position in `orderedIds`. Dependants not
   * in the list keep their existing sortIndex (or remain unsorted) and
   * fall through to the bottom — never silently dropped, even if the
   * caller's view is stale (e.g. a sync arrived mid-edit).
   */
  const reorderDependants = useCallback(async (orderedIds: string[]) => {
    if (!encryptionKey) throw new Error('Encryption key required');
    const byId = new Map(dependants.map(d => [d.id, d]));
    let nextIdx = 0;
    for (const id of orderedIds) {
      const dep = byId.get(id);
      if (!dep) continue;
      const updated = { ...dep, sortIndex: nextIdx };
      await saveDependant(updated, encryptionKey);
      nextIdx++;
    }
    await loadDependants();
  }, [dependants, encryptionKey, loadDependants]);

  const switchDependantPrimary = useCallback(async (pubkey: string, keypair: string, overrideEncryptionKey?: string) => {
    const key = overrideEncryptionKey || encryptionKey;
    if (!key) throw new Error('Encryption key required');
    const dep = dependants.find(d => d.id === pubkey);
    if (!dep) return;
    const updated = { ...dep, primaryKeypair: keypair };
    await saveDependant(updated, key);
    await loadDependants();
  }, [dependants, encryptionKey, loadDependants]);

  const updateDependantPersonaName = useCallback(async (
    pubkey: string,
    target: 'natural-person' | 'persona' | string,
    name: string,
    overrideEncryptionKey?: string,
  ) => {
    const key = overrideEncryptionKey || encryptionKey;
    if (!key) throw new Error('Encryption key required');
    const dep = dependants.find(d => d.id === pubkey);
    if (!dep) return;

    let updated: DependantIdentity;
    if (target === 'natural-person') {
      updated = { ...dep, naturalPerson: { ...dep.naturalPerson, displayName: name } };
    } else if (target === 'persona') {
      updated = { ...dep, persona: { ...dep.persona, displayName: name } };
    } else {
      const extras = (dep.extraPersonas ?? []).map(p =>
        p.publicKey === target ? { ...p, displayName: name } : p,
      );
      updated = { ...dep, extraPersonas: extras };
    }

    await saveDependant(updated, key);
    await loadDependants();
  }, [dependants, encryptionKey, loadDependants]);

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
    const fresh = await loadFreshDependants(key);
    const dep = fresh.find(d => d.id === depId);
    if (!dep) throw new Error('Dependant not found');
    if (!dep.naturalPerson.publicKey) {
      throw new Error('This dependant has no real-name key.');
    }
    await saveDependant({
      ...dep,
      naturalPerson: { ...dep.naturalPerson, displayName: name },
      naturalPersonActive: true,
    }, key);
    await loadDependants();
  }, [encryptionKey, loadFreshDependants, loadDependants]);

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

    const updated = {
      ...dep,
      extraPersonas: [...(dep.extraPersonas ?? []), newPersona],
    };

    await saveDependant(updated, key);
    await loadDependants();
  }), [encryptionKey, loadFreshDependants, loadDependants, loadGuardianMnemonic]);

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
    const dep = dependants.find(d => d.id === depPubkey);
    if (!dep) return;
    const current = dep.hiddenOnPairedDeviceKeys ?? [];
    const next: string[] = visible
      ? current.filter(k => k !== personaPubkey)
      : current.includes(personaPubkey) ? current : [...current, personaPubkey];
    const updated: DependantIdentity = { ...dep, hiddenOnPairedDeviceKeys: next };
    await saveDependant(updated, encryptionKey);
    await loadDependants();
  }, [dependants, encryptionKey, loadDependants]);

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
    const dep = (await loadFreshDependants(encryptionKey)).find(d => d.id === depPubkey);
    if (!dep) return;
    const persona = dep.extraPersonas?.find(p => p.publicKey === personaPubkey);
    if (!persona) return;
    const extraPersonaTombstones = dependantPersonaTombstones(dep.derivationPath, [
      ...(dep.extraPersonaTombstones ?? []),
      { derivationName: persona.derivationName, removedAt: Date.now() },
    ]);
    const updated = applyDependantPersonaTombstones({
      ...dep,
      extraPersonas: (dep.extraPersonas ?? []).filter(p => p.publicKey !== personaPubkey),
      extraPersonaTombstones,
      primaryKeypair: dep.primaryKeypair === personaPubkey ? 'persona' : dep.primaryKeypair,
    });
    await saveDependant(updated, encryptionKey);
    // Sweep any §5.4.1 pre-auth records keyed on the removed persona so they
    // don't linger for up to 24h after the persona is gone. Best-effort —
    // an IDB hiccup here shouldn't block the reload.
    try {
      const dbMod = await import('../lib/db');
      await dbMod.deletePublicProfileSignAuthByPersona(depPubkey, personaPubkey);
    } catch { /* best-effort — 24h TTL is the fallback */ }
    await loadDependants();
  }), [encryptionKey, loadFreshDependants, loadDependants]);

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
    const dep = dependants.find(d => d.id === depPubkey);
    if (!dep) return;
    const extras = (dep.extraPersonas ?? []).map(p =>
      p.publicKey === personaPubkey ? { ...p, hidden } : p,
    );
    const updated: DependantIdentity = { ...dep, extraPersonas: extras };
    await saveDependant(updated, encryptionKey);
    await loadDependants();
  }, [dependants, encryptionKey, loadDependants]);

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

    const sk = generateSecretKey();
    const privHex = bytesToHex(sk);
    const pubHex = getPublicKey(sk);
    sk.fill(0);

    const endpoint: DependantBunkerEndpoint = {
      publicKey: pubHex,
      privateKey: privHex,
      createdAt: Math.floor(Date.now() / 1000),
    };
    const updated: DependantIdentity = { ...dep, bunkerEndpoint: endpoint };
    await saveDependant(updated, key);
    await loadDependants();
    return endpoint;
  }, [dependants, encryptionKey, loadDependants]);

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
    const fresh = await getDependants(guardianPubkey, key);
    const dep = fresh.find(d => d.id === pubkey);
    if (!dep || !dep.bunkerEndpoint) throw new Error('Dependant has no bunker endpoint yet');
    if (dep.bunkerEndpoint.pairingSecret === secret) return;
    const updated: DependantIdentity = {
      ...dep,
      bunkerEndpoint: { ...dep.bunkerEndpoint, pairingSecret: secret },
    };
    await saveDependant(updated, key);
    await loadDependants();
  }, [guardianPubkey, encryptionKey, loadDependants]);

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
    const dep = dependants.find(d => d.id === pubkey);
    if (!dep || !dep.bunkerEndpoint) return;
    const lcClient = clientPubkey.toLowerCase();
    // Idempotent — if the same client is already bound we're done.
    if (dep.bunkerEndpoint.authorizedClientPubkey === lcClient) return;
    // Defence against double-bind race: if someone else is already bound
    // AND the pairing secret has been cleared, a concurrent connect
    // handler shouldn't silently overwrite the binding. The server-side
    // bindingInFlightRef catches most cases, but this is belt-and-braces
    // in case two React state ticks both see a stale `dependants` array.
    if (dep.bunkerEndpoint.authorizedClientPubkey && !dep.bunkerEndpoint.pairingSecret) {
      return;
    }
    // Snapshot the OLD authorizedClientPubkey BEFORE we overwrite. If a
    // non-empty old client is being replaced (re-pair to a different device
    // via a freshly-minted pairing secret), sweep its pre-auth records so the
    // old client can't auto-sign for the remainder of the 24h TTL. Mirrors
    // the sweep in `clearDependantBunkerEndpoint`.
    const oldClientPubkey = dep.bunkerEndpoint.authorizedClientPubkey;
    const updated: DependantIdentity = {
      ...dep,
      bunkerEndpoint: {
        ...dep.bunkerEndpoint,
        authorizedClientPubkey: lcClient,
        pairingSecret: undefined, // one-shot — clear after first successful bind
      },
    };
    await saveDependant(updated, key);
    if (oldClientPubkey && oldClientPubkey !== lcClient) {
      try {
        const dbMod = await import('../lib/db');
        await dbMod.deletePublicProfileSignAuthByClient(dep.id, oldClientPubkey);
      } catch {
        // Best-effort. Worst case the old records expire via their 24h TTL.
      }
    }
    await loadDependants();
  }, [dependants, encryptionKey, loadDependants]);

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
    const dep = dependants.find(d => d.id === pubkey);
    if (!dep || !dep.bunkerEndpoint) return;
    const oldClientPubkey = dep.bunkerEndpoint.authorizedClientPubkey;
    const updated: DependantIdentity = { ...dep, bunkerEndpoint: undefined };
    await saveDependant(updated, key);
    // Sweep pre-auth records bound to the outgoing client pubkey BEFORE
    // anyone can mint a new endpoint. Skipped when the old endpoint had
    // never completed a `connect` handshake (no client pubkey, no records).
    // Wrapped in try/catch to mirror `bindDependantBunkerClient` — an IDB
    // error in the sweep must not block the loadDependants() refresh.
    if (oldClientPubkey) {
      try {
        await deletePublicProfileSignAuthByClient(dep.id, oldClientPubkey);
      } catch {
        // Best-effort. Worst case the old records expire via their 24h TTL.
      }
    }
    await loadDependants();
  }, [dependants, encryptionKey, loadDependants]);


  return { dependants, loading, addDependant, importDependant, removeDependant, updateAutonomyStage, updateAuditVisibility, updatePetitionOnDeny, updateDependantName, updateDependantPhoto, switchDependantPrimary, updateDependantPersonaName, activateDependantNaturalPerson, addDependantPersona, updatePersonaVisibility, setDepExtraPersonaHidden, removeDependantExtraPersona, reorderDependants, ensureDependantBunkerEndpoint, clearDependantBunkerEndpoint, saveDependantPairingSecret, bindDependantBunkerClient, setDependantPersonaAvatar, clearDependantPersonaAvatar, setDependantPersonaContactAvatar, clearDependantPersonaContactAvatar, setDependantPersonaPublicProfile, clearDependantPersonaPublicProfile, setDependantSlotNip05Check, reload: loadDependants, loadFreshDependants };
}
