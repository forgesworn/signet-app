import { describe, it, expect } from 'vitest';
import { buildPersonaFirstDependant } from './dependant-record';
import { isDependantNaturalPersonActive } from './identity-display';

const args = {
  guardianPubkey: 'g'.repeat(64),
  enteredName: 'Lily',
  dateOfBirth: '2015-06-01',
  derivationPath: 'dependant-0',
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: 'aa' },
  persona: { publicKey: 'b'.repeat(64), privateKey: 'bb' },
  createdAt: 1_700_000_000,
};

describe('buildPersonaFirstDependant (spec §7.6)', () => {
  it('names the persona with the entered name and leaves the NP unnamed', () => {
    const dep = buildPersonaFirstDependant(args);
    expect(dep.persona.displayName).toBe('Lily');
    expect(dep.naturalPerson.displayName).toBe('');
  });

  it('never synthesises "<name> (anonymous)"', () => {
    const dep = buildPersonaFirstDependant(args);
    expect(JSON.stringify(dep)).not.toContain('(anonymous)');
  });

  it('keys the record on the PERSONA pubkey', () => {
    const dep = buildPersonaFirstDependant(args);
    expect(dep.id).toBe('b'.repeat(64));
    expect(dep.id).not.toBe(dep.naturalPerson.publicKey);
  });

  it('lands persona-primary and dormant', () => {
    const dep = buildPersonaFirstDependant(args);
    expect(dep.primaryKeypair).toBe('persona');
    expect(dep.naturalPersonActive).toBe(false);
    expect(isDependantNaturalPersonActive(dep)).toBe(false);
  });

  it('keeps the top-level family label equal to the entered name', () => {
    expect(buildPersonaFirstDependant(args).displayName).toBe('Lily');
  });

  it('keeps BOTH keys on the record — nothing is discarded', () => {
    const dep = buildPersonaFirstDependant(args);
    expect(dep.naturalPerson.publicKey).toBe('a'.repeat(64));
    expect(dep.naturalPerson.privateKey).toBe('aa');
    expect(dep.persona.privateKey).toBe('bb');
  });

  it('works for the keyless Heartwood derive path', () => {
    const dep = buildPersonaFirstDependant({
      ...args,
      naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '' },
      persona: { publicKey: 'b'.repeat(64), privateKey: '' },
    });
    expect(dep.id).toBe('b'.repeat(64));
    expect(dep.naturalPerson.privateKey).toBe('');
    expect(dep.persona.privateKey).toBe('');
    expect(dep.naturalPersonActive).toBe(false);
  });

  it('carries the unchanged derivation path and dob through', () => {
    const dep = buildPersonaFirstDependant(args);
    expect(dep.derivationPath).toBe('dependant-0');
    expect(dep.dateOfBirth).toBe('2015-06-01');
    expect(dep.autonomyStage).toBe('full-control');
  });
});
