/**
 * Shared constants for the professional registry modules.
 */

/** Registry cache TTL (24 hours). Used by resolver.ts and verify-chain.ts. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Maximum size for registry API responses.
 * Registry responses (GIAS, CQC, SRA) are larger than signet.json so we use
 * a more generous 256 KB cap. signet.json keeps its own tighter 8 KB cap.
 */
export const MAX_REGISTRY_FETCH_BYTES = 256 * 1024;
