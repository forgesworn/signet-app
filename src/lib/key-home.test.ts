import { describe, expect, it } from 'vitest';
import { keyHomeFor } from './key-home';
import type { SignetIdentity } from '../types';

const NP = 'a'.repeat(64);
const PERSONA = 'b'.repeat(64);
const EXTRA = 'c'.repeat(64);
const PRO = 'd'.repeat(64);
const OTHER = 'e'.repeat(64);

function identity(keys: { np?: string; persona?: string; extra?: string; pro?: string } = {}): SignetIdentity {
  return {
    naturalPerson: { publicKey: NP, privateKey: keys.np ?? '' },
    persona: { publicKey: PERSONA, privateKey: keys.persona ?? '' },
    extraPersonas: [{ publicKey: EXTRA, privateKey: keys.extra ?? '' }],
    professionalPersona: { publicKey: PRO, privateKey: keys.pro ?? '' },
  } as unknown as SignetIdentity;
}

describe('keyHomeFor', () => {
  it('is the phone when the slot holds its private key', () => {
    const id = identity({ persona: '1'.repeat(64) });
    expect(keyHomeFor(PERSONA, { identity: id, signingMode: 'local', routerPresent: false })).toBe('phone');
    // Local key wins over a bunker mode, as signing does.
    expect(keyHomeFor(PERSONA, { identity: id, signingMode: 'bunker', routerPresent: true })).toBe('phone');
  });

  it('matches case-insensitively and finds every kind of slot', () => {
    const id = identity({ np: '1', extra: '1', pro: '1' });
    for (const pk of [NP, EXTRA, PRO]) expect(keyHomeFor(pk.toUpperCase(), { identity: id, signingMode: 'local', routerPresent: false })).toBe('phone');
  });

  it('is the Heartwood for a stripped slot in bunker mode with a router, and unknown while there is none', () => {
    const id = identity();
    expect(keyHomeFor(EXTRA, { identity: id, signingMode: 'bunker', routerPresent: true })).toBe('heartwood');
    expect(keyHomeFor(EXTRA, { identity: id, signingMode: 'bunker', routerPresent: false })).toBeUndefined();
  });

  it('is the extension in nip07 mode', () => {
    expect(keyHomeFor(NP, { identity: identity(), signingMode: 'nip07', routerPresent: false })).toBe('extension');
  });

  it('is unknown for a key that is not an owner slot, no identity, paired-child, or an unrecognised mode', () => {
    const id = identity();
    expect(keyHomeFor(OTHER, { identity: id, signingMode: 'bunker', routerPresent: true })).toBeUndefined();
    expect(keyHomeFor(NP, { identity: null, signingMode: 'bunker', routerPresent: true })).toBeUndefined();
    expect(keyHomeFor(NP, { identity: id, signingMode: 'paired-child', routerPresent: true })).toBeUndefined();
    expect(keyHomeFor(NP, { identity: id, routerPresent: true })).toBeUndefined();
  });
});
