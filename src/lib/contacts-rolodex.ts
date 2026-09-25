import type { KindredEntry, KindredTier } from '@forgesworn/kenspeckle';

export interface RolodexOpts { tier?: KindredTier | 'all'; query?: string }

/** Tier-filter + optional name search + A→Z sort for the Rolodex browser. */
export function arrangeRolodex(entries: KindredEntry[], opts: RolodexOpts): KindredEntry[] {
  const tier = opts.tier ?? 'all';
  const q = (opts.query ?? '').trim().toLowerCase();
  const label = (e: KindredEntry) => (e.displayName || e.pubkey).toLowerCase();
  return entries
    .filter(e => tier === 'all' || e.tier === tier)
    .filter(e => !q || label(e).includes(q))
    .sort((a, b) => label(a).localeCompare(label(b)));
}

/** Sharing a contact's QR discloses THEIR key. Public figures (ken) are
 *  one-tap; privately-verified kith/kin sit behind a confirm. Takes only the
 *  tier (a `KindredEntry` satisfies this) so callers that hold just the tier
 *  — e.g. the share-QR component — can use the same single source of truth. */
export function sharePolicyFor(entry: { tier: KindredTier }): { needsConfirm: boolean } {
  return { needsConfirm: entry.tier !== 'ken' };
}
