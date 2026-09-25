/**
 * `ChildSettings` read-path lift (§7.10, §16).
 *
 * `'family-only'` reads as `'kin-only'` and a missing `defaultChildCeiling`
 * reads as `'ken'`. Pure and idempotent, in the same shape as
 * `liftPublicProfileConfig`: applied on every read, never a stored rewrite, so
 * a downgrade to an older build still finds the value it wrote.
 *
 * The ceiling default is not decoration. Lifting `family-only` to `kin-only`
 * widens the admitted set from family to close circle, so the lift ships WITH
 * a guardian ceiling on child-added contacts; otherwise an existing dependant
 * silently gains the ability to admit anyone they call Kin.
 */

import { DEFAULT_CHILD_CEILING, type ChildSettings } from '../types';

export type ContactPolicy = 'kin-only' | 'approved' | 'open';

/** Unrecognised input resolves to the most restrictive policy, never the loosest. */
export function liftContactPolicy(stored: unknown): ContactPolicy {
  if (stored === 'approved' || stored === 'open' || stored === 'kin-only') return stored;
  return 'kin-only'; // covers 'family-only' and anything corrupt
}

export function liftChildSettings<T extends ChildSettings>(raw: T | undefined): T | undefined {
  if (!raw) return undefined;
  return {
    ...raw,
    contactPolicy: liftContactPolicy(raw.contactPolicy),
    defaultChildCeiling: raw.defaultChildCeiling ?? DEFAULT_CHILD_CEILING,
  };
}
