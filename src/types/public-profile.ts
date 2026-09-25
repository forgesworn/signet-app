/**
 * Publication state for the slot's kind-0. The slot itself carries the
 * config (picture, about, nip05, …) — this object exists to track
 * "currently published, where, and when." All four fields move together
 * per §5.1.3 atomicity contract of 2026-05-16 design.
 * See 2026-05-17-persona-card-as-source-of-truth-design.md.
 */
export interface PersonaPublicProfile {
  enabled: boolean;
  /** Event ID of the last kind-0 we published — 64-char lowercase hex. */
  lastEventId?: string;
  /** Unix seconds — last successful publish. */
  lastPublishedAt?: number;
  /** Relay URL the lastEventId was published to. */
  lastPublishedRelay?: string;
  /**
   * SHA-256 hex of the kind-0 content that was last published (output of
   * `contentHashFor` over the same `PublicProfileConfig` we emitted).
   * Used for the §5.3.3 short-circuit: when the next publish's candidate
   * hash matches this, the publisher skips the relay round-trip. Set on
   * every successful publish; cleared on retract.
   */
  lastPublishedContentHash?: string;
}

/**
 * Shape-only view of kind-0 config fields as they sit on a keypair slot.
 * Consumed by buildKindZeroContent (ignores Blossom hashes, and ignores
 * the two NIP-05-check fields below) and the persona-inventory sync rail
 * (uses everything else, but also never carries the check fields — see
 * `persona-inventory-sync.ts` `publicProfileToInventoryBlock`).
 */
export interface PublicProfileConfig {
  displayName: string;
  about?: string;
  pictureUrl?: string;
  pictureBlossomHash?: string;
  bannerUrl?: string;
  bannerBlossomHash?: string;
  nip05?: string;
  lud16?: string;
  website?: string;
  /** Device-local: last NIP-05 lookup outcome for `nip05`. Never synced, never on kind-0. */
  nip05CheckResult?: import('../lib/nip05-check').Nip05CheckResult;
  /** Device-local: ms epoch of that lookup. Never synced, never on kind-0. */
  nip05CheckedAt?: number;
}
