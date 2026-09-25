import type { GrantSchedule } from '../lib/grant-schedule';
import type { ExtraPersona, ExtraPersonaTombstone, SlotAvatarFields, SlotPublicationFields } from './identity';

/** Autonomy stage for a dependant's signing delegation */
export type AutonomyStage = 'full-control' | 'request-approve' | 'autonomous-alerts' | 'autonomous-logging' | 'full-autonomy';

/**
 * Transport identity for phone-as-family-bunker pairings. Distinct from the
 * dependant's signing keypair — this is what the child device connects to
 * over NIP-46. Generated lazily at first pair; absent for local-only families.
 * Private key encrypted at rest via the same path as the signing keys.
 * See the 2026-04-22 dependant-accounts spec §Path 2.
 */
export interface DependantBunkerEndpoint {
  publicKey: string;
  privateKey: string;
  createdAt: number;
  /**
   * Current pair challenge — set by the guardian pair UI when a fresh QR is
   * minted, compared against the client's `connect` secret, cleared on a
   * successful bind. Absent (or empty) means no pair window is open — any
   * unsolicited `connect` is rejected with "pairing not active".
   */
  pairingSecret?: string;
  /**
   * Client NIP-46 pubkey bound on the first successful `connect`. Absence
   * means the endpoint hasn't completed a pair yet; all subsequent
   * sign_event / get_public_key / connect requests must come from this
   * pubkey once set. Revoke-pair clears it to re-open the window.
   */
  authorizedClientPubkey?: string;
}

/**
 * A bound trusted-app pairing on a dependant's `appBunkerEndpoint`. Each
 * record represents one third-party app (e.g. Fathom on the guardian's
 * phone) that may sign as the dependant via NIP-46. Distinct from
 * `DependantBunkerEndpoint.authorizedClientPubkey` which is reserved for
 * the child's OWN paired device.
 */
export interface TrustedAppPairing {
  /** Bound on first successful connect from this client. */
  clientPubkey: string;
  /** Human-readable label, set from consumer metadata or guardian default. */
  label: string;
  /** Captured from the connecting app's nostrconnect:// metadata if present. */
  origin?: string;
  /** Unix seconds — when this pairing was bound. */
  pairedAt: number;
  /** Updated by useBunkerServer per request. */
  lastSeenAt?: number;
  /**
   * Pairing role (Charter clause #1). `'app'` is
   * the existing default for arbitrary third-party apps signing as the
   * dep. `'charter'` is the parent's Charter dashboard — only this kind
   * may call `charter_*` NIP-46 methods (e.g. `charter_set_schedule`).
   * Set during the pair handshake from the connecting app's metadata;
   * absence means `'app'` (existing pairings auto-promote is explicitly
   * rejected — Charter must re-pair to gain the kind).
   */
  kind?: 'app' | 'charter';
}

/**
 * Per-dependant NIP-46 transport keypair holding a small set of trusted-app
 * pairings (max `TRUSTED_APP_PAIRING_CAP`). Distinct from
 * `DependantBunkerEndpoint`, which is reserved for the child's own paired
 * device. Lives only on the device that minted it — the keypair is fresh
 * randomness, not derived from the mnemonic, so it does NOT propagate via
 * cross-device dependant sync. Cross-device sync is out-of-scope for this field.
 */
export interface TrustedAppEndpoint {
  publicKey: string;
  privateKey: string;
  createdAt: number;
  /** Current pair-in-flight secret. Cleared on a successful bind. */
  pairingSecret?: string;
  /** Bound trusted apps. Cap: TRUSTED_APP_PAIRING_CAP. */
  pairings: TrustedAppPairing[];
}

/** Hard cap on the number of trusted-app pairings per dependant. */
export const TRUSTED_APP_PAIRING_CAP = 5;

