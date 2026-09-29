/**
 * Child gate — the pure per persona x type x site/app decision for a
 * dependant's own phone (child-direct Heartwood pairing, spec §5.3).
 *
 * Built from the existing pure pieces (`inferScope`/`inferOrigin`,
 * `resolvePolicy`, schedules, `checkRateLimit`). No clock, no storage: the
 * caller supplies `nowMs` and the rate-limit state. The gate only READS the
 * rate-limit state; the caller advances it (`checkRateLimit(...).newState`)
 * once per request it lets through to the gate.
 */
import type { UnsignedEvent } from 'signet-protocol';
import type { ChildRuleTarget } from '../types/child-rules';
import type { ChildRulesPayload } from './child-rules-wire';
import { appTarget, findRule, peerTarget, siteTarget } from './child-rules';
import { inferOrigin, inferScope, type Scope } from './scope-inference';
import { resolvePolicy } from './autonomy-gate';
import { intersectSchedules, isWithinSchedule } from './grant-schedule';
import { checkRateLimit, type RateLimitState } from './rate-limit';

export type ChildGateVerdict =
  | { verdict: 'sign'; reason: 'rule' | 'stage'; ruleId?: string; audit: boolean }
  | { verdict: 'deny'; reason: 'rule' | 'rate-limit' | 'disconnected-app'; ruleId?: string }
  | { verdict: 'blocked'; reason: 'schedule'; nextAllowedAt?: number }
  | { verdict: 'ask'; reason: 'stage' | 'outside-ceiling'; alwaysOffered: boolean };

export interface ChildGateInput {
  /** null => nothing cached: every request asks. */
  rules: ChildRulesPayload | null;
  persona: string;
  template: UnsignedEvent;
  appId: string;
  siteOrigin?: string;
  nowMs: number;
  rateState: RateLimitState;
}

/** Candidate rule targets for a request: site, peer, app. Never `*`. */
export function childTargetsFor(template: UnsignedEvent, scope: Scope | null, appId: string, siteOrigin?: string): ChildRuleTarget[] {
  const out: ChildRuleTarget[] = [];
  const inferred = scope ? inferOrigin(template, scope) : null;
  if (inferred) {
    const t = /^https?:/i.test(inferred) ? siteTarget(inferred) : peerTarget(inferred);
    if (t) out.push(t);
  }
  if (siteOrigin) {
    const t = siteTarget(siteOrigin);
    if (t && !out.includes(t)) out.push(t);
  }
  if (appId) {
    const t = appTarget(appId.toLowerCase());
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

const alwaysOffered = (rules: ChildRulesPayload): boolean => rules.stage !== 'full-control';

/** Shared tail: rule lookup, schedule, rule decision, stage matrix. */
function decideWithRules(
  rules: ChildRulesPayload,
  q: { persona: string; scope: Scope | null; scopeKey: string; targets: ChildRuleTarget[]; nowMs: number },
): ChildGateVerdict {
  // A rule for a full-control child is ignored: the stage matrix wins.
  const rule = rules.stage === 'full-control'
    ? null
    : findRule(rules.rules, { persona: q.persona, scope: q.scopeKey, targets: q.targets, nowMs: q.nowMs });

  const effective = intersectSchedules(rules.defaultSchedule, rule?.schedule);
  if (effective) {
    const w = isWithinSchedule(effective, new Date(q.nowMs));
    if (!w.allowed) {
      return { verdict: 'blocked', reason: 'schedule', ...(w.nextAllowedAt ? { nextAllowedAt: w.nextAllowedAt.getTime() } : {}) };
    }
  }

  if (rule) {
    return rule.decision === 'allow'
      ? { verdict: 'sign', reason: 'rule', ruleId: rule.id, audit: true }
      : { verdict: 'deny', reason: 'rule', ruleId: rule.id };
  }

  const policy = resolvePolicy(rules.stage, q.scope);
  if (policy === 'auto') return { verdict: 'sign', reason: 'stage', audit: false };
  if (policy === 'auto-alert' || policy === 'auto-log') return { verdict: 'sign', reason: 'stage', audit: true };
  return { verdict: 'ask', reason: 'stage', alwaysOffered: alwaysOffered(rules) };
}

export function decideChildRequest(input: ChildGateInput): ChildGateVerdict {
  const { rules, persona, template, appId, siteOrigin, nowMs, rateState } = input;
  const app = (appId ?? '').toLowerCase();
  if (rules && rules.disconnectedApps.some(a => a.toLowerCase() === app)) {
    return { verdict: 'deny', reason: 'disconnected-app' };
  }
  if (!checkRateLimit(rateState, nowMs).allowed) return { verdict: 'deny', reason: 'rate-limit' };
  if (!rules) return { verdict: 'ask', reason: 'stage', alwaysOffered: false };

  // A ceiling of [] means every kind (as the firmware reads it).
  if (rules.ceilingKinds.length > 0 && !rules.ceilingKinds.includes(template.kind)) {
    return { verdict: 'ask', reason: 'outside-ceiling', alwaysOffered: alwaysOffered(rules) };
  }

  const scope = inferScope(template);
  return decideWithRules(rules, {
    persona, scope, scopeKey: scope ?? `kind:${template.kind}`,
    targets: childTargetsFor(template, scope, appId, siteOrigin), nowMs,
  });
}

/** nip44 encrypt/decrypt: `dm-private` semantics, target peer + app. */
export function decideChildCrypto(input: {
  rules: ChildRulesPayload | null;
  persona: string;
  appId: string;
  method: 'nip44_encrypt' | 'nip44_decrypt';
  peer: string;
  nowMs: number;
  rateState: RateLimitState;
}): ChildGateVerdict {
  const { rules, persona, appId, peer, nowMs, rateState } = input;
  const app = (appId ?? '').toLowerCase();
  if (rules && rules.disconnectedApps.some(a => a.toLowerCase() === app)) {
    return { verdict: 'deny', reason: 'disconnected-app' };
  }
  if (!checkRateLimit(rateState, nowMs).allowed) return { verdict: 'deny', reason: 'rate-limit' };
  if (!rules) return { verdict: 'ask', reason: 'stage', alwaysOffered: false };

  const targets: ChildRuleTarget[] = [];
  const p = peerTarget(peer);
  if (p) targets.push(p);
  if (app) targets.push(appTarget(app));
  return decideWithRules(rules, { persona, scope: 'dm-private', scopeKey: 'dm-private', targets, nowMs });
}
