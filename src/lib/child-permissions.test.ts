import { describe, it, expect } from 'vitest';
import type { ChildRule } from '../types/child-rules';
import type { ConnectedChildApp } from './child-activity';
import { childRuleId, findRule } from './child-rules';
import {
  blockAppRules, ceilingTypeNames, disconnectedAppsFromRules, isAppBlocked, ruleTypeName,
} from './child-permissions';

const DEP = 'd'.repeat(64);
const P = 'b'.repeat(64);
const APP = 'a'.repeat(64);
const NOW = 1_700_000_000_000;

const rule = (over: Partial<ChildRule>): ChildRule => {
  const base = { dependantId: DEP, persona: '*', scope: 'sign-in', target: 'site:https://game.example.com', decision: 'allow', createdAt: 1, updatedAt: 1, ...over } as ChildRule;
  return { ...base, id: over.id ?? childRuleId(base.dependantId, base.persona, base.scope, base.target) };
};
const app = (over: Partial<ConnectedChildApp> = {}): ConnectedChildApp =>
  ({ appId: APP, kind: 'nip46', label: 'Game', persona: P, firstSeen: 1, lastUsed: 2, ...over });

describe('disconnectedAppsFromRules', () => {
  it('lists live *-scope *-persona app deny rules only, newest first', () => {
    const rules = [
      rule({ persona: '*', scope: '*', target: `app:${APP}`, decision: 'deny', updatedAt: 5 }),
      rule({ persona: '*', scope: '*', target: 'app:nip55:com.game', decision: 'deny', updatedAt: 9 }),
      rule({ persona: '*', scope: '*', target: 'app:nip55:com.gone', decision: 'deny', tombstonedAt: 3 }),
      rule({ persona: P, scope: '*', target: 'app:nip55:com.one', decision: 'deny' }),
      rule({ persona: '*', scope: 'sign-in', target: 'app:nip55:com.scoped', decision: 'deny' }),
      rule({ persona: '*', scope: '*', target: 'app:nip55:com.allowed', decision: 'allow' }),
    ];
    expect(disconnectedAppsFromRules(rules, NOW)).toEqual(['nip55:com.game', APP]);
  });
});

describe('blockAppRules', () => {
  it('writes the A7 deny rule for an app, and blocking wins over an exact allow', () => {
    const allow = rule({ persona: P, scope: 'sign-in', target: `app:${APP}`, decision: 'allow' });
    const out = blockAppRules(DEP, app(), [allow], NOW)!;
    expect(out[0]).toMatchObject({ persona: '*', scope: '*', target: `app:${APP}`, decision: 'deny', label: 'Game', updatedAt: NOW });
    expect(out[0].id).toBe(childRuleId(DEP, '*', '*', `app:${APP}`));
    expect(out[1]).toMatchObject({ id: allow.id, tombstonedAt: NOW });
    expect(disconnectedAppsFromRules(out, NOW)).toEqual([APP]);
    expect(findRule([allow, out[0]], { persona: P, scope: 'sign-in', targets: [`app:${APP}`], nowMs: NOW })?.decision).toBe('deny');
  });

  it('blocks a website on its site: target and withdraws its allows', () => {
    const allow = rule({ persona: P, target: 'site:https://game.example.com' });
    const out = blockAppRules(DEP, app({ appId: 'site:https://game.example.com', kind: 'site', url: 'https://game.example.com' }), [allow], NOW)!;
    expect(out[0].target).toBe('site:https://game.example.com');
    expect(out[1].tombstonedAt).toBe(NOW);
    const live = [{ ...allow, ...out[1] }, out[0]];
    expect(findRule(live, { persona: P, scope: 'sign-in', targets: ['site:https://game.example.com'], nowMs: NOW })?.decision).toBe('deny');
  });

  it('isAppBlocked sees either effect', () => {
    expect(isAppBlocked(app(), [], [APP], NOW)).toBe(true);
    const [deny] = blockAppRules(DEP, app(), [], NOW)!;
    expect(isAppBlocked(app(), [deny], [], NOW)).toBe(true);
    expect(isAppBlocked(app(), [], [], NOW)).toBe(false);
  });
});

describe('type names', () => {
  it('names the ceiling from scope names, with Other type (n) for the rest', () => {
    expect(ceilingTypeNames([22242, 21236, 1, 7, 30023], 'request-approve'))
      .toEqual(['Public posts', 'Reactions and replies', 'Sign-in', 'Relay sign-in', 'Other type (30023)']);
    expect(ceilingTypeNames([], 'full-autonomy')).toEqual(['Every type']);
    expect(ceilingTypeNames([], 'request-approve')).toEqual([]);
  });
  it('names rule scopes', () => {
    expect(ruleTypeName('sign-in')).toBe('Sign-in');
    expect(ruleTypeName('kind:30023')).toBe('Other type (30023)');
    expect(ruleTypeName('*')).toBe('Every type');
  });
});

describe('copy', () => {
  it('is British and lives in the copy module', async () => {
    const { CHILD_PERMISSIONS_COPY } = await import('./child-device-copy');
    const text = JSON.stringify(CHILD_PERMISSIONS_COPY, (_k, v) => (typeof v === 'function' ? v('X', 'Y') : v));
    expect(text).not.toMatch(/\b(authoriz|organiz|recogniz|color|canceled|license)\w*/i);
    expect(CHILD_PERMISSIONS_COPY.removePersona('Sky')).toBe("Remove from Sky's phone");
  });
});
