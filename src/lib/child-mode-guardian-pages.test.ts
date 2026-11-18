import { describe, it, expect } from 'vitest';
import type { Page } from '../types';
import type { ChildModeState } from './child-mode-sign-in';
import {
  CHILD_MODE_GUARDIAN_PAGES,
  childModePageDecision,
  childModeGuardianRefusalCopy,
} from './child-mode-guardian-pages';

const STATES: ChildModeState[] = ['on', 'off', 'unknown'];
const EXPECT: Record<ChildModeState, string> = { on: 'refuse', off: 'allow', unknown: 'hold' };

describe('childModePageDecision', () => {
  it('lists the guardian-only pages', () => {
    expect([...CHILD_MODE_GUARDIAN_PAGES].sort()).toEqual(
      [
        'activity', 'add-dependant', 'approve-add-dependant', 'approve-app-permission', 'approve-companion-grant', 'approve-verification',
        'child-permissions', 'contacts-grant-approve', 'family-contacts', 'family-list', 'import-dependant', 'pair-dependant-app',
        'pair-dependant-device', 'persona-advanced', 'settings-advanced', 'settings-personas', 'settings-security', 'shamir',
        'transition-ceremony',
      ],
    );
  });

  it.each(CHILD_MODE_GUARDIAN_PAGES.flatMap(page => STATES.map(state => [page, state] as const)))(
    '%s in child mode %s',
    (page, state) => {
      expect(childModePageDecision({ page, childMode: state })).toBe(EXPECT[state]);
    },
  );

  it.each(['home', 'contacts-grant-code', 'settings', 'approve-auth', 'get-verified'] as Page[])(
    '%s is always allowed',
    (page) => {
      for (const childMode of STATES) expect(childModePageDecision({ page, childMode })).toBe('allow');
    },
  );
});

describe('childModePageDecision: live child mode, other scopes', () => {
  const live = (activeDependantId: string | null, childDependantId: string | null = 'kid') => ({ childDependantId, activeDependantId });

  it.each(['contacts', 'settings', 'contact-handshake', 'bots', 'settings-signing'] as Page[])(
    '%s under the guardian or a sibling is refused, with no PIN',
    (page) => {
      expect(childModePageDecision({ page, childMode: 'on', liveChild: live(null) })).toBe('refuse');
      expect(childModePageDecision({ page, childMode: 'on', liveChild: live('dep-b') })).toBe('refuse');
    },
  );

  it.each(['contacts', 'settings', 'contact-handshake'] as Page[])('%s under the child is allowed', (page) => {
    expect(childModePageDecision({ page, childMode: 'on', liveChild: live('kid') })).toBe('allow');
  });

  it('home is never refused, whatever the scope', () => {
    expect(childModePageDecision({ page: 'home', childMode: 'on', liveChild: live(null) })).toBe('allow');
  });

  it('with no child to match, every page but home is refused', () => {
    expect(childModePageDecision({ page: 'settings', childMode: 'on', liveChild: live('kid', null) })).toBe('refuse');
  });

  it.each([
    ['no child, no scope', { childDependantId: null, activeDependantId: null }],
    ['no child, a scope', { childDependantId: null, activeDependantId: 'x' }],
    ['a child, no scope', { childDependantId: 'kid', activeDependantId: null }],
  ])('%s: only home is allowed', (_name, liveChild) => {
    for (const page of ['contacts', 'settings', 'contact-handshake', 'bots', 'settings-signing', 'approve-auth'] as Page[]) {
      expect(childModePageDecision({ page, childMode: 'on', liveChild }), page).toBe('refuse');
    }
    expect(childModePageDecision({ page: 'home', childMode: 'on', liveChild })).toBe('allow');
  });

  it.each(['pair-dependant-device', 'pair-dependant-app', 'child-permissions', 'family-list', 'add-dependant', 'import-dependant', 'transition-ceremony', 'activity'] as Page[])(
    '%s is refused even under the child\'s own scope (in-app back from before child mode)',
    (page) => {
      expect(childModePageDecision({ page, childMode: 'on', liveChild: live('kid', 'kid') })).toBe('refuse');
    },
  );

  it('saved (locked) or unknown child mode is unchanged: no live scope is read', () => {
    for (const childMode of ['off', 'unknown'] as ChildModeState[]) {
      for (const page of ['contacts', 'approve-auth', 'approve-connect', 'settings'] as Page[]) {
        expect(childModePageDecision({ page, childMode, liveChild: live(null) })).toBe('allow');
        expect(childModePageDecision({ page, childMode })).toBe('allow');
      }
    }
    expect(childModePageDecision({ page: 'approve-auth', childMode: 'on', liveChild: null })).toBe('allow');
    expect(childModePageDecision({ page: 'contacts', childMode: 'on' })).toBe('allow');
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
