import { useState, useEffect, useCallback, useRef } from 'react';
import type { SignetIdentity, ExtraPersona, ExtraPersonaTombstone, RemotePersonasPatch } from '../types';
import * as db from '../lib/db';
import { createNewIdentity, importFromMnemonic, importFromNsec, importFromLiteMnemonic, deriveExtraPersona } from '../lib/signet';
import type { ExtraPersonaDeviceDerive } from '../lib/heartwood-dependant-create';
import type { RestoredProfile } from '../lib/profile-restore';
import { deriveProfessionalPersona } from '../lib/professional/pro-persona';
import { liftPublicProfileConfig } from '../lib/lift-public-profile-config';
import { liftNaturalPersonActive } from '../lib/lift-natural-person-active';
import { applyRemotePersonasPatch } from '../lib/apply-remote-personas';
import { sanitizeDisplayName } from '../lib/text-sanitize';
import type { Nip05CheckResult } from '../lib/nip05-check';

/**
 * Derive the Professional Persona keypair from the identity's mnemonic and
 * persist it encrypted. If already present on the identity record, returns
 * the existing keypair without re-deriving or re-storing.
 * Called on first entry to Pro-surface onboarding (§4.5.3 — silent, no UI).
 */
export async function deriveAndStoreProPersona(
  identity: SignetIdentity,
  encKey: string,
): Promise<{ publicKey: string; privateKey: string; displayName: string }> {
  if (identity.professionalPersona) {
    return identity.professionalPersona;
  }
  const keypair = deriveProfessionalPersona(identity.mnemonic);
  // Default displayName to NP displayName on first creation (§4.5.4).
  keypair.displayName = identity.naturalPerson.displayName;
  await db.saveProPersonaEncrypted(keypair.privateKey, encKey);
  return keypair;
}

