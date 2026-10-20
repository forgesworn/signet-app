import type { NostrFilter } from 'signet-protocol';
import { fetchEventsWithReach } from './relay-service';
import { KEEP_CLAIM_KIND, KEEP_RELAYS, KEEP_STATUS_KIND } from './keep-wire';
import { pickActiveClaims, pickStatus, type Keep } from './keep';

export type KeepLoadResult =
  | { ok: true; keeps: Keep[]; now: number }
  | { ok: false };

/**
 * Read the Keeps claimed by `owned` (every key this user owns). Claims are
 * queried by `authors`, never by `#p`; see `keep.ts` for why. Resolves
 * `{ok:false}` when no relay answered, so a network outage is not shown as
 * "no Keep yet".
 */
export async function loadMyKeeps(owned: readonly string[]): Promise<KeepLoadResult> {
  const authors = [...new Set(owned.map(k => k.toLowerCase()).filter(k => /^[0-9a-f]{64}$/.test(k)))];
  if (authors.length === 0) return { ok: true, keeps: [], now: Math.floor(Date.now() / 1000) };
  const claimsRes = await fetchEventsWithReach(
    [{ kinds: [KEEP_CLAIM_KIND], authors, limit: 200 } as NostrFilter],
    { relays: [...KEEP_RELAYS] },
  );
  if (claimsRes.reached === 0) return { ok: false };
  const claims = pickActiveClaims(claimsRes.events, authors);
  if (claims.length === 0) return { ok: true, keeps: [], now: Math.floor(Date.now() / 1000) };
  const statusRes = await fetchEventsWithReach(
    claims.map(c => ({ kinds: [KEEP_STATUS_KIND], authors: [c.node], limit: 5 } as NostrFilter)),
    { relays: [...KEEP_RELAYS] },
  );
  if (statusRes.reached === 0) return { ok: false };
  const keeps = claims.map(claim => ({ claim, status: pickStatus(statusRes.events, claim) }));
  return { ok: true, keeps, now: Math.floor(Date.now() / 1000) };
}
