import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  childRuleId, siteTarget, appTarget, peerTarget, isLiveRule, findRule, rulesFromLegacyGrants, isValidRuleScope, findBlockingAppRule,
} from './child-rules';
import type { ChildRule, RememberedGrant } from '../types';

const DEP = 'a'.repeat(64);
const P1 = 'b'.repeat(64);
const P2 = 'c'.repeat(64);
const NOW = 1_800_000_000_000;
const KEY = 'correct-horse-battery-staple';

function rule(o: Partial<ChildRule> = {}): ChildRule {
  const base = { dependantId: DEP, persona: P1, scope: 'sign-in', target: 'site:https://game.example' as const };
  const r = { ...base, ...o };
  return {
    id: childRuleId(r.dependantId, r.persona, r.scope, r.target),
    decision: 'allow', createdAt: NOW - 1000, updatedAt: NOW - 1000, ...r,
  } as ChildRule;
}
const q = (o = {}) => ({ persona: P1, scope: 'sign-in', targets: ['site:https://game.example' as const], nowMs: NOW, ...o });

describe('childRuleId', () => {
  it('is 32 lowercase hex, stable and case-insensitive', () => {
    const a = childRuleId(DEP, P1, 'sign-in', 'site:https://Game.example');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(childRuleId(DEP.toUpperCase(), P1.toUpperCase(), 'SIGN-IN', 'site:https://game.example')).toBe(a);
    expect(childRuleId(DEP, P2, 'sign-in', 'site:https://game.example')).not.toBe(a);
  });
});

describe('targets', () => {
  it('siteTarget accepts https/localhost origins only, and strips the path', () => {
    expect(siteTarget('https://game.example/path?x=1')).toBe('site:https://game.example');
    expect(siteTarget('http://localhost:5175/a')).toBe('site:http://localhost:5175');
    expect(siteTarget('http://evil.com')).toBeNull();
    expect(siteTarget('nonsense')).toBeNull();
  });
  it('appTarget and peerTarget', () => {
    expect(appTarget('nip55:com.x')).toBe('app:nip55:com.x');
    expect(peerTarget(P1.toUpperCase())).toBe(`peer:${P1}`);
    expect(peerTarget('nope')).toBeNull();
  });
});

describe('isLiveRule', () => {
  it('rejects tombstoned and expired, accepts the rest', () => {
    expect(isLiveRule(rule(), NOW)).toBe(true);
    expect(isLiveRule(rule({ tombstonedAt: 1 }), NOW)).toBe(false);
    expect(isLiveRule(rule({ expiresAt: NOW - 1 }), NOW)).toBe(false);
    expect(isLiveRule(rule({ expiresAt: NOW + 1 }), NOW)).toBe(true);
  });
});

describe('findRule precedence', () => {
  it('exact persona + exact target beats * persona + exact target', () => {
    const exact = rule({ decision: 'deny' });
    const wild = rule({ persona: '*', decision: 'allow' });
    expect(findRule([wild, exact], q())).toBe(exact);
  });
  it('* persona + exact target beats exact persona + * target beats * / *', () => {
    const a = rule({ persona: '*' });
    const b = rule({ target: '*' });
    const c = rule({ persona: '*', target: '*' });
    expect(findRule([c, b, a], q())).toBe(a);
    expect(findRule([c, b], q())).toBe(b);
    expect(findRule([c], q())).toBe(c);
  });
  it('deny wins within a level, across candidate targets', () => {
    const allow = rule({ target: 'app:x', decision: 'allow' });
    const deny = rule({ decision: 'deny' });
    expect(findRule([allow, deny], q({ targets: ['app:x', 'site:https://game.example'] }))?.decision).toBe('deny');
  });
  it('ignores expired, tombstoned, other-scope and other-persona rules', () => {
    const rules = [rule({ expiresAt: NOW - 5 }), rule({ tombstonedAt: 1, persona: '*' }), rule({ scope: 'dm-private' }), rule({ persona: P2 })];
    expect(findRule(rules, q())).toBeNull();
  });
});

describe('A7 scope * and A8 case', () => {
  it("a scope '*' rule matches any scope; deny still wins at its level", () => {
    const block = rule({ scope: '*', persona: '*', target: 'app:com.Bad.App', decision: 'deny' });
    const allow = rule({ target: 'app:com.Bad.App', decision: 'allow' });
    expect(findRule([block], q({ targets: ['app:com.Bad.App'] }))).toBe(block);
    expect(findRule([allow, block], q({ persona: P1, targets: ['app:com.Bad.App'] }))).toBe(block); // A11: a blocked app wins
    const allowStar = rule({ persona: '*', target: 'app:com.Bad.App', decision: 'allow' });
    expect(findRule([allowStar, block], q({ targets: ['app:com.Bad.App'] }))?.decision).toBe('deny');
  });
  it('app targets keep their case, site/peer are lowercased', () => {
    expect(appTarget('com.Example.App')).toBe('app:com.Example.App');
    expect(appTarget('AB'.repeat(32))).toBe('app:' + 'ab'.repeat(32));
    expect(siteTarget('https://Game.Example')).toBe('site:https://game.example');
    const r = rule({ target: 'app:com.Example.App' });
    expect(findRule([r], q({ targets: ['app:com.Example.App'] }))).toBe(r);
    expect(findRule([r], q({ targets: ['app:com.example.app'] }))).toBeNull();
    expect(childRuleId(DEP, P1, 'sign-in', 'app:com.Example.App')).not.toBe(childRuleId(DEP, P1, 'sign-in', 'app:com.example.app'));
  });
});

