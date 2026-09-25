import { describe, it, expect } from 'vitest';
import type { SignetIdentity } from '../types';
import { resolveLandingKeypair, shouldBlurIdentity } from './identity-display';

function makeIdentity(o: Partial<SignetIdentity> = {}): SignetIdentity {
  return {
    id: 'a'.repeat(64),
    mnemonic: '', naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'Real' },
    persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Anon' },
    primaryKeypair: 'natural-person', isChild: false, createdAt: 0, ...o,
  } as SignetIdentity;
}

describe('resolveLandingKeypair — persona-first', () => {
  it('always lands on the persona, even for a natural-person-primary identity', () => {
    expect(resolveLandingKeypair(makeIdentity({ primaryKeypair: 'natural-person' }))).toBe('persona');
    expect(resolveLandingKeypair(makeIdentity({ primaryKeypair: 'persona' }))).toBe('persona');
  });
});

describe('shouldBlurIdentity', () => {
  it('defaults OFF when the field is absent (existing prefs without the field are NOT blurred)', () => {
    expect(shouldBlurIdentity({ id: 'current', theme: 'system' } as never)).toBe(false);
  });
  it('honours an explicit false (not blurred)', () => {
    expect(shouldBlurIdentity({ id: 'current', theme: 'system', blurIdentityNames: false } as never)).toBe(false);
  });
  it('honours an explicit true (blurred — user opted in)', () => {
    expect(shouldBlurIdentity({ id: 'current', theme: 'system', blurIdentityNames: true } as never)).toBe(true);
  });
});

// Appended below the existing `makeIdentity` helper. A second import from
// './identity-display' is legal ESM; keep the new fixture names distinct from
// anything already declared in the file.
import { isDependantNaturalPersonActive } from './identity-display';
import type { DependantIdentity } from '../types';

const depBase: DependantIdentity = {
  id: 'dep-p',
  guardianPubkey: 'g',
  displayName: 'Lily',
  naturalPerson: { publicKey: 'dep-np', privateKey: '', displayName: '' },
  persona: { publicKey: 'dep-p', privateKey: '', displayName: 'Lily' },
  derivationPath: 'dependant-0',
  createdAt: 0,
  autonomyStage: 'full-control',
  primaryKeypair: 'persona',
};

describe('isDependantNaturalPersonActive', () => {
  it('reads an explicit false even when a name is present', () => {
    expect(isDependantNaturalPersonActive({
      ...depBase,
      naturalPersonActive: false,
      naturalPerson: { ...depBase.naturalPerson, displayName: 'Lily Rivera' },
    })).toBe(false);
  });

  it('reads an explicit true', () => {
    expect(isDependantNaturalPersonActive({ ...depBase, naturalPersonActive: true })).toBe(true);
  });

  it('falls back to a non-empty NP display name when the field is absent', () => {
    expect(isDependantNaturalPersonActive({
      ...depBase,
      naturalPerson: { ...depBase.naturalPerson, displayName: 'Lily Rivera' },
    })).toBe(true);
  });

  it('falls back to false for a whitespace-only NP display name', () => {
    expect(isDependantNaturalPersonActive({
      ...depBase,
      naturalPerson: { ...depBase.naturalPerson, displayName: '   ' },
    })).toBe(false);
  });
});
