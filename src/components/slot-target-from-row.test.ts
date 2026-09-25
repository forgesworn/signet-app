import { describe, it, expect } from 'vitest';
import { resolveSlotTargetFromRow } from './SettingsCard';
import type { DependantIdentity, CarouselRow } from '../types';

const NP = 'a'.repeat(64);
const PERSONA = 'b'.repeat(64);
const EXTRA = 'c'.repeat(64);

const dormant: DependantIdentity = {
  id: PERSONA,
  guardianPubkey: 'g'.repeat(64),
  displayName: 'Lily',
  naturalPerson: { publicKey: NP, privateKey: 'aa', displayName: '' },
  persona: { publicKey: PERSONA, privateKey: 'bb', displayName: 'Lily' },
  derivationPath: 'dependant-0',
  createdAt: 0,
  autonomyStage: 'full-control',
  primaryKeypair: 'persona',
  naturalPersonActive: false,
};

const row = (dependant: DependantIdentity): CarouselRow => ({ type: 'dependant', dependant });

/**
 * C1. The gear-fab used to hard-return 'natural-person' for every dependant
 * row, so tapping the cog on a persona-first dependant's card opened
 * PersonaAdvanced on the DORMANT real-name slot — rendering its npub, its hex
 * pubkey and a kind-0 publish button for a key the guardian had never
 * activated. Card and cog must agree, via the one shared resolver.
 */
describe('resolveSlotTargetFromRow — dependant rows (spec §7.6)', () => {
  it('opens the persona for a dormant persona-first dependant', () => {
    expect(resolveSlotTargetFromRow(row(dormant))).toBe('persona');
  });

  it('still opens the persona once the real identity is activated', () => {
    // Activation writes only the name and the flag — primaryKeypair is untouched.
    expect(resolveSlotTargetFromRow(row({
      ...dormant,
      naturalPersonActive: true,
      naturalPerson: { ...dormant.naturalPerson, displayName: 'Lily Rivera' },
    }))).toBe('persona');
  });

  it('opens the natural person for a lifted-active, NP-primary dependant', () => {
    expect(resolveSlotTargetFromRow(row({
      ...dormant,
      id: NP,
      primaryKeypair: 'natural-person',
      naturalPersonActive: true,
      naturalPerson: { ...dormant.naturalPerson, displayName: 'Lily Rivera' },
    }))).toBe('natural-person');
  });

  it('opens an extra persona when that is the primary', () => {
    expect(resolveSlotTargetFromRow(row({
      ...dormant,
      primaryKeypair: EXTRA,
      extraPersonas: [
        { publicKey: EXTRA, privateKey: 'cc', displayName: 'LilyPlays', derivationName: 'dependant-0-persona-1' },
      ],
    }))).toBe(EXTRA);
  });

  it('falls back to the natural person when there is no persona key (view-only import)', () => {
    expect(resolveSlotTargetFromRow(row({
      ...dormant,
      persona: { publicKey: '', privateKey: '', displayName: '' },
    }))).toBe('natural-person');
  });

  it('leaves the owner rows alone', () => {
    const identity = {
      id: NP,
      mnemonic: '',
      naturalPerson: { publicKey: NP, privateKey: '', displayName: 'Me' },
      persona: { publicKey: PERSONA, privateKey: '', displayName: 'Handle' },
      primaryKeypair: 'persona' as const,
      isChild: false,
      createdAt: 0,
      extraPersonas: [
        { publicKey: EXTRA, privateKey: '', displayName: 'Alt', derivationName: 'persona-1' },
      ],
    };
    expect(resolveSlotTargetFromRow({ type: 'natural-person', identity })).toBe('natural-person');
    expect(resolveSlotTargetFromRow({ type: 'persona', identity })).toBe('persona');
    expect(resolveSlotTargetFromRow({ type: 'extra-persona', identity, personaIndex: 0 })).toBe(EXTRA);
  });
});
