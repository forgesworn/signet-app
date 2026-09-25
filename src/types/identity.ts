import type { PersonaPublicProfile } from './public-profile';
import type { Nip05CheckResult } from '../lib/nip05-check';

/**
 * Encrypted-blob avatar metadata. The blob lives on the user-chosen Blossom
 * server; `avatarKey` is the AES-256-GCM key (encrypted at rest with the
 * unlock key, same pattern as private keys). Distinct from the venue-entry
 * `photoHash` family on `SignetIdentity` / `DependantIdentity` — that's a
 * single physical-person photo for in-person verification; THIS is a UX
 * avatar that flows per-persona to consumer sites at sign-in time. Naming
 * kept deliberately different so the two concepts stay separable.
 * See: 2026-05-16 per-persona-avatars discussion.
 *
 * Applied to every slot variant EXCEPT `SignetIdentity.professionalPersona`,
 * which has no avatar story this phase.
 */
export interface SlotAvatarFields {
  avatarHash?: string;
  avatarBlossomUrl?: string;
  /** Hex AES-256-GCM key — ENCRYPTED at rest in IDB. Decrypted on load. */
  avatarKey?: string;
  avatarUpdatedAt?: number;
  /**
   * Contact-share avatar — a DEDICATED stable AES-256-GCM key, distinct from
   * the per-upload `avatarKey`, so a sign-in consumer can't follow this avatar
   * forever. Generated lazily on first "Share my avatar" enable and reused on
   * every subsequent picture change (image is encrypted twice on change —
   * accepted). ENCRYPTED at rest like `avatarKey`; hash/url stay clear (routing
   * fields). Does NOT propagate via cross-device dependant sync. See
   * 2026-06-04 contact-card-name-avatar design §B2.
   */
  contactAvatarKey?: string;
  contactAvatarHash?: string;
  contactAvatarBlossomUrl?: string;
  contactAvatarUpdatedAt?: number;
  /** True when the always-current contact-avatar re-publish last FAILED (relay
   *  reject / upload error) — contacts may be seeing an out-of-date picture.
   *  Cleared on a successful (re-)share. Plain state field, NOT encrypted. */
  contactAvatarStale?: boolean;
}

/**
 * Public-profile (kind-0) configuration carried on every keypair slot.
 * The 8 content fields are what `buildKindZeroContent` emits (minus
 * `displayName`, which the slot already has); the `publicProfile`
 * field tracks publication state per `PersonaPublicProfile` docstring.
 *
 * Applied to all 6 slot variants (NP / Persona / Pro Persona / Extra
 * Persona, plus the dep-side NP / Persona). Mirrors the shape of
 * `PublicProfileConfig` minus the required `displayName`.
 */
export interface SlotPublicationFields {
  about?: string;
  pictureUrl?: string;
  pictureBlossomHash?: string;
  bannerUrl?: string;
  bannerBlossomHash?: string;
  nip05?: string;
  lud16?: string;
  website?: string;
  /** Public Nostr profile state for this slot. See PersonaPublicProfile. */
  publicProfile?: PersonaPublicProfile;
  /** Device-local: last NIP-05 lookup outcome for the `nip05` on this slot. Never synced. */
  nip05CheckResult?: Nip05CheckResult;
  /** Device-local: ms epoch of that lookup. Never synced. */
  nip05CheckedAt?: number;
}

/** A single persona (beyond the primary natural-person and default persona) */
export interface ExtraPersona extends SlotAvatarFields, SlotPublicationFields {
  /** Derived pubkey (hex) */
  publicKey: string;
  /** Derived private key (hex) */
  privateKey: string;
  /** User-chosen display name */
  displayName: string;
  /** Derivation name passed to nsec-tree (e.g. "persona-2") */
  derivationName: string;
  /** The kind 31000 event ID for the current display-name credential (for supersession) */
  lastNameCredentialId?: string;
  /**
   * Soft-delete flag. Hidden personas are excluded from the carousel parent
   * ring and every sign-in / connect picker, but stay in the array so the
   * derivation slot isn't reused — re-adding a persona later doesn't collide
   * with the keypair that already signed events on relays. Restored from
   * the Manage Carousel page.
   */
  hidden?: boolean;
  /**
   * True for nsec-imported personas (post-onboarding import path, §4.5 of
   * the kind-0 design). Distinguishes from mnemonic-derived personas (which
   * have `derivationName: 'persona-N'`) and from paired-child synced
   * personas (`derivationName: ''`, `imported: undefined`). Imported
   * personas have a separate backup story: they don't come back from a
   * 12-word seed-phrase restore. UI surfaces an "Imported — not in your
   * seed phrase" badge for these.
   */
  imported?: boolean;
  /**
   * Unix seconds of the last local name / hidden / profile-config edit —
   * NOT reorders (order travels with the record). Drives last-writer-wins
   * in the personas sync rail.
   */
  updatedAt?: number;
}

/**
 * A derived extra persona removed on this device. Carried on the rail so
 * another device does not resurrect it on the next sync — never entries
 * for imported extras (those aren't part of the derivation sequence).
 */
export interface ExtraPersonaTombstone {
  derivationName: string;
  removedAt: number;
}

/**
 * Bulk-write payload for `useIdentity`'s `applyRemotePersonas` — the result
 * of merging a remote personas-sync record with the local identity. See
 * `src/hooks/useIdentity.ts` `applyRemotePersonas` for the write itself.
 */
