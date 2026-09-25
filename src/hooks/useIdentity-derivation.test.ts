// @vitest-environment jsdom
// Pure-function coverage for the extra-persona derivation-name picker
// (`useIdentity.ts`). Deliberately its own file: the helper is exported
// straight off the hook module, so it can be exercised without rendering
// anything, but the module still pulls in React + IDB and wants a DOM.
import { describe, it, expect } from 'vitest';
import type { ExtraPersona, ExtraPersonaTombstone } from '../types';
import { nextExtraPersonaDerivationName } from './useIdentity';

function extra(derivationName: string, overrides: Partial<ExtraPersona> = {}): ExtraPersona {
  return {
    publicKey: 'f'.repeat(64),
    privateKey: '',
    displayName: 'X',
    derivationName,
    ...overrides,
  };
}

function tomb(derivationName: string, removedAt = 100): ExtraPersonaTombstone {
  return { derivationName, removedAt };
}

describe('nextExtraPersonaDerivationName', () => {
  it('starts at persona-1 with nothing to go on', () => {
    expect(nextExtraPersonaDerivationName([])).toBe('persona-1');
    expect(nextExtraPersonaDerivationName([], [])).toBe('persona-1');
  });

  it('takes max + 1 over the live extras, not length + 1', () => {
    expect(nextExtraPersonaDerivationName([extra('persona-1'), extra('persona-4')])).toBe('persona-5');
  });

  it('skips a tombstoned name even when it is the max (deleting persona-3 then adding yields persona-4)', () => {
    const extras = [extra('persona-1'), extra('persona-2')];
    const tombstones = [tomb('persona-3')];
    expect(nextExtraPersonaDerivationName(extras, tombstones)).toBe('persona-4');
  });

  it('takes the max across BOTH lists', () => {
    expect(nextExtraPersonaDerivationName([extra('persona-7')], [tomb('persona-2')])).toBe('persona-8');
    expect(nextExtraPersonaDerivationName([extra('persona-2')], [tomb('persona-7')])).toBe('persona-8');
  });

  it('ignores imported extras (no persona-N derivation name)', () => {
    const extras = [extra('', { imported: true }), extra('persona-1')];
    expect(nextExtraPersonaDerivationName(extras)).toBe('persona-2');
  });

  it('every deletion of the max keeps advancing (no name is ever recycled)', () => {
    // persona-1..3 exist, persona-3 is deleted, a new one is added, then
    // that one is deleted too — the sequence must never go backwards.
    let extras = [extra('persona-1'), extra('persona-2'), extra('persona-3')];
    let tombstones: ExtraPersonaTombstone[] = [];

    extras = extras.filter((e) => e.derivationName !== 'persona-3');
    tombstones = [...tombstones, tomb('persona-3')];
    const next1 = nextExtraPersonaDerivationName(extras, tombstones);
    expect(next1).toBe('persona-4');

    extras = [...extras, extra(next1)];
    extras = extras.filter((e) => e.derivationName !== next1);
    tombstones = [...tombstones, tomb(next1)];
    expect(nextExtraPersonaDerivationName(extras, tombstones)).toBe('persona-5');
  });
});
