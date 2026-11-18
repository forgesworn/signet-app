import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '../types';
import {
  CHILD_MODE_PAGE_RULES,
  childModePageDecision,
  childModeGuardianRefusalCopy,
  type ChildModePageDecisionInput,
} from './child-mode-page-allowlist';

/** Every member of the `Page` union, read from the type's own source. */
function unionPages(): Page[] {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'types', 'routing.ts'), 'utf8');
  const start = src.indexOf('export type Page =');
  const decl = src.slice(start, src.indexOf(';', start));
  return [...decl.matchAll(/'([a-z0-9-]+)'/g)].map(m => m[1] as Page);
}
const ALL = unionPages();

const LIVE_AND_SAVED: Page[] = ['home', 'approve-auth', 'approve-connect', 'relay-auth-ack'];
const LIVE_ONLY: Page[] = [
  'settings', 'web-verify', 'contacts', 'contact-detail', 'contact-new', 'contact-invites', 'contact-handshake', 'ken-add',
];

const base = (over: Partial<ChildModePageDecisionInput> & { page: Page }): ChildModePageDecisionInput => ({
  childMode: 'on', live: true, stableChildId: 'kid', activeDependantId: 'kid', activeDependantResolved: true, ...over,
});

describe('the page rule table', () => {
  it('classifies every Page, and nothing that is not one', () => {
    expect(ALL.length).toBeGreaterThan(60);
    expect(Object.keys(CHILD_MODE_PAGE_RULES).sort()).toEqual([...ALL].sort());
  });

  it('is exactly the owner-approved list', () => {
    const by = (rule: string) => ALL.filter(p => CHILD_MODE_PAGE_RULES[p] === rule).sort();
    expect(by('live-and-saved')).toEqual([...LIVE_AND_SAVED].sort());
    expect(by('live-only')).toEqual([...LIVE_ONLY].sort());
    const refused = ALL.filter(p => !LIVE_AND_SAVED.includes(p) && !LIVE_ONLY.includes(p)).sort();
    expect(by('refuse')).toEqual(refused);
    for (const page of [
      'ken-detail', 'photo-capture', 'activate-real-identity', 'venue-entry', 'vouch-someone', 'settings-signing', 'connections',
      'companion-apps', 'my-keep', 'pro-dashboard', 'contacts-grant-code', 'settings-advanced', 'settings-security', 'shamir',
      'persona-advanced', 'add-dependant', 'family-list', 'approve-verification', 'approve-add-dependant', 'bots',
    ] as Page[]) expect(CHILD_MODE_PAGE_RULES[page], page).toBe('refuse');
  });
});

describe('childModePageDecision: off and unknown', () => {
  it.each(ALL)('%s is allowed when child mode is off, whatever the scope', (page) => {
    expect(childModePageDecision({ page, childMode: 'off', live: false, stableChildId: null, activeDependantId: null, activeDependantResolved: false })).toBe('allow');
    expect(childModePageDecision({ page, childMode: 'off', live: false, stableChildId: null, activeDependantId: 'dep-b', activeDependantResolved: false })).toBe('allow');
  });

  it.each(ALL)('%s while child mode is unknown: home renders, everything else holds', (page) => {
    expect(childModePageDecision({ page, childMode: 'unknown', live: false, stableChildId: null, activeDependantId: null, activeDependantResolved: false }))
      .toBe(page === 'home' ? 'allow' : 'hold');
  });
});

describe('childModePageDecision: child mode on, live', () => {
  it.each(ALL)('%s under the child', (page) => {
    const allowed = LIVE_AND_SAVED.includes(page) || LIVE_ONLY.includes(page);
    expect(childModePageDecision(base({ page }))).toBe(allowed ? 'allow' : 'refuse');
  });

  it.each(ALL.filter(p => p !== 'home'))('%s under the guardian, a sibling or no scope is refused', (page) => {
    for (const activeDependantId of [null, 'dep-b']) {
      expect(childModePageDecision(base({ page, activeDependantId }))).toBe('refuse');
    }
  });

  it('home is allowed whatever the scope', () => {
    for (const activeDependantId of [null, 'dep-b', 'kid']) {
      expect(childModePageDecision(base({ page: 'home', activeDependantId }))).toBe('allow');
    }
    expect(childModePageDecision(base({ page: 'home', stableChildId: null, activeDependantId: null, activeDependantResolved: false }))).toBe('allow');
  });

  it.each(ALL.filter(p => p !== 'home'))('%s with no resolved child is refused, even when a scope is set', (page) => {
    expect(childModePageDecision(base({ page, stableChildId: null, activeDependantId: 'x' }))).toBe('refuse');
    expect(childModePageDecision(base({ page, stableChildId: null, activeDependantId: null, activeDependantResolved: false }))).toBe('refuse');
  });
});

