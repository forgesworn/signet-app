// Pure helpers for the `knownPlaces` store (DB v28). No IndexedDB here —
// db.ts imports this, so the migration and the writer share one definition.

import type { AuthorizedSite, KnownPlace, KnownPlaceInput } from '../types';
import { sanitizeDisplayName } from './text-sanitize';

const HEX64 = /^[0-9a-f]{64}$/;
export const KNOWN_PLACE_NAME_MAX = 64;

export function knownPlaceId(placeKey: string, pubkey: string): string {
  return `${placeKey}:${pubkey.toLowerCase()}`;
}

function cleanName(value: string | undefined): string {
  return sanitizeDisplayName(value ?? '', KNOWN_PLACE_NAME_MAX);
}

/** Normalise an input: lowercase pubkey, sanitised capped strings. Null if unusable. */
export function normaliseKnownPlaceInput(input: KnownPlaceInput): KnownPlaceInput | null {
  const pubkey = input.pubkey.toLowerCase();
  if (!HEX64.test(pubkey) || !input.placeKey) return null;
  const alias = cleanName(input.alias);
  return {
    ...input,
    pubkey,
    name: cleanName(input.name) || cleanName(input.placeKey),
    alias: alias || undefined,
    shared: { ...input.shared },
  };
}

/**
 * Merge a fresh observation into the stored row (or create one). Keeps
 * `firstAt`, the user's `alias` and `pinned`; bumps `uses` and `lastAt`.
 * The sharing facts describe the latest approval, so they replace the old.
 */
export function mergeKnownPlace(
  existing: KnownPlace | undefined,
  input: KnownPlaceInput,
  nowS: number,
): KnownPlace {
  const id = knownPlaceId(input.placeKey, input.pubkey);
  const { alias: inputAlias, ...rest } = input;
  if (!existing) {
    return {
      ...rest,
      ...(inputAlias ? { alias: inputAlias } : {}),
      id,
      firstAt: nowS,
      lastAt: nowS,
      uses: 1,
    };
  }
  const alias = existing.alias ?? inputAlias;
  return {
    ...existing,
    ...rest,
    id,
    ...(alias ? { alias } : {}),
    ...(existing.pinned !== undefined ? { pinned: existing.pinned } : {}),
    firstAt: existing.firstAt,
    lastAt: Math.max(nowS, existing.lastAt),
    uses: existing.uses + 1,
  };
}

/**
 * DB v27 -> v28 migration of one `authorizedSites` row. Null when the row
 * cannot be a known place (bad pubkey or origin). Deterministic id, so a
 * re-run overwrites rather than duplicates.
 */
export function knownPlaceFromAuthorizedSite(site: AuthorizedSite): KnownPlace | null {
  const pubkey = typeof site.pubkeyShared === 'string' ? site.pubkeyShared.toLowerCase() : '';
  if (!HEX64.test(pubkey) || typeof site.origin !== 'string' || !site.origin) return null;
  const alias = cleanName(site.consumerDisplayName);
  const lastAt = typeof site.lastUsedAt === 'number' ? site.lastUsedAt : 0;
  const firstAt = typeof site.authorizedAt === 'number' ? site.authorizedAt : lastAt;
  return {
    id: knownPlaceId(site.origin, pubkey),
    pubkey,
    placeKey: site.origin,
    kind: 'sign-in',
    name: cleanName(site.name) || cleanName(site.origin),
    ...(alias ? { alias } : {}),
    origin: site.origin,
    channel: 'unknown',
    signer: 'unknown',
    firstAt,
    lastAt,
    uses: 1,
    shared: site.shareHandle === undefined ? {} : { handle: site.shareHandle },
  };
}
