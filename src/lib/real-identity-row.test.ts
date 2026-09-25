import { describe, it, expect } from 'vitest';
import type { SignetIdentity } from '../types';
import { resolveRealIdentityRow } from './real-identity-row';

function makeIdentity(o: Partial<SignetIdentity> = {}): SignetIdentity {
  return {
    id: 'a'.repeat(64),
    mnemonic: 'x',
    naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
    persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Shade' },
    primaryKeypair: 'persona',
    isChild: false,
    createdAt: 0,
    ...o,
  } as SignetIdentity;
}

describe('resolveRealIdentityRow', () => {
  it('is active when the slot has been activated', () => {
    expect(resolveRealIdentityRow(makeIdentity({
      naturalPersonActive: true,
      naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'Real Name' },
    }))).toBe('active');
  });

  it('is dormant when the key exists but has not been activated', () => {
    expect(resolveRealIdentityRow(makeIdentity({ naturalPersonActive: false }))).toBe('dormant');
  });

  it('is unavailable when there is no natural-person key at all (nsec import)', () => {
    expect(resolveRealIdentityRow(makeIdentity({
      naturalPersonActive: false,
      naturalPerson: { publicKey: '', privateKey: '', displayName: '' },
    }))).toBe('unavailable');
  });

  it('is dormant for a bunker-mode identity whose mnemonic was stripped', () => {
    // The key still exists on the signing device — activation only names it.
    expect(resolveRealIdentityRow(makeIdentity({ naturalPersonActive: false, mnemonic: '' }))).toBe('dormant');
  });
});

import { resolveDependantRealIdentityRow } from './real-identity-row';
import type { DependantIdentity } from '../types';

const depFixture: DependantIdentity = {
  id: 'dep-p',
  guardianPubkey: 'g',
  displayName: 'Lily',
  naturalPerson: { publicKey: 'dep-np', privateKey: '', displayName: '' },
  persona: { publicKey: 'dep-p', privateKey: '', displayName: 'Lily' },
  derivationPath: 'dependant-0',
  createdAt: 0,
  autonomyStage: 'full-control',
  primaryKeypair: 'persona',
  naturalPersonActive: false,
};

describe('resolveDependantRealIdentityRow', () => {
  it('is dormant for a persona-first dependant', () => {
    expect(resolveDependantRealIdentityRow(depFixture)).toBe('dormant');
  });
  it('is active once the flag is set', () => {
    expect(resolveDependantRealIdentityRow({
      ...depFixture,
      naturalPersonActive: true,
      naturalPerson: { ...depFixture.naturalPerson, displayName: 'Lily Rivera' },
    })).toBe('active');
  });
  it('is unavailable when there is no NP key at all (view-only import)', () => {
    expect(resolveDependantRealIdentityRow({
      ...depFixture,
      naturalPerson: { publicKey: '', privateKey: '', displayName: '' },
    })).toBe('unavailable');
  });
});
