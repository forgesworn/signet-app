import { describe, it, expect } from 'vitest';
import { liftContactPolicy, liftChildSettings } from './lift-child-settings';
import type { ChildSettings } from '../types';

const CHILD = '1'.repeat(64);
const GUARDIAN = '2'.repeat(64);

describe('liftContactPolicy', () => {
  it('reads the retired family-only value as kin-only', () => {
    expect(liftContactPolicy('family-only')).toBe('kin-only');
  });

  it('passes the current values through', () => {
    expect(liftContactPolicy('kin-only')).toBe('kin-only');
    expect(liftContactPolicy('approved')).toBe('approved');
    expect(liftContactPolicy('open')).toBe('open');
  });

  it('falls back to the safest policy for anything unrecognised', () => {
    expect(liftContactPolicy(undefined)).toBe('kin-only');
    expect(liftContactPolicy('whatever')).toBe('kin-only');
    expect(liftContactPolicy(7)).toBe('kin-only');
  });
});

describe('liftChildSettings', () => {
  it('lifts the policy and defaults the guardian ceiling to ken', () => {
    const stored = { childPubkey: CHILD, guardianPubkey: GUARDIAN, contactPolicy: 'family-only' } as unknown as ChildSettings;
    const lifted = liftChildSettings(stored)!;
    expect(lifted.contactPolicy).toBe('kin-only');
    expect(lifted.defaultChildCeiling).toBe('ken');
  });

  it('keeps an explicitly configured ceiling', () => {
    const stored: ChildSettings = { childPubkey: CHILD, guardianPubkey: GUARDIAN, contactPolicy: 'open', defaultChildCeiling: 'kith' };
    expect(liftChildSettings(stored)!.defaultChildCeiling).toBe('kith');
  });

  it('preserves unrelated fields and is idempotent', () => {
    const stored: ChildSettings = { childPubkey: CHILD, guardianPubkey: GUARDIAN, contactPolicy: 'approved', approvedContacts: ['abc'] };
    const once = liftChildSettings(stored)!;
    const twice = liftChildSettings(once)!;
    expect(twice).toEqual(once);
    expect(twice.approvedContacts).toEqual(['abc']);
  });

  it('returns undefined for a missing record', () => {
    expect(liftChildSettings(undefined)).toBeUndefined();
  });
});
