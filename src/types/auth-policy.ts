/**
 * Keypair type tokens used by the consumer-hint URL params and the
 * policy resolver. `extra-persona` covers the entire set of extras.
 */
export type KeypairToken = 'natural-person' | 'persona' | 'extra-persona';

/**
 * Consumer-supplied hint from the Sign-in-with-Signet URL params.
 * `accept=<csv>`, `prefer=<token>`, `accept_reason=<string>`.
 * Present only when at least `accept` was supplied.
 */
export interface ConsumerHint {
  /** Canonical allowlist — lowercased, deduped, unknown tokens dropped. Empty array = no filter. */
  allow: KeypairToken[];
  /** Preferred default keypair token when multiple are allowed. */
  prefer?: KeypairToken;
  /** Short human-readable string (sanitised, capped at 120 chars) displayed in the picker. */
  reason?: string;
}

/** App-level guardrails applied on top of the consumer hint. */
export interface AppGuardrails {
  /** When true, selecting natural-person must go through an extra confirmation. */
  requireNpConfirmation: boolean;
}

/**
 * Per-origin identity-selection policy record. Populated silently on each
 * Sign-in-with-Signet approval; surfaced in Connections for the user to
 * pin an identity for this origin or clear their history.
 */
export interface OriginPolicy {
  /** Normalised origin — e.g. "https://axenstax.com" (no trailing slash, no path). */
  origin: string;
  /**
   * Last keypair used. Matches `AuthorizedSite.keypairUsed` — literal token
   * ('natural-person' | 'persona') or an extra persona's hex pubkey.
   */
  lastKeypair: string;
  /** Seconds since epoch. */
  lastUsed: number;
  /** User said "always this keypair here" — vetoes consumer `accept=` hints. */
  pinned: boolean;
  /** True when user took the NP fallback against the consumer's allowlist. */
  userOverrode: boolean;
  /**
   * Rolling history of consumer hint shapes for drift detection.
   * Each entry records the allowlist seen at the time of approval.
   * Ring-buffer capped — see ORIGIN_POLICY_HISTORY_CAP.
   */
  acceptHistory?: Array<{
    at: number;
    /** Consumer allowlist at approval time; empty array = no filter. */
    allow: KeypairToken[];
  }>;
}

/** Max number of accept-history entries retained per origin. */
export const ORIGIN_POLICY_HISTORY_CAP = 16;

/** A site the user has signed into with Signet */
export interface AuthorizedSite {
  /** Generated unique ID */
  id: string;
  /** Site origin, e.g. "https://example.com" */
  origin: string;
  /** Human-readable site name */
  name: string;
  /**
   * Which keypair was used for sign-in.
   * - 'natural-person' | 'persona' — built-in keypairs.
   * - 64-char hex pubkey — an extra persona. The Connections page resolves the
   *   display name by looking up `pubkeyShared` against the current identity.
   */
  keypairUsed: string;
  /** Which pubkey the site received */
  pubkeyShared: string;
  /** When the user first approved this site (unix timestamp) */
  authorizedAt: number;
  /** Updated on each re-authorization (unix timestamp) */
  lastUsedAt: number;
  /**
   * Whether the user agreed to share their persona handle with this site
   * on the most recent sign-in. Persisted so the checkbox default sticks
   * across visits. Undefined on rows written before this field existed.
   */
  shareHandle?: boolean;
  /**
   * Service-side display name the consumer told us about for this user
   * (via `consumer_display_name` URL param on a sign-in request) or that
   * the user typed in via the Connections page. Stored in plaintext —
   * AuthorizedSites are not encrypted at rest, same as today.
   */
  consumerDisplayName?: string;
}