export function useIdentity(encryptionKey?: string | null) {
  const [identities, setIdentities] = useState<SignetIdentity[]>([]);
  const [activeIdentity, setActiveIdentity] = useState<SignetIdentity | null>(null);
  // Start loading as true and only flip to false after the first DB read completes.
  // This prevents the onboarding screen from flashing while IndexedDB is being read.
  const [loading, setLoading] = useState(true);
  const hasLoadedOnce = useRef(false);

  const loadAll = useCallback(async () => {
    const raw = await db.getAllIdentities();
    let all = raw;
    if (encryptionKey) {
      const decrypted = await Promise.all(raw.map(async (identity) => {
        if (!identity.encrypted) return identity;
        try {
          return await db.loadIdentityDecrypted(identity.id, encryptionKey) || null;
        } catch {
          return null; // skip identities that fail decryption
        }
      }));
      // Lift any legacy publicProfile.{name,displayName,about,...} fields up
      // to the slot top-level on every decrypt — idempotent, safe to call on
      // already-lifted records. See 2026-05-17 persona-card-as-source-of-truth
      // design §6 migration / lift-public-profile-config.ts.
      const migrated = decrypted.map(
        i => i ? liftNaturalPersonActive(liftPublicProfileConfig(i)) : null,
      );
      all = migrated.filter((i): i is import('../types').SignetIdentity => i !== null);
    }
    setIdentities(all);
    const prefs = await db.getPreferences();
    const active = prefs.activeAccountId
      ? all.find(i => i.id === prefs.activeAccountId) || all[0]
      : all[0];
    setActiveIdentity(active || null);
    // M9: must also be set here, not just in loadPublic — otherwise a
    // device that unlocks on first mount (before loadPublic ever runs,
    // e.g. biometric auto-unlock) never trips the "lock" branch below on
    // its FIRST lock, and the synchronous state-clear is skipped.
    hasLoadedOnce.current = true;
    setLoading(false);
  }, [encryptionKey]);

  // Load public identity data (no decryption) on mount, even without encryption key.
  // When encryption key is provided, reload with decrypted private keys.
  const loadPublic = useCallback(async () => {
    // db.getAllIdentities() already excludes the bunkerSecret/
    // professionalPersona marker rows and dependant:-prefixed
    // DependantIdentity rows (2026-07-02 audit) — no further filtering needed.
    const identityRecords = await db.getAllIdentities();
    setIdentities(identityRecords);
    const prefs = await db.getPreferences();
    const active = prefs.activeAccountId
      ? identityRecords.find(i => i.id === prefs.activeAccountId) || identityRecords[0]
      : identityRecords[0];
    setActiveIdentity(active || null);
    hasLoadedOnce.current = true;
    setLoading(false);
  }, []);

  useEffect(() => {
    if (encryptionKey) {
      loadAll();
    } else if (hasLoadedOnce.current) {
      // encryptionKey cleared (lock). M9 (2026-07-02 audit): clear the
      // decrypted state SYNCHRONOUSLY first — `loadPublic()` below is
      // async (awaits an IndexedDB read), and until it resolves,
      // `identities`/`activeIdentity` would otherwise keep holding the
      // mnemonic + private keys from the previous unlock in React state.
      // That's a window where "locked" (encryptionKey null) doesn't
      // match what's actually still in memory, contradicting this
      // repo's convention that React state clears immediately on lock.
      setIdentities([]);
      setActiveIdentity(null);
      loadPublic();
    } else {
      // First mount — load public data from IndexedDB
      loadPublic();
    }
  }, [loadAll, loadPublic, encryptionKey]);

  const create = useCallback(async (
    displayName: string,
    primaryKeypair: 'natural-person' | 'persona',
    isChild: boolean,
    guardianPubkey?: string,
    overrideEncryptionKey?: string,
  ) => {
    const identity = createNewIdentity(displayName, primaryKeypair, isChild, guardianPubkey);
    const key = overrideEncryptionKey || encryptionKey;
    if (!key) throw new Error('Encryption key required');
    await db.saveIdentityEncrypted(identity, key);
    await db.savePreferences({ ...(await db.getPreferences()), activeAccountId: identity.id });
    await loadAll();
    return identity;
  }, [loadAll, encryptionKey]);

  const restore = useCallback(async (
    mnemonic: string,
    displayName: string,
    primaryKeypair: 'natural-person' | 'persona',
    isChild: boolean,
    guardianPubkey?: string,
    overrideEncryptionKey?: string,
  ) => {
    const identity = importFromMnemonic(mnemonic, displayName, primaryKeypair, isChild, guardianPubkey);
    const key = overrideEncryptionKey || encryptionKey;
    if (!key) throw new Error('Encryption key required');
    await db.saveIdentityEncrypted(identity, key);
    await db.savePreferences({ ...(await db.getPreferences()), activeAccountId: identity.id });
    await loadAll();
    return identity;
  }, [loadAll, encryptionKey]);

  /**
   * Restore from a mnemonic using a profile fetched from the relay.
   * Populates NP + persona display names from their kind-0 events and
   * re-derives every extra persona that was previously published.
   */
  const restoreWithProfile = useCallback(async (
    mnemonic: string,
    profile: RestoredProfile,
    overrideEncryptionKey?: string,
  ) => {
    const key = overrideEncryptionKey || encryptionKey;
    if (!key) throw new Error('Encryption key required');

    const npName = profile.naturalPerson?.displayName ?? '';
    const personaName = profile.persona?.displayName ?? '';

    // importFromMnemonic only fills the primary keypair's name — we also
    // want the secondary name from the profile so the user sees both
    // identities populated on restore.
    const primaryName = profile.primaryKeypair === 'natural-person' ? npName : personaName;
    const base = importFromMnemonic(mnemonic, primaryName, profile.primaryKeypair, false, undefined);

    const identity: SignetIdentity = {
      ...base,
      naturalPerson: { ...base.naturalPerson, displayName: npName },
      persona: { ...base.persona, displayName: personaName },
      // Spec §4.3: a profile-fetched restore is active iff the relay actually
      // had a real name for the NP key. `base` was built with `primaryName`,
      // which may not be the NP name, so recompute from `npName` directly.
      naturalPersonActive: npName.trim() !== '',
    };

    // Re-derive every extra persona found on the relay, in the same order
    // they were published (persona-1, persona-2, …).
    const extras: ExtraPersona[] = profile.extras.map(e => {
      const { publicKey, privateKey } = deriveExtraPersona(mnemonic, e.derivationName);
      return {
        publicKey,
        privateKey,
        displayName: e.displayName,
        derivationName: e.derivationName,
      };
    });
    if (extras.length > 0) identity.extraPersonas = extras;

    // Phase C.2 — seed publicProfile from the kind-0 events we found.
    // For Persona + extras: default enabled=true (these were public before,
    // user wants to keep publishing). For NP: leave publicProfile absent
    // entirely — the user must deliberately enable via the §6.5 double-
    // confirm in Settings. A post-restore banner (rendered by App.tsx)
    // surfaces "we found a kind-0 on your NP" as informational only.
    if (profile.kind0Events) {
      const { parseKindZeroContent } = await import('../lib/public-profile-publish');
      const relayUrl = (await db.getPreferences()).relayUrl;

      function seedFor(pubkey: string): { config: import('../types').PublicProfileConfig; state: import('../types').PersonaPublicProfile } | undefined {
        const ev = profile.kind0Events?.get(pubkey.toLowerCase());
        if (!ev) return undefined;
        const parsed = parseKindZeroContent(ev.content);
        if (!parsed) return undefined;
        return {
          config: {
            displayName: parsed.displayName ?? '',
            about: parsed.about,
            pictureUrl: parsed.pictureUrl,
            bannerUrl: parsed.bannerUrl,
            nip05: parsed.nip05,
            lud16: parsed.lud16,
            website: parsed.website,
          },
          state: {
            enabled: true,
            lastEventId: ev.id,
            lastPublishedAt: ev.created_at,
            lastPublishedRelay: relayUrl,
          },
        };
      }

      const personaSeed = seedFor(identity.persona.publicKey);
      if (personaSeed) {
        identity.persona = { ...identity.persona, ...personaSeed.config, publicProfile: personaSeed.state };
      }

      if (identity.extraPersonas) {
        identity.extraPersonas = identity.extraPersonas.map(ep => {
          const seed = seedFor(ep.publicKey);
          return seed ? { ...ep, ...seed.config, publicProfile: seed.state } : ep;
        });
      }
      // NP intentionally NOT seeded — see comment above.
    }

    await db.saveIdentityEncrypted(identity, key);
    await db.savePreferences({ ...(await db.getPreferences()), activeAccountId: identity.id });
    await loadAll();
    return identity;
  }, [loadAll, encryptionKey]);

  const remove = useCallback(async (pubkey?: string) => {
    const target = pubkey || activeIdentity?.id;
    if (!target) return;
    await db.deleteIdentityRecord(target);
    const prefs = await db.getPreferences();
    if (prefs.activeAccountId === target) {
      await db.savePreferences({ ...prefs, activeAccountId: undefined });
    }
    await loadAll();
  }, [activeIdentity, loadAll]);

  const importNsec = useCallback(async (
    nsec: string,
    displayName: string,
    primaryKeypair: 'natural-person' | 'persona',
    overrideEncryptionKey?: string,
    /**
     * Phase C.1 opts — seed `publicProfile` from a kind-0 fetched at
     * import time. When `existingProfile` + `existingEventId` are present,
     * the imported persona's `publicProfile.enabled = true` is set
     * alongside the publication-state fields (we treat the existing
     * relay kind-0 AS the published state — no new publish needed).
     * When `publishProfile` is true without an existing kind-0, the
     * publicProfile is left absent: the user fills fields via the
     * editor and the first publish goes out from there (no empty kind-0
     * shipped automatically, per the spec).
     */
    opts?: {
      publishProfile?: boolean;
      existingProfile?: Partial<import('../types').PublicProfileConfig>;
      existingEventId?: string;
      existingCreatedAt?: number;
      existingRelay?: string;
    },
  ) => {
    const identity = importFromNsec(nsec, displayName, primaryKeypair);
    const key = overrideEncryptionKey || encryptionKey;
    if (!key) throw new Error('Encryption key required');

    // If we have an existing kind-0 AND the user opted to keep publishing,
    // seed publicProfile on the slot the keypair landed in (persona for
    // nsec imports per Phase C.1, but defensively check primaryKeypair
    // in case a caller passes 'natural-person'). Config fields lift to the
    // slot top-level; state-only fields live under publicProfile.
    if (opts?.publishProfile && opts?.existingProfile && opts?.existingEventId) {
      const config = {
        displayName: opts.existingProfile.displayName ?? '',
        about: opts.existingProfile.about,
        pictureUrl: opts.existingProfile.pictureUrl,
        bannerUrl: opts.existingProfile.bannerUrl,
        nip05: opts.existingProfile.nip05,
        lud16: opts.existingProfile.lud16,
        website: opts.existingProfile.website,
      };
      const state: import('../types').PersonaPublicProfile = {
        enabled: true,
        lastEventId: opts.existingEventId,
        lastPublishedAt: opts.existingCreatedAt,
        lastPublishedRelay: opts.existingRelay,
      };
      if (primaryKeypair === 'natural-person') {
        identity.naturalPerson = { ...identity.naturalPerson, ...config, publicProfile: state };
      } else {
        identity.persona = { ...identity.persona, ...config, publicProfile: state };
      }
    }

    await db.saveIdentityEncrypted(identity, key);
    await db.savePreferences({ ...(await db.getPreferences()), activeAccountId: identity.id });
    await loadAll();
    return identity;
  }, [loadAll, encryptionKey]);

  const importLiteMnemonic = useCallback(async (
    mnemonic: string,
    liteIdentityName: string,
    displayName: string,
    overrideEncryptionKey?: string,
  ) => {
    const identity = importFromLiteMnemonic(mnemonic, liteIdentityName, displayName);
    const key = overrideEncryptionKey || encryptionKey;
    if (!key) throw new Error('Encryption key required');
    await db.saveIdentityEncrypted(identity, key);
    await db.savePreferences({ ...(await db.getPreferences()), activeAccountId: identity.id });
    await loadAll();
    return identity;
  }, [loadAll, encryptionKey]);

  const markBackedUp = useCallback(async (pubkey?: string) => {
    const target = pubkey || activeIdentity?.id;
    if (!target) return;
    const identity = encryptionKey
      ? await db.loadIdentityDecrypted(target, encryptionKey)
      : await db.getIdentity(target);
    if (!identity) return;
    const updated = { ...identity, backedUp: true };
    if (!encryptionKey) throw new Error('Cannot save identity without encryption key');
    await db.saveIdentityEncrypted(updated, encryptionKey);
    await loadAll();
  }, [activeIdentity, loadAll, encryptionKey]);

  const switchPrimary = useCallback(async (keypair: 'natural-person' | 'persona', overrideEncryptionKey?: string) => {
    if (!activeIdentity) return;
    const key = overrideEncryptionKey || encryptionKey;
    if (!key) throw new Error('Cannot save identity without encryption key');
    // Fresh-decrypt: activeIdentity in React state may carry ciphertext for
    // mnemonic/privateKey after a transient lock cycle (see `addPersona`
    // for the same reasoning). Re-saving the React snapshot would persist
    // ciphertext-in-ciphertext via saveIdentityEncrypted's nested encrypt.
    const decrypted = await db.loadIdentityDecrypted(activeIdentity.id, key);
    if (!decrypted) throw new Error('Could not decrypt identity — wrong key?');
    const oldId = activeIdentity.id;
    const updated = {
      ...decrypted,
      primaryKeypair: keypair,
      id: keypair === 'natural-person' ? decrypted.naturalPerson.publicKey : decrypted.persona.publicKey,
    };
    await db.saveIdentityEncrypted(updated, key);
    if (updated.id !== oldId) {
      await db.deleteIdentityRecord(oldId);
    }
    await db.savePreferences({ ...(await db.getPreferences()), activeAccountId: updated.id });
    await loadAll();
  }, [activeIdentity, loadAll, encryptionKey]);

  /**
   * Activate the real-name (Natural Person) slot: give it a legal name and set
   * `naturalPersonActive`.
   *
   * Derives nothing — the natural-person keypair has existed since creation and
   * is byte-identical whether dormant or active. Does NOT touch `primaryKeypair`
   * or `id`: activating a real identity is not the same as making it the face
   * the app presents (spec §3.3), and re-keying here would silently move the
   * pairing transport (§8) and every `activeAccountId` reference.
   *
   * Fresh-decrypts before saving for the same reason `switchPrimary` does — the
   * React snapshot may hold ciphertext after a transient lock cycle.
   */
  const activateNaturalPerson = useCallback(async (legalName: string) => {
    if (!activeIdentity) throw new Error('No active identity');
    if (!encryptionKey) throw new Error('Cannot save identity without encryption key');
    // `sanitizeDisplayName` already strips -> trims -> caps at maxLen, which is
    // exactly the strip/trim/slice(100) the activation page applies.
    const name = sanitizeDisplayName(legalName, 100);
    if (!name) throw new Error('Enter your legal name');
    const decrypted = await db.loadIdentityDecrypted(activeIdentity.id, encryptionKey);
    if (!decrypted) throw new Error('Could not decrypt identity — wrong key?');
    if (!decrypted.naturalPerson.publicKey) {
      throw new Error('This identity has no real-name key. Restore from recovery words to get one.');
    }
    await db.saveIdentityEncrypted({
      ...decrypted,
      naturalPerson: { ...decrypted.naturalPerson, displayName: name },
      naturalPersonActive: true,
    }, encryptionKey);
    await loadAll();
  }, [activeIdentity, loadAll, encryptionKey]);

  const updatePhoto = useCallback(async (photoHash: string, blossomUrl: string, photoKey: string) => {
    if (!activeIdentity) return;
    if (!encryptionKey) throw new Error('Cannot save identity without encryption key');
    // Fresh-decrypt — see switchPrimary / addPersona for rationale.
    const decrypted = await db.loadIdentityDecrypted(activeIdentity.id, encryptionKey);
    if (!decrypted) throw new Error('Could not decrypt identity — wrong key?');
    const updated = {
      ...decrypted,
      photoHash,
      blossomUrl,
      photoKey,
      photoUpdatedAt: Math.floor(Date.now() / 1000),
    };
    await db.saveIdentityEncrypted(updated, encryptionKey);
    await loadAll();
  }, [activeIdentity, loadAll, encryptionKey]);

  /**
   * Update the display name for a keypair or extra persona.
   * @param target 'natural-person' | 'persona' | pubkey of an extra persona
   * @param name New display name
   * @param nameCredentialId Optional: the event ID of the just-published name credential
   */
  const updateDisplayName = useCallback(async (
    target: 'natural-person' | 'persona' | string,
    name: string,
    nameCredentialId?: string,
  ) => {
    if (!activeIdentity) return;
    if (!encryptionKey) throw new Error('Cannot save identity without encryption key');
    // Fresh-decrypt — see switchPrimary / addPersona for rationale.
    const decrypted = await db.loadIdentityDecrypted(activeIdentity.id, encryptionKey);
    if (!decrypted) throw new Error('Could not decrypt identity — wrong key?');

    let updated: SignetIdentity;
    if (target === 'natural-person') {
      updated = {
        ...decrypted,
        naturalPerson: { ...decrypted.naturalPerson, displayName: name },
      };
    } else if (target === 'persona') {
      updated = {
        ...decrypted,
        persona: {
          ...decrypted.persona,
          displayName: name,
          displayNameUpdatedAt: Math.floor(Date.now() / 1000),
          ...(nameCredentialId !== undefined ? { lastNameCredentialId: nameCredentialId } : {}),
        },
      };
    } else if (target === 'professional-persona') {
      if (!decrypted.professionalPersona) return;
      updated = {
        ...decrypted,
        professionalPersona: {
          ...decrypted.professionalPersona,
          displayName: name,
          updatedAt: Math.floor(Date.now() / 1000),
        },
      };
    } else {
      // Extra persona identified by pubkey
      const extras = (decrypted.extraPersonas ?? []).map(p =>
        p.publicKey === target
          ? {
              ...p,
              displayName: name,
              ...(nameCredentialId !== undefined ? { lastNameCredentialId: nameCredentialId } : {}),
              updatedAt: Math.floor(Date.now() / 1000),
            }
          : p,
      );
      updated = { ...decrypted, extraPersonas: extras };
    }

    await db.saveIdentityEncrypted(updated, encryptionKey);
    await loadAll();
  }, [activeIdentity, loadAll, encryptionKey]);

  /**
   * Derive and add a new persona.
   *
   * Default path derives from the mnemonic, so it requires an identity created
   * from one (not an nsec import). In bunker mode (family-bunker §11.1.8, D4)
   * App.tsx passes `opts.deviceDerive`, which derives the slot on the paired
   * Heartwood signer instead — the phone keeps the public key only
   * (`privateKey: ''`, the same shape the migration strip leaves behind).
   * The derivation token is IDENTICAL either way (`persona-N`), so a later
   * re-enrol on the device is an idempotent no-op rather than a new key.
   */
  const addPersona = useCallback(async (
    displayName: string,
    overrideEncryptionKey?: string,
    opts?: { deviceDerive?: ExtraPersonaDeviceDerive },
  ) => {
    if (!activeIdentity) return;
    const key = overrideEncryptionKey || encryptionKey;
    if (!key) throw new Error('Cannot save identity without encryption key');

    // Load decrypted identity fresh from DB. When the app was locked, React state
    // holds the raw (stripped) record from loadPublic, so activeIdentity.mnemonic
    // is either missing or ciphertext. Re-reading with the key guarantees plaintext.
    const decrypted = await db.loadIdentityDecrypted(activeIdentity.id, key);
    if (!decrypted) throw new Error('Could not decrypt identity — wrong key?');

    // Pick the next derivation name as max-existing + 1, not length + 1,
    // counting tombstones as well as live extras. The deterministic-by-name
    // property of nsec-tree means re-using a name re-derives the same
    // keypair — so a removed slot (hard delete, migration, manual IDB edit)
    // must NOT have its name recycled.
    const derivationName = nextExtraPersonaDerivationName(
      decrypted.extraPersonas ?? [],
      decrypted.extraPersonaTombstones ?? [],
    );

    // Local key material wins whenever present (the transitional preference
    // order); the device is the fallback.
    let publicKey: string;
    let privateKey: string;
    if (decrypted.mnemonic) {
      ({ publicKey, privateKey } = deriveExtraPersona(decrypted.mnemonic, derivationName));
    } else if (opts?.deviceDerive) {
      ({ publicKey, privateKey } = await opts.deviceDerive(derivationName));
    } else {
      throw new Error('Cannot add persona: identity has no mnemonic');
    }

    const newPersona: ExtraPersona = {
      publicKey,
      privateKey,
      displayName,
      derivationName,
      updatedAt: Math.floor(Date.now() / 1000),
    };

    const updated: SignetIdentity = {
      ...decrypted,
      extraPersonas: [...(decrypted.extraPersonas ?? []), newPersona],
    };

    await db.saveIdentityEncrypted(updated, key);
    await loadAll();
  }, [activeIdentity, loadAll, encryptionKey]);

  /**
   * Phase C.3 — post-onboarding nsec import. Adds an imported keypair as
   * a new ExtraPersona on the active identity, marked `imported: true`.
   * Refuses collisions against any existing keypair (NP / persona /
   * extras / Pro) per §4.5 step 3 with slot-specific error copy.
   *
   * Caller is responsible for the user-facing backup-confirmation
   * checkbox per §4.5 (the imported nsec is NOT recoverable via
   * mnemonic restore; the user must back up the nsec separately).
   */
  const addImportedPersona = useCallback(async (
    nsec: string,
    displayName: string,
    overrideEncryptionKey?: string,
    opts?: {
      publicProfileSeed?: {
        config: import('../types').PublicProfileConfig;
        state: import('../types').PersonaPublicProfile;
      };
    },
  ): Promise<{ added: true; pubkey: string } | { added: false; collision: 'natural-person' | 'persona' | 'professional-persona' | 'extra' | 'extra-imported'; collisionDisplayName?: string }> => {
    if (!activeIdentity) throw new Error('No active identity');
    const key = overrideEncryptionKey || encryptionKey;
    if (!key) throw new Error('Encryption key required');

    // Decode nsec → pubkey before touching IDB so we can collision-check.
    const { decodeNsec: dec, getPublicKey: gpk } = await import('../lib/signet');
    const { bytesToHex: btoh } = await import('@noble/hashes/utils.js');
    const skBytes = dec(nsec);
    const privateKey = btoh(skBytes);
    const publicKey = gpk(privateKey);

    const decrypted = await db.loadIdentityDecrypted(activeIdentity.id, key);
    if (!decrypted) throw new Error('Could not decrypt identity — wrong key?');

    // Slot-specific collision check.
    const lc = publicKey.toLowerCase();
    if (decrypted.naturalPerson.publicKey.toLowerCase() === lc) {
      return { added: false, collision: 'natural-person', collisionDisplayName: decrypted.naturalPerson.displayName };
    }
    if (decrypted.persona.publicKey.toLowerCase() === lc) {
      return { added: false, collision: 'persona', collisionDisplayName: decrypted.persona.displayName };
    }
    if (decrypted.professionalPersona?.publicKey.toLowerCase() === lc) {
      return { added: false, collision: 'professional-persona', collisionDisplayName: decrypted.professionalPersona.displayName };
    }
    const colliderExtra = (decrypted.extraPersonas ?? []).find(p => p.publicKey.toLowerCase() === lc);
    if (colliderExtra) {
      return {
        added: false,
        collision: colliderExtra.imported ? 'extra-imported' : 'extra',
        collisionDisplayName: colliderExtra.displayName,
      };
    }

    // Append new imported extra. Empty derivationName + imported:true is
    // the §3.3 three-state signature for "nsec-imported, foreign keypair."
    // Public-profile seed (when supplied) is split: config fields lift to
    // the slot top-level; state object lives under publicProfile.
    const newPersona: ExtraPersona = {
      publicKey,
      privateKey,
      displayName: displayName.trim(),
      derivationName: '',
      imported: true,
      ...(opts?.publicProfileSeed?.config ?? {}),
      ...(opts?.publicProfileSeed?.state ? { publicProfile: opts.publicProfileSeed.state } : {}),
    };
    const updated: SignetIdentity = {
      ...decrypted,
      extraPersonas: [...(decrypted.extraPersonas ?? []), newPersona],
    };
    await db.saveIdentityEncrypted(updated, key);
    await loadAll();
    return { added: true, pubkey: publicKey };
  }, [activeIdentity, loadAll, encryptionKey]);

  /**
   * Soft-delete an extra persona (hide it from the carousel and pickers).
   * The slot stays in the array so its derivation name isn't re-used by
   * a future addPersona — that would re-derive the same keypair, which
   * is a footgun if anything ever signed events under it. Reversible
   * via setExtraPersonaHidden(_, false).
   */
  const setExtraPersonaHidden = useCallback(async (publicKey: string, hidden: boolean, overrideEncryptionKey?: string) => {
    if (!activeIdentity) return;
    const key = overrideEncryptionKey || encryptionKey;
    if (!key) throw new Error('Cannot save identity without encryption key');
    const decrypted = await db.loadIdentityDecrypted(activeIdentity.id, key);
    if (!decrypted) throw new Error('Could not decrypt identity — wrong key?');
    const extras = (decrypted.extraPersonas ?? []).map(p =>
      p.publicKey === publicKey ? { ...p, hidden, updatedAt: Math.floor(Date.now() / 1000) } : p,
    );
    const updated: SignetIdentity = { ...decrypted, extraPersonas: extras };
    await db.saveIdentityEncrypted(updated, key);
    await loadAll();
  }, [activeIdentity, loadAll, encryptionKey]);

  /**
   * Set (or replace) the avatar for one of the user's persona slots.
   * Caller has already uploaded the encrypted blob to Blossom and has the
   * metadata `{ hash, blossomUrl, keyHex, updatedAt }` from `uploadAvatar`.
   * The `keyHex` is encrypted at rest by `saveIdentityEncrypted` — we
   * pass it through here as plaintext hex.
   *
   * `target` semantics mirror `updateDisplayName`:
   *   'natural-person' / 'persona'  → built-in keypair slots
   *   <hex pubkey>                  → an extra persona's slot
   *
   * Reads decrypted identity fresh from IDB before mutating — same defence
   * as `addPersona` against the React `activeIdentity` snapshot holding
   * ciphertext after a brief re-lock.
   */
  const setPersonaAvatar = useCallback(async (
    target: 'natural-person' | 'persona' | string,
    avatar: { hash: string; blossomUrl: string; keyHex: string; updatedAt: number },
  ) => {
    if (!activeIdentity) return;
    if (!encryptionKey) throw new Error('Cannot save identity without encryption key');
    const decrypted = await db.loadIdentityDecrypted(activeIdentity.id, encryptionKey);
    if (!decrypted) throw new Error('Could not decrypt identity — wrong key?');

    let updated: SignetIdentity;
    if (target === 'natural-person') {
      updated = {
        ...decrypted,
        naturalPerson: {
          ...decrypted.naturalPerson,
          avatarHash: avatar.hash,
          avatarBlossomUrl: avatar.blossomUrl,
          avatarKey: avatar.keyHex,
          avatarUpdatedAt: avatar.updatedAt,
        },
      };
    } else if (target === 'persona') {
      updated = {
        ...decrypted,
        persona: {
          ...decrypted.persona,
          avatarHash: avatar.hash,
          avatarBlossomUrl: avatar.blossomUrl,
          avatarKey: avatar.keyHex,
          avatarUpdatedAt: avatar.updatedAt,
        },
      };
    } else {
      const extras = (decrypted.extraPersonas ?? []).map(p =>
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
      updated = { ...decrypted, extraPersonas: extras };
    }

    await db.saveIdentityEncrypted(updated, encryptionKey);
    await loadAll();
  }, [activeIdentity, loadAll, encryptionKey]);

  /**
   * Remove the avatar from a persona slot. Doesn't touch the Blossom blob
   * itself — Blossom servers don't accept a delete from the original uploader
   * by default, and the blob being orphaned on the server is fine (it's
   * encrypted; nobody can read it without the key we just dropped).
   */
  const clearPersonaAvatar = useCallback(async (
    target: 'natural-person' | 'persona' | string,
  ) => {
    if (!activeIdentity) return;
    if (!encryptionKey) throw new Error('Cannot save identity without encryption key');
    const decrypted = await db.loadIdentityDecrypted(activeIdentity.id, encryptionKey);
    if (!decrypted) throw new Error('Could not decrypt identity — wrong key?');

    const cleared = {
      avatarHash: undefined,
      avatarBlossomUrl: undefined,
      avatarKey: undefined,
      avatarUpdatedAt: undefined,
    };
    let updated: SignetIdentity;
    if (target === 'natural-person') {
      updated = { ...decrypted, naturalPerson: { ...decrypted.naturalPerson, ...cleared } };
    } else if (target === 'persona') {
      updated = { ...decrypted, persona: { ...decrypted.persona, ...cleared } };
    } else {
      const extras = (decrypted.extraPersonas ?? []).map(p =>
        p.publicKey === target ? { ...p, ...cleared } : p,
      );
      updated = { ...decrypted, extraPersonas: extras };
    }
    await db.saveIdentityEncrypted(updated, encryptionKey);
    await loadAll();
  }, [activeIdentity, loadAll, encryptionKey]);

  /**
   * Set (or replace) the contact-card avatar for one of the user's persona
   * slots. The contact avatar is the encrypted Blossom photo shown in the
   * contacts list when another user presents this persona's pubkey. Caller
   * has already uploaded the encrypted blob and supplies the resulting
   * metadata. The `contactAvatarKey` is encrypted at rest by
   * `saveIdentityEncrypted` — passed here as plaintext hex.
   *
   * `target` semantics mirror `setPersonaAvatar`:
   *   'natural-person' / 'persona'  → built-in keypair slots
   *   <hex pubkey>                  → an extra persona's slot
   */
  const setPersonaContactAvatar = useCallback(async (
    target: 'natural-person' | 'persona' | string,
    contact: { contactAvatarKey: string; contactAvatarHash: string; contactAvatarBlossomUrl: string; contactAvatarUpdatedAt: number; contactAvatarStale: boolean },
  ) => {
    if (!activeIdentity) return;
    if (!encryptionKey) throw new Error('Cannot save identity without encryption key');
    const decrypted = await db.loadIdentityDecrypted(activeIdentity.id, encryptionKey);
    if (!decrypted) throw new Error('Could not decrypt identity — wrong key?');
    const patch = {
      contactAvatarKey: contact.contactAvatarKey,
      contactAvatarHash: contact.contactAvatarHash,
      contactAvatarBlossomUrl: contact.contactAvatarBlossomUrl,
      contactAvatarUpdatedAt: contact.contactAvatarUpdatedAt,
      contactAvatarStale: contact.contactAvatarStale,
    };
    let updated: SignetIdentity;
    if (target === 'natural-person') {
      updated = { ...decrypted, naturalPerson: { ...decrypted.naturalPerson, ...patch } };
    } else if (target === 'persona') {
      updated = { ...decrypted, persona: { ...decrypted.persona, ...patch } };
    } else {
      const extras = (decrypted.extraPersonas ?? []).map(p =>
        p.publicKey === target ? { ...p, ...patch } : p,
      );
      updated = { ...decrypted, extraPersonas: extras };
    }
    await db.saveIdentityEncrypted(updated, encryptionKey);
    await loadAll();
  }, [activeIdentity, loadAll, encryptionKey]);

  /**
   * Remove the contact-card avatar from a persona slot. The Blossom blob is
   * left in place (already encrypted; cleanup not required).
   */
  const clearPersonaContactAvatar = useCallback(async (
    target: 'natural-person' | 'persona' | string,
  ) => {
    if (!activeIdentity) return;
    if (!encryptionKey) throw new Error('Cannot save identity without encryption key');
    const decrypted = await db.loadIdentityDecrypted(activeIdentity.id, encryptionKey);
    if (!decrypted) throw new Error('Could not decrypt identity — wrong key?');
    const patch = {
      contactAvatarKey: undefined,
      contactAvatarHash: undefined,
      contactAvatarBlossomUrl: undefined,
      contactAvatarUpdatedAt: undefined,
      contactAvatarStale: undefined,
    };
    let updated: SignetIdentity;
    if (target === 'natural-person') {
      updated = { ...decrypted, naturalPerson: { ...decrypted.naturalPerson, ...patch } };
    } else if (target === 'persona') {
      updated = { ...decrypted, persona: { ...decrypted.persona, ...patch } };
    } else {
      const extras = (decrypted.extraPersonas ?? []).map(p =>
        p.publicKey === target ? { ...p, ...patch } : p,
      );
      updated = { ...decrypted, extraPersonas: extras };
    }
    await db.saveIdentityEncrypted(updated, encryptionKey);
    await loadAll();
  }, [activeIdentity, loadAll, encryptionKey]);

  /**
   * Set (or replace) the public-profile state for one of the user's persona
   * slots. Per the per-persona-public-profile design §5.1.3 atomicity
   * contract: callers MUST pass the full `PersonaPublicProfile` object
   * representing the FINAL state — including `enabled`, `lastEventId`,
   * `lastPublishedAt`, `lastPublishedRelay`. The state machine in §6.2.1
   * dictates that `enabled = true` is ONLY persisted alongside successful
   * publication-state fields; the helper has no opinion about the
   * publish — that's the caller's responsibility.
   *
   * `target` semantics: 'natural-person' / 'persona' / <hex pubkey> for an
   * extra persona / 'professional-persona' for the Pro slot.
   */
  const setPersonaPublicProfile = useCallback(async (
    target: 'natural-person' | 'persona' | 'professional-persona' | string,
    config: import('../types').PublicProfileConfig | undefined,
    state: import('../types').PersonaPublicProfile | undefined,
  ) => {
    if (!activeIdentity) return;
    if (!encryptionKey) throw new Error('Cannot save identity without encryption key');
    const decrypted = await db.loadIdentityDecrypted(activeIdentity.id, encryptionKey);
    if (!decrypted) throw new Error('Could not decrypt identity — wrong key?');

    // Build slot-config patch — explicit undefined for each key to ensure
    // spread replaces existing values cleanly (matches partial-config =
    // full-replace semantics). displayName is intentionally NOT included —
    // it has its own dedicated `updateDisplayName` callback.
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

    // The stored NIP-05 check result is only meaningful for the exact
    // identifier it was computed against — whenever the incoming nip05
    // differs from what's currently stored on the slot (including clearing
    // it to empty), drop the stale result rather than let it keep pointing
    // at an identifier that's no longer saved.
    function nip05CheckClear(prevNip05: string | undefined): {
      nip05CheckResult?: undefined;
      nip05CheckedAt?: undefined;
    } {
      return cfgPatch.nip05 === prevNip05 ? {} : { nip05CheckResult: undefined, nip05CheckedAt: undefined };
    }

    let updated: SignetIdentity;
    if (target === 'natural-person') {
      updated = { ...decrypted, naturalPerson: { ...decrypted.naturalPerson, ...cfgPatch, ...nip05CheckClear(decrypted.naturalPerson.nip05), publicProfile: ppValue } };
    } else if (target === 'persona') {
      updated = { ...decrypted, persona: { ...decrypted.persona, ...cfgPatch, ...nip05CheckClear(decrypted.persona.nip05), publicProfile: ppValue } };
    } else if (target === 'professional-persona') {
      if (!decrypted.professionalPersona) return;
      updated = { ...decrypted, professionalPersona: { ...decrypted.professionalPersona, ...cfgPatch, ...nip05CheckClear(decrypted.professionalPersona.nip05), publicProfile: ppValue } };
    } else {
      const extras = (decrypted.extraPersonas ?? []).map(p =>
        p.publicKey === target
          ? { ...p, ...cfgPatch, ...nip05CheckClear(p.nip05), publicProfile: ppValue, updatedAt: Math.floor(Date.now() / 1000) }
          : p,
      );
      updated = { ...decrypted, extraPersonas: extras };
    }

    await db.saveIdentityEncrypted(updated, encryptionKey);
    await loadAll();
  }, [activeIdentity, loadAll, encryptionKey]);

  /**
   * Persist a NIP-05 check result for one of the user's persona slots.
   * Device-local — never synced (see personas-sync.ts `toWire`, which
   * enumerates an explicit field allowlist that never includes these two
   * fields). Called only from the SlotProfileFields "Check" button tap.
   *
   * `target` semantics mirror `setPersonaPublicProfile`.
   */
  const setSlotNip05Check = useCallback(async (
    target: 'natural-person' | 'persona' | 'professional-persona' | string,
    check: { result: Nip05CheckResult; checkedAt: number },
  ) => {
    if (!activeIdentity) return;
    if (!encryptionKey) throw new Error('Cannot save identity without encryption key');
    const decrypted = await db.loadIdentityDecrypted(activeIdentity.id, encryptionKey);
    if (!decrypted) throw new Error('Could not decrypt identity — wrong key?');
    const patch = { nip05CheckResult: check.result, nip05CheckedAt: check.checkedAt };

    let updated: SignetIdentity;
    if (target === 'natural-person') {
      updated = { ...decrypted, naturalPerson: { ...decrypted.naturalPerson, ...patch } };
    } else if (target === 'persona') {
      updated = { ...decrypted, persona: { ...decrypted.persona, ...patch } };
    } else if (target === 'professional-persona') {
      if (!decrypted.professionalPersona) return;
      updated = { ...decrypted, professionalPersona: { ...decrypted.professionalPersona, ...patch } };
    } else {
      const extras = (decrypted.extraPersonas ?? []).map(p =>
        p.publicKey === target ? { ...p, ...patch } : p,
      );
      updated = { ...decrypted, extraPersonas: extras };
    }
    await db.saveIdentityEncrypted(updated, encryptionKey);
    await loadAll();
  }, [activeIdentity, loadAll, encryptionKey]);

  /**
   * Remove the public-profile state from a persona slot. Used after a
   * successful retraction publish to wipe the local state machine cleanly.
   * Doesn't touch the relay — caller is responsible for the kind-5 +
   * tombstone-kind-0 publish before calling this helper.
   */
  const clearPersonaPublicProfile = useCallback(async (
    target: 'natural-person' | 'persona' | 'professional-persona' | string,
  ) => {
    if (!activeIdentity) return;
    if (!encryptionKey) throw new Error('Cannot save identity without encryption key');
    const decrypted = await db.loadIdentityDecrypted(activeIdentity.id, encryptionKey);
    if (!decrypted) throw new Error('Could not decrypt identity — wrong key?');

    let updated: SignetIdentity;
    if (target === 'natural-person') {
      updated = { ...decrypted, naturalPerson: { ...decrypted.naturalPerson, publicProfile: undefined } };
    } else if (target === 'persona') {
      updated = { ...decrypted, persona: { ...decrypted.persona, publicProfile: undefined } };
    } else if (target === 'professional-persona') {
      if (!decrypted.professionalPersona) return;
      updated = { ...decrypted, professionalPersona: { ...decrypted.professionalPersona, publicProfile: undefined } };
    } else {
      const extras = (decrypted.extraPersonas ?? []).map(p =>
        p.publicKey === target ? { ...p, publicProfile: undefined } : p,
      );
      updated = { ...decrypted, extraPersonas: extras };
    }
    await db.saveIdentityEncrypted(updated, encryptionKey);
    await loadAll();
  }, [activeIdentity, loadAll, encryptionKey]);

  /**
   * Hard-delete an extra persona from the identity. Used by PersonaAdvanced's
   * DeleteBlock — distinct from `setExtraPersonaHidden` (soft-delete that
   * preserves the derivation slot for restore). Caller is responsible for
   * any best-effort relay retraction BEFORE invoking this (PersonaAdvanced
   * handles that via `retractPublicProfile` with a 5s budget per §9 Q8).
   *
   * The removed slot leaves a tombstone behind (derived extras only), and
   * `nextExtraPersonaDerivationName` takes the max over live extras AND
   * tombstones — so a deleted slot's derivation name is never recycled by
   * a later addPersona. The user is still pushed toward Hide in the UI;
   * Delete is the explicit power-user path.
   */
  const removeExtraPersona = useCallback(async (publicKey: string) => {
    if (!activeIdentity) return;
    if (!encryptionKey) throw new Error('Cannot save identity without encryption key');
    const decrypted = await db.loadIdentityDecrypted(activeIdentity.id, encryptionKey);
    if (!decrypted) throw new Error('Could not decrypt identity — wrong key?');
    const removedPersona = (decrypted.extraPersonas ?? []).find(p => p.publicKey === publicKey);
    const extras = (decrypted.extraPersonas ?? []).filter(p => p.publicKey !== publicKey);
    let tombstones = decrypted.extraPersonaTombstones ?? [];
    // Only derived extras (persona-N, never imported) get a tombstone — an
    // imported keypair was never part of the derivation sequence another
    // device could resurrect.
    if (removedPersona && !removedPersona.imported && /^persona-\d+$/.test(removedPersona.derivationName)) {
      const derivationName = removedPersona.derivationName;
      tombstones = [
        ...tombstones.filter(t => t.derivationName !== derivationName),
        { derivationName, removedAt: Math.floor(Date.now() / 1000) },
      ];
    }
    const updated: SignetIdentity = { ...decrypted, extraPersonas: extras, extraPersonaTombstones: tombstones };
    await db.saveIdentityEncrypted(updated, encryptionKey);
    await loadAll();
  }, [activeIdentity, loadAll, encryptionKey]);

  /**
   * Reorder extras into the supplied order. Pubkeys not in `orderedPubkeys`
   * are appended at the end in their existing relative order — this protects
   * against a stale call (e.g. a sync that added a new extra mid-edit) from
   * accidentally deleting items.
   */
  const reorderExtraPersonas = useCallback(async (orderedPubkeys: string[]) => {
    if (!activeIdentity) return;
    if (!encryptionKey) throw new Error('Cannot save identity without encryption key');
    const decrypted = await db.loadIdentityDecrypted(activeIdentity.id, encryptionKey);
    if (!decrypted) throw new Error('Could not decrypt identity — wrong key?');
    const current = decrypted.extraPersonas ?? [];
    const byKey = new Map(current.map(p => [p.publicKey, p]));
    const reordered: ExtraPersona[] = [];
    for (const pk of orderedPubkeys) {
      const ep = byKey.get(pk);
      if (ep) {
        reordered.push(ep);
        byKey.delete(pk);
      }
    }
    // Anything not mentioned in the order list keeps its relative position
    // at the tail — never silently dropped.
    for (const ep of current) {
      if (byKey.has(ep.publicKey)) reordered.push(ep);
    }
    const updated: SignetIdentity = { ...decrypted, extraPersonas: reordered };
    await db.saveIdentityEncrypted(updated, encryptionKey);
    await loadAll();
  }, [activeIdentity, loadAll, encryptionKey]);

  /**
   * Bulk-write the merged result of a personas sync-rail fetch (later task).
   * Caller has already merged the remote record against the local one and
   * hands us the final `extraPersonas` list (already ordered), the final
   * tombstone list, and optionally a newer professional-persona display
   * name. Preserves local private keys: an incoming persona with
   * `privateKey === ''` for a `derivationName` that exists locally with a
   * non-empty key keeps the local key (same idea as dependants-sync's
   * `preserveLocalPrivateKey`).
   */
  const applyRemotePersonas = useCallback(async (patch: RemotePersonasPatch) => {
    if (!activeIdentity) return;
    if (!encryptionKey) throw new Error('Cannot save identity without encryption key');
    const decrypted = await db.loadIdentityDecrypted(activeIdentity.id, encryptionKey);
    if (!decrypted) throw new Error('Could not decrypt identity — wrong key?');

    const updated = applyRemotePersonasPatch(decrypted, patch);
    await db.saveIdentityEncrypted(updated, encryptionKey);
    await loadAll();
  }, [activeIdentity, loadAll, encryptionKey]);

  return { identity: activeIdentity, identities, loading, create, restore, restoreWithProfile, importNsec, importLiteMnemonic, addImportedPersona, remove, markBackedUp, switchPrimary, activateNaturalPerson, updatePhoto, updateDisplayName, addPersona, setExtraPersonaHidden, removeExtraPersona, reorderExtraPersonas, applyRemotePersonas, setPersonaAvatar, clearPersonaAvatar, setPersonaContactAvatar, clearPersonaContactAvatar, setPersonaPublicProfile, clearPersonaPublicProfile, setSlotNip05Check, reload: loadAll };
}

/**
 * Pick the next derivation name for an added extra persona. Reads the max
 * `persona-N` index over BOTH the live extras and the tombstones, and
 * returns N+1. Hidden / soft-deleted slots still count, and so do
 * hard-deleted ones (that's what the tombstone list is for) — nsec-tree
 * derivation is deterministic by name, so recycling a removed slot's name
 * would silently resurrect a keypair the user already deleted, and would
 * hand a second device a persona-N whose tombstone then deletes it again.
 */
export function nextExtraPersonaDerivationName(
  extras: ReadonlyArray<ExtraPersona>,
  tombstones: ReadonlyArray<ExtraPersonaTombstone> = [],
): string {
  let maxIdx = 0;
  const consider = (derivationName: string) => {
    const m = /^persona-(\d+)$/.exec(derivationName);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxIdx) maxIdx = n;
    }
  };
  for (const ep of extras) consider(ep.derivationName);
  for (const t of tombstones) consider(t.derivationName);
  return `persona-${maxIdx + 1}`;
}
