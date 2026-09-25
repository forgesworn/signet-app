import { describe, it, expect } from 'vitest';
import { mergeChildSettings } from './child-settings-merge';
import { DEFAULT_CHILD_CEILING, type ChildSettings } from '../types';

const CHILD = 'c'.repeat(64);
const GUARDIAN = '1'.repeat(64);

describe('mergeChildSettings', () => {
  it('saving a ceiling on a record that already carries approvedContacts keeps it', () => {
    const existing: ChildSettings = {
      childPubkey: CHILD,
      guardianPubkey: GUARDIAN,
      contactPolicy: 'approved',
      approvedContacts: ['abc'],
      defaultChildCeiling: 'ken',
    };
    const next = mergeChildSettings(existing, CHILD, GUARDIAN, { defaultChildCeiling: 'kith' });
    expect(next.approvedContacts).toEqual(['abc']);
    expect(next.contactPolicy).toBe('approved');
    expect(next.defaultChildCeiling).toBe('kith');
  });

  it('saving a contact policy preserves an unrelated existing ceiling and approvedContacts', () => {
    const existing: ChildSettings = {
      childPubkey: CHILD,
      guardianPubkey: GUARDIAN,
      contactPolicy: 'kin-only',
      approvedContacts: ['xyz'],
      defaultChildCeiling: 'kin',
    };
    const next = mergeChildSettings(existing, CHILD, GUARDIAN, { contactPolicy: 'open' });
    expect(next.contactPolicy).toBe('open');
    expect(next.defaultChildCeiling).toBe('kin');
    expect(next.approvedContacts).toEqual(['xyz']);
  });

  it('applies the old handler defaults when there is no existing record', () => {
    const next = mergeChildSettings(undefined, CHILD, GUARDIAN, { contactPolicy: 'open' });
    expect(next).toEqual({
      childPubkey: CHILD,
      guardianPubkey: GUARDIAN,
      contactPolicy: 'open',
      defaultChildCeiling: DEFAULT_CHILD_CEILING,
    });
  });

  it('always stamps the passed-in childPubkey and guardianPubkey, never a stale existing value', () => {
    const existing: ChildSettings = {
      childPubkey: 'stale',
      guardianPubkey: 'stale-guardian',
      contactPolicy: 'kin-only',
    };
    const next = mergeChildSettings(existing, CHILD, GUARDIAN, { contactPolicy: 'approved' });
    expect(next.childPubkey).toBe(CHILD);
    expect(next.guardianPubkey).toBe(GUARDIAN);
  });
});