export interface RemotePersonasPatch {
  /** Full replacement list, already merged, in final order. privateKey '' allowed (keyless). */
  extraPersonas: ExtraPersona[];
  tombstones: ExtraPersonaTombstone[];
  /**
   * Optional: the remote professional-persona rename, when the remote
   * record is newer. Name and stamp travel as ONE pair — the local slot's
   * `updatedAt` must stay in lockstep with the `displayName` it stamps, so
   * neither half is representable without the other.
   */
  professional?: { displayName: string; updatedAt: number };
  /**
   * Key material for a Professional-Persona slot this device does not have
   * yet, so an inbound `professional` rename can be adopted rather than
   * dropped. Only consulted when `professional` is set AND the local
   * identity has no `professionalPersona`. The CALLER is responsible for
   * proving the keypair is the right one (re-derive from the mnemonic and
   * match the wire pubkey, or accept it keyless on a device-held-keys
   * install) — this is never derived down in the write path.
   */
  professionalSlot?: { publicKey: string; privateKey: string };
  /**
   * Present (always `true`) when the remote record says the real-name slot is
   * activated and this device's is not. Monotonic — the patch never carries
   * `false`, because absence is "no news", not "deactivate". Activation on this
   * device sets the flag ONLY; it never writes a display name, because the NP
   * name is not on this rail.
   */
  naturalPersonActive?: true;
  /**
   * A real-identity display name to adopt. Set by the sync hook ONLY when the
   * merge found this device's own NP name empty and the remote activation
   * carried one — without it, a cross-device activation lands as an active but
   * NAMELESS real identity, since the NP name rides no other owner rail.
   *
   * The write re-checks the freshly-decrypted record and still refuses to
   * overwrite a non-empty local name: the merge decided on a React snapshot,
   * the write is the last word.
   */
  naturalPersonDisplayName?: string;
}

export interface SignetIdentity {
  /** Primary keypair pubkey — whichever keypair is currently active */
  id: string;
  mnemonic: string;
  naturalPerson: {
    publicKey: string;
    privateKey: string;
    displayName: string;
  } & SlotAvatarFields & SlotPublicationFields;
  persona: {
    publicKey: string;
    privateKey: string;
    displayName: string;
    /** Private profiles-vault name merge timestamp, unix seconds. */
    displayNameUpdatedAt?: number;
    /** The kind 31000 event ID for the current display-name credential (for supersession) */
    lastNameCredentialId?: string;
  } & SlotAvatarFields & SlotPublicationFields;
  /** Additional personas derived from the mnemonic via nsec-tree */
  extraPersonas?: ExtraPersona[];
  /**
   * Derived extras removed on this device; carried on the rail so another
   * device does not resurrect them; never entries for imported extras.
   */
  extraPersonaTombstones?: ExtraPersonaTombstone[];
  /**
   * Professional Persona keypair — derived from the same mnemonic via nsec-tree
   * path token 'professional'. Present after the user first enters Pro-surface
   * onboarding. Absent on legacy identities until first Pro entry.
   * No avatar story this phase — the Pro key uses the NP avatar if any.
   * Spec: 2026-04-25-pro-surface-architecture-design.md §4.5.2
   */
  professionalPersona?: {
    publicKey: string;
    privateKey: string;
    displayName: string;
    /** Unix seconds of the last rename — drives LWW in the personas sync rail. */
    updatedAt?: number;
  } & SlotPublicationFields;
  primaryKeypair: 'natural-person' | 'persona';
  isChild: boolean;
  guardianPubkey?: string;
  createdAt: number;
  /** Whether private keys and mnemonic are encrypted */
  encrypted?: boolean;
  /** Whether backup words have been saved */
  backedUp?: boolean;
  /**
   * True when the real-name (Natural Person) slot has been activated by the
   * user: it has a legal name, a carousel card, a sign-in picker entry (behind
   * the confirm tap), and may be used by real-name features.
   *
   * False/absent means DORMANT: the key material exists and is byte-identical
   * to an active slot's (same nsec-tree derivation), `naturalPerson.displayName`
   * is `''`, there is no carousel row, the slot is excluded from every picker,
   * it is never used as a NIP-46 pairing transport, and real-name features
   * route to the activation page instead.
   *
   * Absent on records written before this field existed — read it through
   * `isNaturalPersonActive` (identity-display.ts) or lift it on decrypt with
   * `liftNaturalPersonActive` (lift-natural-person-active.ts). Rides the
   * personas sync rail; monotonic (activation propagates, never deactivation).
   */
  naturalPersonActive?: boolean;
  /**
   * True for identities created by `importFromLiteMnemonic`. Purely local — it
   * never goes on any sync wire. Used only so the activation page can show a
   * Lite-specific line about which words MySignet restores from; a Lite import
   * arrives `backedUp: true` and is otherwise indistinguishable from a user who
   * has already written their words down.
   */
  liteImported?: boolean;
  /** SHA-256 hex of the encrypted photo blob on Blossom */
  photoHash?: string;
  /** Base URL of the fan's Blossom server */
  blossomUrl?: string;
  /** Hex-encoded AES-256-GCM key for decrypting the photo blob */
  photoKey?: string;
  /** Unix timestamp of last photo update */
  photoUpdatedAt?: number;
}
