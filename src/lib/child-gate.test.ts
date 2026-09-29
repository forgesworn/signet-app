import { describe, it, expect } from 'vitest';
import type { UnsignedEvent } from 'signet-protocol';
import { decideChildRequest, decideChildCrypto, childTargetsFor, type ChildGateVerdict } from './child-gate';
import type { ChildRulesPayload } from './child-rules-wire';
import type { ChildRule } from '../types/child-rules';
import type { AutonomyStage } from '../types/dependants';
import { childRuleId } from './child-rules';
import { resolvePolicy } from './autonomy-gate';
import type { Scope } from './scope-inference';
import type { GrantSchedule } from './grant-schedule';

const DEP = 'd'.repeat(64), P1 = 'a'.repeat(64), P2 = 'b'.repeat(64), APP = 'c'.repeat(64), PEER = 'e'.repeat(64);
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0); // Tuesday noon UTC
const FRESH = { count: 0, windowStart: NOW };
const STAGES: AutonomyStage[] = ['full-control', 'request-approve', 'autonomous-alerts', 'autonomous-logging', 'full-autonomy'];

const TEMPLATES: Record<Scope, UnsignedEvent> = {
  'sign-in': { kind: 21236, pubkey: P1, created_at: 1, tags: [['origin', 'https://a.example']], content: '' },
  'venue-entry': { kind: 21235, pubkey: P1, created_at: 1, tags: [], content: '' },
  'post-public': { kind: 1, pubkey: P1, created_at: 1, tags: [], content: 'hi' },
  'dm-private': { kind: 13, pubkey: P1, created_at: 1, tags: [['p', PEER]], content: '' },
  'upload-photo': { kind: 24242, pubkey: P1, created_at: 1, tags: [['u', 'https://blossom.example/upload']], content: '' },
  'react-zap-reply': { kind: 7, pubkey: P1, created_at: 1, tags: [['p', PEER]], content: '+' },
  'pair-device': { kind: 24133, pubkey: P1, created_at: 1, tags: [], content: '' },
  'mutate-identity': { kind: 0, pubkey: P1, created_at: 1, tags: [], content: '{}' },
};

function rule(over: Partial<ChildRule> = {}): ChildRule {
  const persona = over.persona ?? P1, scope = over.scope ?? 'sign-in', target = over.target ?? 'site:https://a.example';
  return { id: childRuleId(DEP, persona, scope, target), dependantId: DEP, persona, scope, target, decision: 'allow',
    createdAt: 1, updatedAt: 1, ...over } as ChildRule;
}
function payload(over: Partial<ChildRulesPayload> = {}): ChildRulesPayload {
  const stage = over.stage ?? 'request-approve';
  // An empty ceiling means "all kinds" only at full-autonomy (A14): default to every test kind elsewhere.
  const ceilingKinds = stage === 'full-autonomy' ? [] : [0, 1, 7, 13, 21235, 21236, 24133, 24242, 30023];
  return { v: 1, dependantId: DEP, stage, ceilingKinds, rules: [], disconnectedApps: [], updatedAt: 1, ...over };
}
const run = (rules: ChildRulesPayload | null, scope: Scope = 'sign-in', over: Partial<Parameters<typeof decideChildRequest>[0]> = {}): ChildGateVerdict =>
  decideChildRequest({ rules, persona: P1, template: TEMPLATES[scope], appId: APP, nowMs: NOW, rateState: FRESH, ...over });

describe('stage matrix (no rules)', () => {
  for (const stage of STAGES) for (const scope of Object.keys(TEMPLATES) as Scope[]) {
    it(`${stage} x ${scope}`, () => {
      const policy = resolvePolicy(stage, scope);
      const v = run(payload({ stage }), scope);
      if (policy === 'auto') expect(v).toEqual({ verdict: 'sign', reason: 'stage', audit: false });
      else if (policy === 'auto-alert' || policy === 'auto-log') expect(v).toEqual({ verdict: 'sign', reason: 'stage', audit: true });
      else expect(v).toEqual({ verdict: 'ask', reason: 'stage', alwaysOffered: stage !== 'full-control' });
    });
  }
  it('unclassified kind asks (auto only at full-autonomy)', () => {
    const t = { ...TEMPLATES['venue-entry'], kind: 30023 } as UnsignedEvent;
    expect(run(payload({ stage: 'autonomous-logging' }), 'sign-in', { template: t }).verdict).toBe('ask');
    expect(run(payload({ stage: 'full-autonomy' }), 'sign-in', { template: t }).verdict).toBe('sign');
  });
});