describe('A11 blocked app', () => {
  it('findBlockingAppRule ignores scope and persona level; findRule returns it before any allow', () => {
    const block = rule({ scope: 'post-public', persona: '*', target: 'app:x', decision: 'deny' });
    const allow = rule({ target: 'app:x', decision: 'allow' });
    expect(findBlockingAppRule([allow, block], { persona: P1, targets: ['app:x'], nowMs: NOW })).toBe(block);
    expect(findRule([allow, block], q({ targets: ['app:x'] }))).toBe(block);
    expect(findBlockingAppRule([rule({ target: 'site:https://g.example', decision: 'deny' })], { persona: P1, targets: ['app:x'], nowMs: NOW })).toBeNull();
    expect(findBlockingAppRule([rule({ persona: P2, target: 'app:x', decision: 'deny' })], { persona: P1, targets: ['app:x'], nowMs: NOW })).toBeNull();
  });
});

describe('A5 scope validation', () => {
  it('kind scopes are integers 0..65535 only', () => {
    expect(isValidRuleScope('kind:0')).toBe(true);
    expect(isValidRuleScope('kind:65535')).toBe(true);
    expect(isValidRuleScope('kind:65536')).toBe(false);
    expect(isValidRuleScope('kind:99999999999')).toBe(false);
    expect(isValidRuleScope('kind:01')).toBe(false);
    expect(isValidRuleScope('*')).toBe(true);
    expect(isValidRuleScope('sign-in')).toBe(true);
    expect(isValidRuleScope('Bad Scope')).toBe(false);
  });
});

describe('rulesFromLegacyGrants', () => {
  const g = (o: Partial<RememberedGrant>): RememberedGrant => ({
    dependantId: DEP, scope: 'sign-in', origin: 'https://game.example', decision: 'allow', decidedAt: 100, ...o,
  });
  it('maps origins to site:/peer: targets and seconds to ms', () => {
    const out = rulesFromLegacyGrants(DEP, [
      g({}), g({ scope: 'dm-private', origin: P2, decision: 'deny', expiresAt: NOW / 1000 + 60 }),
    ], NOW);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ persona: '*', target: 'site:https://game.example', scope: 'sign-in', createdAt: 100_000 });
    expect(out[1]).toMatchObject({ target: `peer:${P2}`, decision: 'deny', expiresAt: (NOW / 1000 + 60) * 1000 });
    expect(out[0].id).toBe(childRuleId(DEP, '*', 'sign-in', 'site:https://game.example'));
  });
  it('drops tombstoned, expired, other-dependant and unmappable grants', () => {
    const out = rulesFromLegacyGrants(DEP, [
      g({ tombstonedAt: 5 }), g({ expiresAt: 10 }), g({ dependantId: 'd'.repeat(64) }), g({ origin: 'http://evil.com' }),
    ], NOW);
    expect(out).toEqual([]);
  });
});

describe('childRules store (DB v26)', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.resetModules();
  });

  it('round-trips encrypted, opens at v26, lists by dependant, and tombstones', async () => {
    const db = await import('./db');
    const r1 = rule();
    const r2 = rule({ dependantId: 'd'.repeat(64), persona: '*' });
    await db.saveChildRule(r1, KEY);
    await db.saveChildRule(r2, KEY);

    const raw = await db.getDb();
    expect(raw.version).toBe(26);
    const row = await raw.get('childRules', r1.id) as Record<string, unknown>;
    expect(row.decision).toBeUndefined();
    expect(row.scope).toBeUndefined();
    expect(row.dependantId).toBe(DEP);
    expect(row.updatedAt).toBe(r1.updatedAt);
    expect(row.encrypted).toBe(true);

    expect(await db.listChildRules(DEP.toUpperCase(), KEY)).toEqual([r1]);
    expect((await db.listAllChildRules(KEY)).map(r => r.id).sort()).toEqual([r1.id, r2.id].sort());
    expect(await db.listChildRules(DEP, 'wrong-passphrase')).toEqual([]);

    await db.tombstoneChildRule(r1.id, KEY, NOW);
    const [t] = await db.listChildRules(DEP, KEY);
    expect(t.tombstonedAt).toBe(NOW);
    expect(t.updatedAt).toBe(NOW);
    expect(isLiveRule(t, NOW + 1)).toBe(false);
  }, 60_000);

  it('purgeAllUserData clears the store', async () => {
    const db = await import('./db');
    await db.saveChildRule(rule(), KEY);
    await db.purgeAllUserData();
    expect(await db.listAllChildRules(KEY)).toEqual([]);
  }, 60_000);
});