describe('childModePageDecision: live, the scope is the child but its record is not resolved', () => {
  // After a lock the dependants list is empty for one read, and for good if the
  // child's record leaves it: `activeDependant` is null, so a page that renders
  // from it would fall through to the guardian's own screen.
  it.each(ALL.filter(p => p !== 'home' && CHILD_MODE_PAGE_RULES[p] !== 'refuse'))('%s holds (blank), never allows', (page) => {
    expect(childModePageDecision(base({ page, activeDependantResolved: false }))).toBe('hold');
  });
  it('home still renders', () => {
    expect(childModePageDecision(base({ page: 'home', activeDependantResolved: false }))).toBe('allow');
  });
  it.each(ALL.filter(p => CHILD_MODE_PAGE_RULES[p] === 'refuse'))('%s is still refused', (page) => {
    expect(childModePageDecision(base({ page, activeDependantResolved: false }))).toBe('refuse');
  });
  it('a sibling or no scope is still refused, not held', () => {
    expect(childModePageDecision(base({ page: 'settings', activeDependantId: 'dep-b', activeDependantResolved: false }))).toBe('refuse');
    expect(childModePageDecision(base({ page: 'settings', activeDependantId: null, activeDependantResolved: false }))).toBe('refuse');
  });
});

describe('childModePageDecision: a page missing from the table is refused', () => {
  it('reads an unknown page name (stale history entry) as refuse, never allow', () => {
    expect(childModePageDecision(base({ page: 'retired-page' as Page }))).toBe('refuse');
    expect(childModePageDecision(base({ page: 'retired-page' as Page, live: false, activeDependantId: null }))).toBe('refuse');
  });
});

describe('childModePageDecision: child mode on, saved (locked or cold-started)', () => {
  const saved = (over: Partial<ChildModePageDecisionInput> & { page: Page }) =>
    base({ live: false, activeDependantId: null, ...over });

  it.each(ALL)('%s', (page) => {
    const allowed = LIVE_AND_SAVED.includes(page);
    expect(childModePageDecision(saved({ page }))).toBe(allowed ? 'allow' : 'refuse');
  });

  it.each(LIVE_ONLY)('%s (live only) is refused in saved state, even with the child as the scope', (page) => {
    expect(childModePageDecision(saved({ page, activeDependantId: 'kid' }))).toBe('refuse');
  });

  it.each(LIVE_AND_SAVED.filter(p => p !== 'home'))('%s is refused in saved state under a sibling', (page) => {
    expect(childModePageDecision(saved({ page, activeDependantId: 'dep-b', activeDependantResolved: false }))).toBe('refuse');
  });

  it.each(LIVE_AND_SAVED)('%s with the saved read unresolved (no child) is refused, except home', (page) => {
    expect(childModePageDecision(saved({ page, stableChildId: null }))).toBe(page === 'home' ? 'allow' : 'refuse');
  });
});

describe('childModeGuardianRefusalCopy', () => {
  it('names the child and sends the guardian to the PIN', () => {
    expect(childModeGuardianRefusalCopy('RunKid')).toEqual({
      title: 'Child mode is on',
      body: "This needs the guardian, not RunKid. Exit child mode with the guardian's PIN, then try again.",
    });
  });
  it('falls back when the name is empty or only control characters', () => {
    expect(childModeGuardianRefusalCopy('').body).toContain('not your child.');
    expect(childModeGuardianRefusalCopy('\u0000‮').body).toContain('not your child.');
  });
  it('strips control and bidi characters and caps the length', () => {
    const copy = childModeGuardianRefusalCopy('Ru‮nkid');
    expect(copy.body).toContain('not Runkid.');
    const long = childModeGuardianRefusalCopy('x'.repeat(200)).body;
    expect(long).toContain(`not ${'x'.repeat(64)}.`);
  });
});