describe('rules', () => {
  it('allow rule for site A signs A, asks for site B', () => {
    const p = payload({ rules: [rule()] });
    expect(run(p)).toMatchObject({ verdict: 'sign', reason: 'rule', audit: true });
    const b = { ...TEMPLATES['sign-in'], tags: [['origin', 'https://b.example']] };
    expect(run(p, 'sign-in', { template: b })).toMatchObject({ verdict: 'ask', reason: 'stage', alwaysOffered: true });
  });
  it('persona-specific deny beats * allow', () => {
    const p = payload({ rules: [rule({ persona: '*' }), rule({ persona: P1, decision: 'deny' })] });
    // exact persona + target level wins first
    expect(run(p).verdict).toBe('deny');
    expect(run(p, 'sign-in', { persona: P2 })).toMatchObject({ verdict: 'sign', reason: 'rule' });
  });
  it('app rule matches on appId', () => {
    const p = payload({ rules: [rule({ target: `app:${APP}`, scope: 'post-public' })] });
    expect(run(p, 'post-public')).toMatchObject({ verdict: 'sign', reason: 'rule' });
  });
  it('a disconnected app denies even with an allow rule', () => {
    const p = payload({ rules: [rule({ target: `app:${APP}` })], disconnectedApps: [APP] });
    expect(run(p)).toEqual({ verdict: 'deny', reason: 'disconnected-app' });
  });
  it('kind outside the ceiling asks; empty ceiling means all', () => {
    expect(run(payload({ ceilingKinds: [1] }))).toEqual({ verdict: 'ask', reason: 'outside-ceiling', alwaysOffered: true });
    expect(run(payload({ ceilingKinds: [21236], rules: [rule()] })).verdict).toBe('sign');
    expect(run(payload({ stage: 'full-autonomy', ceilingKinds: [] })).verdict).toBe('sign');
    // A14: an empty ceiling below full-autonomy admits nothing
    expect(run(payload({ ceilingKinds: [], rules: [rule()] }))).toEqual({ verdict: 'ask', reason: 'outside-ceiling', alwaysOffered: true });
  });
  it('out-of-ceiling at full-control offers no Always', () => {
    expect(run(payload({ stage: 'full-control', ceilingKinds: [1] }))).toEqual({ verdict: 'ask', reason: 'outside-ceiling', alwaysOffered: false });
  });
  it('a paused default schedule blocks; an outside-hours one reports nextAllowedAt', () => {
    const paused: GrantSchedule = { v: 1, tz: 'UTC', paused: true, weekly: {}, issuedAt: 1 };
    expect(run(payload({ defaultSchedule: paused, rules: [rule()] }))).toEqual({ verdict: 'blocked', reason: 'schedule' });
    const evening: GrantSchedule = { v: 1, tz: 'UTC', weekly: { tue: [{ start: '18:00', end: '20:00' }] }, issuedAt: 1 };
    const v = run(payload({ defaultSchedule: evening }));
    expect(v).toMatchObject({ verdict: 'blocked', reason: 'schedule' });
    expect((v as { nextAllowedAt?: number }).nextAllowedAt).toBe(Date.UTC(2026, 8, 29, 18, 0, 0));
  });
  it('a rule schedule intersects the default', () => {
    const r = rule({ schedule: { v: 1, tz: 'UTC', paused: true, weekly: {}, issuedAt: 1 } });
    expect(run(payload({ rules: [r] })).verdict).toBe('blocked');
  });
  it('rules: null asks, never offering Always', () => {
    expect(run(null)).toEqual({ verdict: 'ask', reason: 'stage', alwaysOffered: false });
  });
  it('rate limit denies once the window is full', () => {
    const p = payload({ stage: 'full-autonomy' });
    expect(run(p, 'sign-in', { rateState: { count: 9, windowStart: NOW } }).verdict).toBe('sign');
    expect(run(p, 'sign-in', { rateState: { count: 10, windowStart: NOW } })).toEqual({ verdict: 'deny', reason: 'rate-limit' });
    expect(run(p, 'sign-in', { rateState: { count: 10, windowStart: NOW - 61_000 } }).verdict).toBe('sign');
  });
  it('a full-control child ignores an allow rule', () => {
    expect(run(payload({ stage: 'full-control', rules: [rule()] }))).toEqual({ verdict: 'ask', reason: 'stage', alwaysOffered: false });
  });
  it('an expired rule is ignored', () => {
    expect(run(payload({ rules: [rule({ expiresAt: NOW - 1 })] })).verdict).toBe('ask');
  });
  it('unclassified kind uses a kind:<n> rule scope', () => {
    const t = { ...TEMPLATES['post-public'], kind: 30023 };
    const r = rule({ scope: 'kind:30023', target: `app:${APP}` });
    expect(run(payload({ rules: [r] }), 'sign-in', { template: t })).toMatchObject({ verdict: 'sign', reason: 'rule' });
  });
});

