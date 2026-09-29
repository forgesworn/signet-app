import type { GrantSchedule } from '../lib/grant-schedule';

/** What a rule applies to: a site origin, an app (NIP-46 client pubkey or
 *  `nip55:<package>`), a peer pubkey, or anything (`*`). */
export type ChildRuleTarget = `site:${string}` | `app:${string}` | `peer:${string}` | '*';

/**
 * Guardian-authored rule for a dependant's own phone (child-direct Heartwood
 * pairing). `persona × scope × target → decision`. Timestamps are
 * milliseconds. Guardian source of truth; the child receives a live-only copy
 * over the rules rail.
 */
export interface ChildRule {
  id: string;
  dependantId: string;
  /** Persona pubkey hex, or `*` for all of the child's personas. */
  persona: string | '*';
  /** `Scope` from scope-inference.ts, or `kind:<n>` for an unclassified kind. */
  scope: string;
  target: ChildRuleTarget;
  decision: 'allow' | 'deny';
  schedule?: GrantSchedule;
  /** Display name of the site/app at decision time. */
  label?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  tombstonedAt?: number;
  lastUsedAt?: number;
}
