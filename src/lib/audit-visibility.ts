/**
 * Audit-log child-visibility resolver (v2).
 *
 * The guardian-side audit log shipped in v1. v2 lets a
 * dependant on their own paired-child device read their own audit
 * log, with a hybrid-rule:
 *
 *   1. Default by autonomy stage — visible at the autonomous-* stages
 *      (and full-autonomy); hidden at full-control / request-approve
 *      where the guardian is doing the signing for the child anyway.
 *   2. Per-dep override toggle on `DependantIdentity.auditVisibility`
 *      ('default' | 'force-visible' | 'force-hidden') flips the rule
 *      for that specific dep.
 *
 * Resolved-true visibility unlocks two things downstream:
 *   - The audit publisher (`audit.ts`) emits a SECOND gift-wrap
 *     addressed to the dep's NIP-46 client pubkey (the paired-child
 *     device's transport key), so the child's own device can decrypt
 *     it — the guardian's wrap stays canonical for the audit-of-record.
 *   - The paired-child surface renders an "Activity" entry-point that
 *     hits the relay with the dep's client pubkey as the `#p` filter
 *     and decrypts with the client privkey it already holds for the
 *     bunker pairing.
 *
 * Pure helpers — keep this file dependency-free so policy churn is
 * easy to test without spinning up a relay. The 20-case unit test
 * (5 stages × 4 override states) lives in `audit-visibility.test.ts`.
 */

import type { AutonomyStage } from '../types';

/**
 * Per-dep override token. `'default'` (and `undefined`, treated the
 * same) defers to the autonomy-stage rule. `'force-visible'` flips
 * the surface on at any stage — useful for a mature young teen at
 * `request-approve` who would benefit from seeing their own log.
 * `'force-hidden'` flips it off at any stage — useful for a
 * special-needs adult dependant at `full-autonomy` for whom the
 * audit screen is just a navigational hazard.
 */
export type AuditVisibilityOverride = 'default' | 'force-visible' | 'force-hidden';

/**
 * Stage-default rule. Visible at the autonomous-* stages
 * (`autonomous-alerts`, `autonomous-logging`) and `full-autonomy`;
 * hidden at the restricted stages (`full-control`, `request-approve`)
 * where the dep doesn't sign on their own anyway.
 *
 * Switch coverage is exhaustive — TypeScript's `never` check would
 * catch a missing branch, but we keep the explicit `default` case
 * as belt-and-braces against future stage additions silently
 * defaulting visible.
 */
export function defaultVisibilityByStage(stage: AutonomyStage): boolean {
  switch (stage) {
    case 'autonomous-alerts':
    case 'autonomous-logging':
    case 'full-autonomy':
      return true;
    case 'full-control':
    case 'request-approve':
    default:
      return false;
  }
}

/**
 * Compose stage-default and per-dep override into a final visibility
 * decision. The override takes precedence when set to either of the
 * `force-*` values; an unset override (or `'default'`) defers.
 *
 * Used by:
 *   - The audit publisher to decide whether to emit the second
 *     dual-address gift-wrap.
 *   - The paired-child surface to decide whether to render the
 *     "Activity" entry-point (and the resolved current-state line in
 *     GuardianSettings, so the guardian sees the effect of their
 *     toggle choice).
 */
export function resolveAuditVisibility(
  stage: AutonomyStage,
  override: AuditVisibilityOverride | undefined,
): boolean {
  if (override === 'force-visible') return true;
  if (override === 'force-hidden') return false;
  return defaultVisibilityByStage(stage);
}
