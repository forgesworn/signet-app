/**
 * Nostr event kind constants for the Signet Pro-surface.
 *
 * All in the addressable range (30000–39999) so that a new event for the
 * same firm/d-tag replaces the previous one at the relay.
 *
 * Spec: the internal Pro-surface architecture design doc, §3
 *
 * Deliberately separate from:
 *   - NIP-98 HTTP auth: kind 27235
 *   - Signet venue entry: kind 21235 (ephemeral, not addressable)
 *   - Signet sign-in auth: kind 21236 (ephemeral, not addressable)
 */

/** Signed by the lead pubkey. Declares: "I am the lead of this firm." */
export const PRO_ROLE_ANCHOR = 30201;

/**
 * Signed by the lead pubkey. Lists sub-role members (form tutors, GPs,
 * associates) by pubkey and role tag. Replaces previous roster for the same
 * d-tag (firm identifier).
 */
export const PRO_ROSTER = 30202;

/**
 * Signed by the lead pubkey. Opts the firm into the public Signet directory.
 * The directory page is regenerated nightly from relay events of this kind.
 */
export const PRO_DIRECTORY_ADD = 30203;

/**
 * Signed by the lead pubkey. Revokes a sub-role member from the roster.
 * Published as a separate event so verifiers can detect revocations without
 * re-fetching the full roster.
 */
export const PRO_REVOCATION = 30204;

/**
 * Kind 29999 — Signet Pro-surface credential event.
 * Signed by the Pro persona key. Used for self-cert credentials (cold-start
 * sub-role path) and eventual full-chain credentials from the lead.
 * Spec: the internal Pro-surface architecture design doc, §6.10.4
 */
export const PRO_CREDENTIAL = 29999;
