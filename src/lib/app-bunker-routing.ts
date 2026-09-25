/**
 * Pure helpers for the trusted-app pairing slot per dependant
 * Live in their own module so they can be
 * unit-tested independently of the React hook + IDB layer.
 */

import type { TrustedAppPairing } from '../types';
import { sanitizeDisplayName } from './text-sanitize';

/** Cap on the human-readable label captured from consumer metadata. */
const MAX_LABEL_LEN = 100;

/**
 * Cap on the raw metadata JSON blob before JSON.parse (security audit
 * 2026-06-15). The blob arrives in a NIP-46 `connect` request param from an
 * untrusted client; an oversized value is a parse-time DoS.
 */
const MAX_METADATA_JSON_LEN = 4096;

/**
 * Sanitise the human-readable label captured from a connecting app's
 * NIP-46 metadata. Mirrors the policy used in `nip46.ts:142-144` for
 * `appName` — strip control + bidi / invisible chars, trim, cap at
 * MAX_LABEL_LEN. Empty input falls back to the default.
 */
export function sanitiseAppLabel(input: unknown, fallback = 'App'): string {
  if (typeof input !== 'string') return fallback;
  const safe = sanitizeDisplayName(input, MAX_LABEL_LEN);
  return safe.length === 0 ? fallback : safe;
}

/**
 * Extract a normalised origin from the `url` field of a NIP-46 metadata
 * blob. Only `https://` and `http://localhost` (or `127.0.0.1`) are
 * accepted. Returns undefined for anything else so callers can safely
 * persist the result without further validation.
 */
export function extractAppOrigin(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  try {
    const u = new URL(input);
    if (u.protocol === 'https:') return u.origin.slice(0, 200);
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
      return u.origin.slice(0, 200);
    }
  } catch { /* invalid URL */ }
  return undefined;
}

/**
 * Parse the NIP-46 `connect` request's third param (metadata blob) into
 * sanitised `{ label, origin }`. The blob is JSON; both fields are
 * optional. Always returns a label (defaulted) and an optional origin.
 */
export function parseConnectMetadata(metadataParam: unknown): { label: string; origin?: string } {
  if (typeof metadataParam !== 'string' || metadataParam.length === 0 || metadataParam.length > MAX_METADATA_JSON_LEN) {
    return { label: 'App' };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(metadataParam); }
  catch { return { label: 'App' }; }
  if (typeof parsed !== 'object' || parsed === null) return { label: 'App' };
  const m = parsed as Record<string, unknown>;
  return {
    label: sanitiseAppLabel(m.name),
    origin: extractAppOrigin(m.url),
  };
}

/**
 * Returns true if any pairing in the list matches the given client
 * pubkey (case-insensitive). Used by the per-request gate for app
 * routes — `pairings` is read fresh from IDB on each request to avoid
 * stale state after a recent bind.
 */
export function pairingMatches(pairings: TrustedAppPairing[], clientPubkey: string): boolean {
  if (!Array.isArray(pairings) || pairings.length === 0) return false;
  const lc = clientPubkey.toLowerCase();
  for (const p of pairings) {
    if (typeof p?.clientPubkey === 'string' && p.clientPubkey.toLowerCase() === lc) return true;
  }
  return false;
}
