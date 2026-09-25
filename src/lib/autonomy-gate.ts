/**
 * Enforcement point for the dependant `autonomyStage` field.
 *
 * The guardian picks a stage in GuardianSettings. Up until now the
 * field was stored and displayed but never gated anything — every
 * sign-in / pairing from child-mode proceeded regardless. This
 * module translates stage → sign-time policy decision.
 *
 * | Stage                  | On-device (this module)             | Bunker scope (`resolvePolicy` below) |
 * |------------------------|--------------------------------------|---------------------------------------|
 * | full-control           | Require guardian PIN                | ask-every (queued for guardian      |
 * |                        |                                      |   approval — every action, no       |
 * |                        |                                      |   allow-always grants)              |
 * | request-approve        | Require guardian PIN                | per-scope: ask-origin / ask-every    |
 * | autonomous-alerts      | Allow (publishing the alert is TODO) | per-scope                            |
 * | autonomous-logging     | Allow (audit log is TODO)            | per-scope                            |
 * | full-autonomy          | Allow                                | per-scope                            |
 *
 * The split reflects the device split: `checkAutonomy` runs when the
 * guardian's app is signing on behalf of a dependant who shares this
 * device (tap-to-enter child mode). The guardian is right there, so
 * `full-control` softens to "require guardian PIN" — the strictest
 * mode that still has a path forward. `resolvePolicy` runs when a
 * paired-child device asks the guardian's bunker server to sign; at
 * `full-control` the request is queued for guardian approval via the
 * existing modal queue (same path as `request-approve`'s ask-every)
 * but without persisting allow-always grants — keeping full-control
 * meaningfully stricter than request-approve. The 18+/professionally-
 * gated scopes that should NEVER reach the guardian's queue are
 * enforced at the consumer layer (the site requires a credential the
 * dep can't present), not at this scope-level matrix.
 *
 * The `autonomous-alerts` and `autonomous-logging` stages currently
 * pass through without emitting anything — the visibility side
 * (relay-published parent notifications, local audit-log IDB store)
 * is follow-up work. Documented in the comments so a future reader
 * doesn't assume the stage is a no-op.
 *
 * Used by App.tsx's approve handlers: call `checkAutonomy` before
 * signing; if it says `require-pin`, await `requestFreshAuth()` and
 * bail if the user cancels. If it says `block`, throw with a
 * friendly error that the approve screen renders verbatim.
 */

import type { AutonomyStage } from '../types';
import type { Scope } from './scope-inference';

export type AutonomyDecision =
  | { kind: 'allow' }
  | { kind: 'require-pin' }
  | { kind: 'block'; message: string };

export function checkAutonomy(stage: AutonomyStage): AutonomyDecision {
  switch (stage) {
    case 'full-control':
      // Same-device guardian flow: the guardian is on this phone, so
      // require their PIN per action rather than refusing entirely.
      // Cross-device (paired-child) full-control queues the request for
      // guardian approval via the bunker server — see `resolvePolicy`
      // below.
      return { kind: 'require-pin' };
    case 'request-approve':
      return { kind: 'require-pin' };
    case 'autonomous-alerts':
    case 'autonomous-logging':
    case 'full-autonomy':
      return { kind: 'allow' };
  }
}

/**
 * Policy outcome for a specific (scope, stage) cell of the interaction matrix
 * defined in the 2026-04-22 dependant-accounts spec §"Graduated Autonomy".
 *
 * - `blocked`        — refuse with "ask your guardian" (full-control + scope-specific blocks)
 * - `ask-origin`     — surface a prompt; if the user chooses "allow always" a
 *                      `(dependantId, scope, origin)` grant is persisted
 * - `ask-every`      — surface a prompt; no grant persistence
 * - `auto-alert`     — sign silently + emit a metadata-only alert
 * - `auto-log`       — sign silently + write a metadata-only audit entry
 * - `auto`           — sign silently
 */
export type Policy = 'blocked' | 'ask-origin' | 'ask-every' | 'auto-alert' | 'auto-log' | 'auto';

/**
 * Scope × stage matrix encoding the user-facing spec table. See the
 * internal dependant-accounts-and-guardian-delegation design doc.
 * Keep this in sync if the spec matrix changes.
 */
const POLICY_MATRIX: Record<Scope, Record<AutonomyStage, Policy>> = {
  'sign-in': {
    'full-control': 'ask-every', 'request-approve': 'ask-origin',
    'autonomous-alerts': 'auto-alert', 'autonomous-logging': 'auto-log',
    'full-autonomy': 'auto',
  },
  'venue-entry': {
    'full-control': 'ask-every', 'request-approve': 'auto',
    'autonomous-alerts': 'auto', 'autonomous-logging': 'auto',
    'full-autonomy': 'auto',
  },
  'post-public': {
    'full-control': 'ask-every', 'request-approve': 'ask-every',
    'autonomous-alerts': 'auto-alert', 'autonomous-logging': 'auto-log',
    'full-autonomy': 'auto',
  },
  'dm-private': {
    'full-control': 'ask-every', 'request-approve': 'ask-origin',
    'autonomous-alerts': 'auto-alert', 'autonomous-logging': 'auto-log',
    'full-autonomy': 'auto',
  },
  'upload-photo': {
    'full-control': 'ask-every', 'request-approve': 'ask-origin',
    'autonomous-alerts': 'auto-alert', 'autonomous-logging': 'auto-log',
    'full-autonomy': 'auto',
  },
  'react-zap-reply': {
    'full-control': 'ask-every', 'request-approve': 'ask-origin',
    'autonomous-alerts': 'auto-alert', 'autonomous-logging': 'auto-log',
    'full-autonomy': 'auto',
  },
  'pair-device': {
    'full-control': 'ask-every', 'request-approve': 'ask-every',
    'autonomous-alerts': 'ask-every', 'autonomous-logging': 'ask-every',
    'full-autonomy': 'auto',
  },
  'mutate-identity': {
    'full-control': 'ask-every', 'request-approve': 'ask-every',
    'autonomous-alerts': 'auto-alert', 'autonomous-logging': 'auto-log',
    'full-autonomy': 'auto',
  },
};

/**
 * Resolve the (stage, scope) → policy cell. Null scope (unclassified Nostr
 * kind from `inferScope`) is treated conservatively: ASK-EVERY except at
 * full-autonomy where it's AUTO (the dependant is functionally independent).
 */
export function resolvePolicy(stage: AutonomyStage, scope: Scope | null): Policy {
  if (scope === null) {
    return stage === 'full-autonomy' ? 'auto' : 'ask-every';
  }
  return POLICY_MATRIX[scope][stage];
}

/**
 * Scopes whose ASK-ORIGIN policy persists a `(dependantId, scope, origin)`
 * grant when the guardian taps "allow always". Other ASK-EVERY scopes have
 * no natural origin to scope the grant to, so approve-always degrades to
 * approve-once.
 */
export function isOriginScopedScope(scope: Scope): boolean {
  return scope === 'sign-in'
    || scope === 'dm-private'
    || scope === 'upload-photo'
    || scope === 'react-zap-reply';
}
