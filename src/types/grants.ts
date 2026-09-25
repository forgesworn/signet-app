import type { GrantSchedule } from '../lib/grant-schedule';

export type { GrantSchedule, ScheduleWindow, WeeklySchedule } from '../lib/grant-schedule';

/**
 * Remembered grant for dependant signing — `(dependantId, scope, origin) → decision`.
 * Lives on the guardian's phone only; never cached on the child device. Evaluated
 * on every incoming sign request. See 2026-04-22 dependant-accounts spec
 * §"Remembered grants".
 *
 * `origin` is a normalised URL (https://roblox.com) for sign-in / age-verify /
 * upload-photo, OR a hex pubkey for dm-private / react-zap-reply.
 */
export interface RememberedGrant {
  dependantId: string;
  /** Scope name from `src/lib/scope-inference.ts`'s Scope union. */
  scope: string;
  origin: string;
  decision: 'allow' | 'deny';
  decidedAt: number;
  expiresAt?: number;
  lastUsedAt?: number;
  /**
   * Soft-delete marker for cross-device sync. When set, the
   * grant is treated as absent by `lookupGrant` / `listGrantsForDependant`
   * but kept in IDB so the tombstone propagates to other devices under
   * last-write-wins on sync. Carries the unix-seconds timestamp of the
   * revocation. A remote record with a newer tombstone supersedes a
   * local allow/deny; a remote allow/deny with a newer `decidedAt` can
   * supersede a local tombstone (forward-only within its own field).
   */
  tombstonedAt?: number;
  /**
   * Per-origin schedule clause (Charter clause #1). When set, takes
   * precedence over the dep-level default for sign-time enforcement.
   * Local-only in v1 — does NOT cross the wire in `grants-sync` and
   * is preserved across remote-wins merges via the same merge
   * discipline as bunkerEndpoint / appBunkerEndpoint (see
   * `mergeGrantLists`). Phase 3 of the schedule rollout will move it
   * onto the wire shape for cross-device parity.
   */
  schedule?: GrantSchedule;
}