/** A dependant identity managed by a guardian */
export interface DependantIdentity {
  /**
   * The dependant's primary pubkey — the record key everything else binds to
   * (paired-child record, audit `d` tag, add-dependant callback, child-settings
   * store, policy-compiler slot map, bunker routes).
   *
   * For a dependant created before 2026-09-15 this is the natural-person
   * pubkey. For a newly tree-derived, persona-first dependant (spec §7.6) it is
   * `persona.publicKey`, so a dormant real identity never leaks through a
   * pairing QR or a consumer callback. Imported dependants keep the pubkey they
   * were imported under.
   */
  id: string;
  /** Guardian's pubkey (links to parent identity) */
  guardianPubkey: string;
  /** Display name */
  displayName: string;
  /** ISO date of birth — optional, guardian-private, never published */
  dateOfBirth?: string;
  /** Natural person keypair. Guardian-managed slot — see SlotAvatarFields
   *  + SlotPublicationFields for shared field docs. */
  naturalPerson: {
    publicKey: string;
    privateKey: string;
    displayName: string;
  } & SlotAvatarFields & SlotPublicationFields;
  /** Persona keypair */
  persona: {
    publicKey: string;
    privateKey: string;
    displayName: string;
  } & SlotAvatarFields & SlotPublicationFields;
  /** Additional personas */
  extraPersonas?: ExtraPersona[];
  /** Permanently reserved names of deleted derived personas; synced to other devices. */
  extraPersonaTombstones?: ExtraPersonaTombstone[];
  /** nsec-tree derivation path (e.g. 'dependant-0') */
  derivationPath: string;
  /** Timestamp of creation */
  createdAt: number;
  /** Whether private keys are encrypted */
  encrypted?: boolean;
  /** Delegation stage */
  autonomyStage: AutonomyStage;
  /** Which keypair is currently active — 'natural-person', 'persona', or an extra persona's pubkey */
  primaryKeypair: 'natural-person' | 'persona' | string;
  /**
   * Is the dependant's real-name (Natural Person) slot activated? (spec §3.1,
   * §7.6.) `false` ⇒ dormant: the key exists and stays on file, but the slot
   * has no display name, no carousel row, no picker entry, no inventory-wire
   * entry, no pairing role, and its device slot compiles to a locked policy.
   *
   * Read it through `isDependantNaturalPersonActive` (identity-display.ts);
   * records written before the field existed are lifted on decrypt by
   * `liftDependantNaturalPersonActive`. Rides the dependants sync rail as a
   * monotonic OR (activation propagates; absence never deactivates).
   */
  naturalPersonActive?: boolean;
  /**
   * Per-dependant NIP-46 transport keypair for the phone-as-family-bunker
   * pairing flow. Absent until a pairing QR is generated for this dependant.
   */
  bunkerEndpoint?: DependantBunkerEndpoint;
  /**
   * Per-dependant NIP-46 transport keypair holding TrustedAppPairing records
   * for third-party apps (e.g. Fathom) that act on behalf of this dependant.
   * Distinct from `bunkerEndpoint` (reserved for the child's own device).
   * Generated lazily on first "Pair an app". Single-device only — does not
   * sync across guardian devices.
   */
  appBunkerEndpoint?: TrustedAppEndpoint;
  /** SHA-256 hex of the dependant's encrypted profile photo blob on Blossom. */
  photoHash?: string;
  /** Base URL of the Blossom server holding the dep's photo blob. */
  blossomUrl?: string;
  /** Hex-encoded AES-256-GCM key for decrypting the dep's photo blob. */
  photoKey?: string;
  /** Unix timestamp of last photo update for the dep. */
  photoUpdatedAt?: number;
  /**
   * Per-dep override for audit-log child-visibility (v2).
   * Defaults to `'default'` (i.e. follow the autonomy-stage rule —
   * visible at `autonomous-*` stages and `full-autonomy`; hidden at
   * `request-approve` / `full-control`). Use `'force-visible'` to
   * surface the log even at restricted stages (e.g. a mature young
   * teen at `request-approve`), or `'force-hidden'` to hide it even
   * at autonomous stages (e.g. a special-needs adult dep who
   * shouldn't navigate the audit surface). The resolver lives in
   * `src/lib/audit-visibility.ts`.
   */
  auditVisibility?: 'default' | 'force-visible' | 'force-hidden';
  /**
   * Guardian opt-in for C4 petitions on device auto-deny (family-bunker
   * §11.1.4/9, C3 design §3.1). When true, the compiled Heartwood slot
   * policy sets `petition_on_deny`, so a request the device hard-denies
   * (an excluded scope's kind, or a method outside the ceiling) raises a
   * kind-31001 `t:petition` notice in the guardian's "Family asks" instead
   * of failing silently on the child's device. Device-local like
   * `auditVisibility` — never crosses the dependants sync wire.
   */
  petitionOnDeny?: boolean;
  /**
   * Dep-level default schedule (Charter clause #1). Applies to ANY
   * sign request — including fresh approval prompts for unknown
   * origins — when no per-origin schedule overrides. Per-origin
   * schedules can further restrict but never extend the dep-default
   * (intersection semantics in `src/lib/grant-schedule.ts`). When
   * absent, dep-level signing is unrestricted by default.
   */
  defaultSchedule?: GrantSchedule;
  /**
   * Manual sort position in the carousel parent ring. Lower values
   * appear first; undefined sorts to the bottom of the dependant
   * group (treated as +Infinity). Set from the Manage Carousel
   * page. Independent of derivation order so the user can put
   * the most-used dependant first regardless of when they added
   * them.
   */
  sortIndex?: number;
  /**
   * Persona pubkeys hidden from the paired-child device. Absence means
   * "show everything." NP is never hidable — only `persona.publicKey`
   * and `ExtraPersona.publicKey` values may appear here. Checked by
   * the persona-inventory publisher before building the on-wire payload.
   * See 2026-05-15-persona-inventory-sync-to-paired-child-design.md §2.2.
   */
  hiddenOnPairedDeviceKeys?: string[];
}
