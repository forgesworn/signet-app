import { describe, it, expect } from 'vitest';
import type { SignetIdentity } from '../types';
import { liftNaturalPersonActive } from './lift-natural-person-active';
import { isNaturalPersonActive } from './identity-display';

function makeIdentity(o: Partial<SignetIdentity> = {}): SignetIdentity {
  return {
    id: 'a'.repeat(64),
    mnemonic: '',
    naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
    persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Anon' },
    primaryKeypair: 'persona',
    isChild: false,
    createdAt: 0,
    ...o,
  } as SignetIdentity;
}

describe('liftNaturalPersonActive', () => {
  it('derives true from a non-empty natural-person display name', () => {
    const lifted = liftNaturalPersonActive(makeIdentity({
      naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'Real Name' },
    }));
    expect(lifted.naturalPersonActive).toBe(true);
  });

  it('derives false from an empty natural-person display name', () => {
    expect(liftNaturalPersonActive(makeIdentity()).naturalPersonActive).toBe(false);
  });

  it('derives false from a whitespace-only natural-person display name', () => {
    const lifted = liftNaturalPersonActive(makeIdentity({
      naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '   ' },
    }));
    expect(lifted.naturalPersonActive).toBe(false);
  });

  it('is idempotent — an explicit false survives a non-empty display name', () => {
    const already = makeIdentity({
      naturalPersonActive: false,
      naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'Real Name' },
    });
    const lifted = liftNaturalPersonActive(already);
    expect(lifted.naturalPersonActive).toBe(false);
    expect(lifted).toBe(already); // untouched record is returned by reference
  });

  it('does not mutate the input record', () => {
    const input = makeIdentity();
    liftNaturalPersonActive(input);
    expect(input.naturalPersonActive).toBeUndefined();
  });
});

describe('isNaturalPersonActive', () => {
  it('reads an explicit true', () => {
    expect(isNaturalPersonActive(makeIdentity({ naturalPersonActive: true }))).toBe(true);
  });

  it('reads an explicit false even when a display name is present', () => {
    expect(isNaturalPersonActive(makeIdentity({
      naturalPersonActive: false,
      naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'Real Name' },
    }))).toBe(false);
  });

  it('falls back to the display name when the field is absent (unlifted record)', () => {
    expect(isNaturalPersonActive(makeIdentity({
      naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'Real Name' },
    }))).toBe(true);
    expect(isNaturalPersonActive(makeIdentity())).toBe(false);
  });
});

import { liftDependantNaturalPersonActive } from './lift-natural-person-active';
import type { DependantIdentity } from '../types';

const legacyDep: DependantIdentity = {
  id: 'dep-np',
  guardianPubkey: 'g',
  displayName: 'Ben Smith',
  naturalPerson: { publicKey: 'dep-np', privateKey: '', displayName: 'Ben Smith' },
  persona: { publicKey: 'dep-p', privateKey: '', displayName: 'BenGamer' },
  derivationPath: 'dependant-0',
  createdAt: 0,
  autonomyStage: 'full-control',
  primaryKeypair: 'natural-person',
};

describe('liftDependantNaturalPersonActive', () => {
  it('lifts an existing named dependant to active', () => {
    expect(liftDependantNaturalPersonActive(legacyDep).naturalPersonActive).toBe(true);
  });

  it('lifts an unnamed NP to dormant', () => {
    const dep = { ...legacyDep, naturalPerson: { ...legacyDep.naturalPerson, displayName: '' } };
    expect(liftDependantNaturalPersonActive(dep).naturalPersonActive).toBe(false);
  });

  it('returns the input by reference when the field is already set', () => {
    const dep = { ...legacyDep, naturalPersonActive: false };
    expect(liftDependantNaturalPersonActive(dep)).toBe(dep);
  });

  it('is idempotent', () => {
    const once = liftDependantNaturalPersonActive(legacyDep);
    expect(liftDependantNaturalPersonActive(once)).toBe(once);
  });

  it('changes nothing else about an existing dependant', () => {
    const lifted = liftDependantNaturalPersonActive(legacyDep);
    expect(lifted.id).toBe('dep-np');
    expect(lifted.primaryKeypair).toBe('natural-person');
    expect(lifted.naturalPerson.displayName).toBe('Ben Smith');
  });
});
