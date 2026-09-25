import type { GrantScope } from '@forgesworn/kenspeckle'
export type { GrantScope }

/**
 * A scoped data grant for a companion app — one row per companion app
 * device pubkey. Distinct from `RememberedGrant` (grants.ts), which is an
 * unrelated per-(dependantId, scope, origin) sign-policy memory for
 * dependant signing decisions. No secret material is stored here: the
 * rail privkey is re-derived on demand rather than persisted. See the
 * companion data rail design.
 */
export interface CompanionGrant {
  appPubkey: string      // key — companion app device pubkey (64-hex)
  appName: string        // sanitised, <=64
  railPubkey: string     // derived; cached for display + fetch continuity
  snapshotRelay: string  // where snapshots publish (user relay at grant time)
  scope: GrantScope
  createdAt: number
  lastPublishedAt?: number
  lastPayloadHash?: string
  lastEventId?: string
  revokedAt?: number
}
