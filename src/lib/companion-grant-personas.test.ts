import { describe, it, expect } from 'vitest';
import type { SignetIdentity } from '../types';
import { companionGrantPersonas } from './companion-grant-personas';

const slot = (publicKey: string, displayName: string, extra: Record<string, unknown> = {}) =>
  ({ publicKey, displayName, privateKey: '', ...extra });

function identity(over: Record<string, unknown>): SignetIdentity {
  return {
    naturalPerson: slot('np', 'Ada Lovelace'),
    persona: slot('pe', 'Ada'),
    extraPersonas: [],
    ...over,
  } as unknown as SignetIdentity;
}

describe('companionGrantPersonas', () => {
  it('offers an activated real identity, then the persona, then visible extras', () => {
    const list = companionGrantPersonas(identity({
      naturalPersonActive: true,
      extraPersonas: [slot('x1', 'Gamer'), slot('x2', 'Old', { hidden: true }), slot('x3', '')],
    }));
    expect(list).toEqual([
      { pubkey: 'np', label: 'Ada Lovelace' },
      { pubkey: 'pe', label: 'Ada' },
      { pubkey: 'x1', label: 'Gamer' },
      { pubkey: 'x3', label: 'Persona' },
    ]);
  });

  it('never offers a dormant real identity', () => {
    const list = companionGrantPersonas(identity({ naturalPersonActive: false, naturalPerson: slot('np', '') }));
    expect(list.map(p => p.pubkey)).toEqual(['pe']);
  });

  it('a record from before the flag existed is active when the real name is set, dormant when empty', () => {
    expect(companionGrantPersonas(identity({})).map(p => p.pubkey)).toEqual(['np', 'pe']);
    expect(companionGrantPersonas(identity({ naturalPerson: slot('np', '  ') })).map(p => p.pubkey)).toEqual(['pe']);
  });

  it('skips a persona with no key', () => {
    const list = companionGrantPersonas(identity({ naturalPersonActive: true, persona: slot('', '') }));
    expect(list.map(p => p.pubkey)).toEqual(['np']);
  });
});