describe('round 2 gate rules', () => {
  it('A11: a blocked app denies before any allow, any persona level, any scope', () => {
    const block = rule({ scope: '*', persona: '*', target: `app:${APP}`, decision: 'deny' });
    const allow = rule({ persona: P1, scope: 'sign-in', target: 'site:https://a.example' });
    expect(run(payload({ stage: 'full-autonomy', rules: [allow, block] }))).toEqual({ verdict: 'deny', reason: 'rule', ruleId: block.id });
    const blockScoped = rule({ scope: 'post-public', persona: P1, target: `app:${APP}`, decision: 'deny' });
    expect(run(payload({ rules: [allow, blockScoped] })).verdict).toBe('deny'); // different scope than the request
  });
  it('A17: deny rules apply at full-control, allow rules do not', () => {
    const deny = rule({ decision: 'deny' });
    expect(run(payload({ stage: 'full-control', rules: [deny] }))).toMatchObject({ verdict: 'deny', reason: 'rule' });
    expect(run(payload({ stage: 'full-control', rules: [rule()] })).verdict).toBe('ask');
  });
  it('A14: schedule is checked before the ceiling', () => {
    const paused: GrantSchedule = { v: 1, tz: 'UTC', paused: true, weekly: {}, issuedAt: 1 };
    expect(run(payload({ defaultSchedule: paused, ceilingKinds: [1] })).verdict).toBe('blocked');
  });
  it('A14: rate limit is checked before the schedule', () => {
    const paused: GrantSchedule = { v: 1, tz: 'UTC', paused: true, weekly: {}, issuedAt: 1 };
    expect(run(payload({ defaultSchedule: paused }), 'sign-in', { rateState: { count: 10, windowStart: NOW } })).toEqual({ verdict: 'deny', reason: 'rate-limit' });
  });
  it('A13: app:mysignet is a usable target', () => {
    const r = rule({ target: 'app:mysignet', scope: 'sign-in' });
    expect(run(payload({ rules: [r] }), 'sign-in', { appId: 'mysignet' })).toMatchObject({ verdict: 'sign', reason: 'rule' });
  });
});

describe('decideChildCrypto', () => {
  const crypto = (rules: ChildRulesPayload | null, over = {}) =>
    decideChildCrypto({ rules, persona: P1, appId: APP, method: 'nip44_encrypt', peer: PEER, nowMs: NOW, rateState: FRESH, ...over });
  it('follows dm-private stage semantics', () => {
    expect(crypto(payload({ stage: 'full-autonomy' }))).toMatchObject({ verdict: 'sign', reason: 'stage' });
    expect(crypto(payload({ stage: 'request-approve' }))).toMatchObject({ verdict: 'ask', alwaysOffered: true });
    expect(crypto(payload({ stage: 'autonomous-alerts' }))).toMatchObject({ verdict: 'sign', audit: true });
  });
  it('peer rule signs that peer only', () => {
    const p = payload({ rules: [rule({ scope: 'dm-private', target: `peer:${PEER}` })] });
    expect(crypto(p)).toMatchObject({ verdict: 'sign', reason: 'rule' });
    expect(crypto(p, { peer: 'f'.repeat(64) }).verdict).toBe('ask');
  });
  it('app rule, disconnected app, null rules, rate limit', () => {
    expect(crypto(payload({ rules: [rule({ scope: 'dm-private', target: `app:${APP}` })] })).verdict).toBe('sign');
    expect(crypto(payload({ disconnectedApps: [APP] }))).toEqual({ verdict: 'deny', reason: 'disconnected-app' });
    expect(crypto(null)).toEqual({ verdict: 'ask', reason: 'stage', alwaysOffered: false });
    expect(crypto(payload(), { rateState: { count: 10, windowStart: NOW } })).toEqual({ verdict: 'deny', reason: 'rate-limit' });
  });
  it('full-control ignores a peer rule', () => {
    const p = payload({ stage: 'full-control', rules: [rule({ scope: 'dm-private', target: `peer:${PEER}` })] });
    expect(crypto(p)).toEqual({ verdict: 'ask', reason: 'stage', alwaysOffered: false });
  });
});

describe('childTargetsFor', () => {
  it('yields site, peer and app, never *', () => {
    expect(childTargetsFor(TEMPLATES['sign-in'], 'sign-in', APP)).toEqual(['site:https://a.example', `app:${APP}`]);
    expect(childTargetsFor(TEMPLATES['dm-private'], 'dm-private', APP, 'https://x.example')).toEqual([`peer:${PEER}`, 'site:https://x.example', `app:${APP}`]);
    expect(childTargetsFor(TEMPLATES['post-public'], 'post-public', 'nip55:com.x')).toEqual(['app:nip55:com.x']);
  });
});
