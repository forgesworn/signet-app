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
      ['approve-add-dependant', 'approve-app-permission', 'approve-companion-grant', 'approve-verification', 'contacts-grant-approve', 'settings-advanced'],
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
