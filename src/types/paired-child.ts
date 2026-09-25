import type { AutonomyStage } from './dependants';

/**
 * A NIP-46 client (external app) that has paired with this Signet. When
 * the bunker server is enabled (AppPreferences.bunkerServerEnabled),
 * every inbound sign_event (etc.) request is routed by `clientPubkey`;
 * records with `allowAlways: true` skip the approval prompt.
 *
 * Stored in IndexedDB keyed by `clientPubkey`.
 */
export interface ConnectedClient {
  /** Client's ephemeral session pubkey from the nostrconnect:// URI — 64-char hex. */
  clientPubkey: string;
  /** Human-readable name from the client's metadata (truncated to 100 chars). */
  appName: string;
  /** Client's app URL from metadata (optional, truncated to 200 chars). */
  appUrl?: string;
  /** Unix timestamp of initial pairing. */
  connectedAt: number;
  /** Unix timestamp of the most-recent inbound request. */
  lastSeenAt: number;
  /**
   * When true, sign_event / nip44_* requests from this client are
   * auto-approved without prompting. User sets this by choosing
   * "Allow always for <App>" in the approval modal. Revocable via
   * the Connections settings page.
   */
  allowAlways: boolean;
  /**
   * Random marker written by the connect approval that saved this record.
   * Its rollback (cancelled / withdrawn / failed) touches the record only
   * while it still carries that marker — never a newer pairing or a record
   * changed since.
   */
  pairingNonce?: string;
}

/**
 * Record a paired-child device stores to reach the guardian's phone-as-family-
 * bunker. Populated when the child's device scans the pairing QR and
 * kept encrypted-at-rest behind a PIN/biometric. The child's signing private
 * key never lives here — every signing op round-trips to the guardian phone
 * over NIP-46 via this pairing.
 *
 * After multi-pairing support, the device may hold more than one PairedChildRecord — a shared
 * family iPad can be paired as Alice AND Bob. Each row is keyed by the
 * dependant's signing pubkey so the store can hold N rows.
 */
export interface PairedChildRecord {
  /**
   * Row key — the dependant's signing pubkey. One row per child on this
   * device. Pre-v10 stores used the constant `'paired-child-current'`;
   * the v10 migration re-keys existing rows to their dependantPubkey.
   */
  id: string;
  /**
   * Standard `bunker://…?…` URI (see `parsePairingURI`). Reused at every
   * subsequent unlock to reconnect `BunkerSigningBackend` to the guardian.
   * Encrypted at rest when `encrypted === true`.
   */
  bunkerUri: string;
  /**
   * NIP-46 client keypair this device uses to encrypt envelopes to the
   * guardian's endpoint. Generated at pair-scan time, never derived from
   * any mnemonic. Private key encrypted at rest when `encrypted === true`.
   */
  clientKeypair: { publicKey: string; privateKey: string };
  /** Dependant's primary signing pubkey (from the pairing URI `dependant=` hint). */
  dependantPubkey: string;
  /** Dependant's display name (from the pairing URI `name=` hint). */
  dependantName: string;
  /**
   * Guardian's real signing pubkey (from the pairing URI `guardian=`
   * hint — see `pairing-uri.ts` C1 note). Absent for pairings made
   * before this field existed; the child-side audit surface can't show
   * a verified activity log until the child re-pairs against a fresh
   * QR. Not secret — stored in clear, same as `dependantPubkey`.
   */
  guardianPubkey?: string;
  /** Unix seconds when the pairing was first persisted. */
  pairedAt: number;
  /**
   * True once this device has completed its first `connect` handshake with
   * the guardian's bunker (secret verified + client pubkey bound server-
   * side). On the NEXT unlock the runtime calls `reconnect` instead of
   * `connect`, since the server now recognises our client pubkey. Absent
   * or false means first-unlock-after-onboarding is still pending.
   */
  hasPaired?: boolean;
  /** Whether sensitive fields (bunkerUri, clientKeypair.privateKey) are encrypted. */
  encrypted?: boolean;
}

/**
 * Cached dependant status on a child-own-device.
 * Populated by `useDependantStatus` when the guardian's per-dependant
 * endpoint publishes a kind-30078 status event to the child's transport
 * pubkey. The cache survives restarts so the dormant surface can render
 * before the next relay sync completes. See
 * `docs/reports/2026-04-22-child-stage-awareness-holodeck.md`.
 *
 * Keyed by `dependantPubkey` (M10, 2026-07-02 audit) — a shared family
 * device can hold multiple pairings (post-multi-pairing-support), so a single fixed-key row
 * would show/persist one child's status under another's when switching the
 * active pairing. Mirrors `PairedChildRecord`'s `id === dependantPubkey`
 * convention.
 */
export interface DependantStatusRecord {
  /** Row key — the dependant's pubkey. One row per child on this device. */
  id: string;
  /** Same value as `id` — kept as an explicit field for callers that don't
   *  want to rely on the row-key naming convention. */
  dependantPubkey: string;
  /**
   * The guardian's most recently-signalled stage for this child. When
   * unset (brand-new pair, decrypt failure, unknown value), callers
   * default to dormant per the OQ1-139 consensus.
   */
  stage: AutonomyStage;
  /** Unix seconds — the guardian-side timestamp of the stage change. */
  updatedAt: number;
  /** Local clock ms when the cache last synced. Diagnostic; not authoritative. */
  lastSyncedAt: number;
  /** Guardian display name, so the dormant copy can reference them by name. */
  guardianName?: string;
}
