import { describe, it, expect } from 'vitest';
import { planShare, planVouch } from './contacts-v2-family-ops';
import type { EffectiveContact } from '../types';

const GUARDIAN = '2'.repeat(64);
const DAVE = 'a'.repeat(64);
const DAVE_ALT = 'b'.repeat(64);

const source: EffectiveContact = {
  directoryId: 'owner', contactId: 'c-owner', type: 'person', displayName: 'Dave',
  tier: 'kin', roles: ['best friend'],
  identities: [
    { itemId: 'i1', pubkey: DAVE, provenance: 'direct', verification: 'mutual', addedAt: 1, direct: { ownerPubkey: GUARDIAN, sharedSecret: 'secret', verifiedAt: 1 } },
    { itemId: 'i2', pubkey: DAVE_ALT, provenance: 'direct', verification: 'unverified', addedAt: 2 },
  ],
  contactMethods: [{ itemId: 'm1', kind: 'phone', value: '07700 900123', verification: 'unverified', sharingPolicy: 'private', addedAt: 1 }],
  accessGrants: [], lifecycle: 'active', createdAt: 1, updatedAt: 2,
  createdByActorRole: 'owner', createdByOperationId: 'op-1',
  vouches: [], ceilings: [], blocks: [], notes: 'knows my bank details',
  effectiveTier: 'kin', tierSource: 'direct', blocked: false, blockedBy: [],
};

describe('planShare', () => {
  it('creates a Ken record per target carrying only name and public keys', () => {
    const plan = planShare({
      source,
      targets: [
        { directoryId: 'dependant:0', label: 'Sam', contactId: null },
        { directoryId: 'dependant:1', label: 'Lily', contactId: null },
      ],
    });
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].add).toEqual({ type: 'person', displayName: 'Dave', tier: 'ken', lifecycle: 'active' });
    expect(plan.steps[0].identities).toEqual([
      { pubkey: DAVE, provenance: 'guardian-share', verification: 'unverified' },
      { pubkey: DAVE_ALT, provenance: 'guardian-share', verification: 'unverified' },
    ]);
  });

  it('defaults to phone for dependants but never copies secrets, roles or notes', () => {
    const plan = planShare({ source, targets: [{ directoryId: 'dependant:0', label: 'Sam', contactId: null }] });
    const json = JSON.stringify(plan);
    expect(json).not.toContain('secret');
    expect(json).not.toContain('knows my bank details');
    expect(json).toContain('07700');
    expect(json).not.toContain('best friend');
  });

  it('skips the add when the target already has a record', () => {
    const plan = planShare({ source, targets: [{ directoryId: 'dependant:0', label: 'Sam', contactId: 'c-sam' }] });
    expect(plan.steps[0].add).toBeUndefined();
    expect(plan.steps[0].contactId).toBe('c-sam');
  });

  it('names every affected directory in the confirm text', () => {
    const plan = planShare({
      source,
      targets: [
        { directoryId: 'dependant:0', label: 'Sam', contactId: null },
        { directoryId: 'dependant:1', label: 'Lily', contactId: null },
      ],
    });
    expect(plan.confirmText).toContain('Sam and Lily');
  });
});

describe('planVouch', () => {
  it('creates the contact then vouches, per dependant, with the per-child role', () => {
    const plan = planVouch({
      source, guardianPubkey: GUARDIAN, ownerDirectoryId: 'owner', tier: 'kin',
      targets: [
        { directoryId: 'dependant:0', label: 'Sam', contactId: null, role: ' Uncle Dave ' },
        { directoryId: 'dependant:1', label: 'Lily', contactId: 'c-lily', role: 'Uncle Dave' },
      ],
    });
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]).toMatchObject({
      kind: 'vouch', directoryId: 'dependant:0', contactId: null,
      vouch: { guardianPubkey: GUARDIAN, tier: 'kin', role: 'Uncle Dave' },
    });
    expect(plan.steps[0].add).toEqual({ type: 'person', displayName: 'Dave', tier: 'ken', lifecycle: 'active' });
    expect(plan.steps[1].add).toBeUndefined();
  });

  it('sets the tier directly in the guardian own directory rather than vouching', () => {
    const plan = planVouch({
      source, guardianPubkey: GUARDIAN, ownerDirectoryId: 'owner', tier: 'kin',
      targets: [{ directoryId: 'owner', label: 'You', contactId: 'c-owner', role: 'best friend' }],
    });
    expect(plan.steps[0]).toMatchObject({
      kind: 'own-directory', directoryId: 'owner', contactId: 'c-owner',
      ownTier: 'kin', roles: ['best friend'],
    });
    expect(plan.steps[0].vouch).toBeUndefined();
  });

  it('never copies direct evidence into a vouched record', () => {
    const plan = planVouch({
      source, guardianPubkey: GUARDIAN, ownerDirectoryId: 'owner', tier: 'kith',
      targets: [{ directoryId: 'dependant:0', label: 'Sam', contactId: null }],
    });
    expect(JSON.stringify(plan)).not.toContain('secret');
    expect(plan.steps[0].identities.every(i => i.provenance === 'guardian-share')).toBe(true);
    expect(plan.steps[0].identities.every(i => i.verification === 'unverified')).toBe(true);
  });

  it('names every affected directory in the confirm text', () => {
    const plan = planVouch({
      source, guardianPubkey: GUARDIAN, ownerDirectoryId: 'owner', tier: 'kin',
      targets: [
        { directoryId: 'owner', label: 'You', contactId: 'c-owner' },
        { directoryId: 'dependant:0', label: 'Sam', contactId: null },
      ],
    });
    expect(plan.confirmText).toContain('You and Sam');
    expect(plan.confirmText).toContain('Kin');
  });
});
