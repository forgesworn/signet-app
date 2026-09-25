import { describe, it, expect } from 'vitest';
import { resolveDependantRouteSlots } from './dependant-route-slots';
import type { DependantIdentity } from '../types';

const NP = 'a'.repeat(64);
const PERSONA = 'b'.repeat(64);

const base: DependantIdentity = {
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

describe('resolveDependantRouteSlots (spec §7.6/§8)', () => {
  it('signs as the persona while the real identity is dormant', () => {
    const r = resolveDependantRouteSlots(base)!;
    expect(r.defaultSlot.publicKey).toBe(PERSONA);
  });

  it('never makes a dormant real identity addressable', () => {
    const r = resolveDependantRouteSlots(base)!;
    expect(r.addressableSlots.map(s => s.publicKey)).toEqual([PERSONA]);
    expect(r.addressableSlots.some(s => s.publicKey === NP)).toBe(false);
  });

  it('signs as the natural person for an existing dependant', () => {
    const active: DependantIdentity = {
      ...base,
      id: NP,
      naturalPersonActive: true,
      primaryKeypair: 'natural-person',
      naturalPerson: { ...base.naturalPerson, displayName: 'Lily Rivera' },
    };
    const r = resolveDependantRouteSlots(active)!;
    expect(r.defaultSlot.publicKey).toBe(NP);
    expect(r.addressableSlots.map(s => s.publicKey)).toEqual([NP, PERSONA]);
  });

  it('includes extras with keys and skips keyless ones', () => {
    const r = resolveDependantRouteSlots({
      ...base,
      extraPersonas: [
        { publicKey: 'c'.repeat(64), privateKey: 'cc', displayName: 'X', derivationName: 'dependant-0-persona-1' },
        { publicKey: 'd'.repeat(64), privateKey: '', displayName: 'Y', derivationName: 'dependant-0-persona-2' },
      ],
    })!;
    expect(r.addressableSlots.map(s => s.publicKey)).toEqual([PERSONA, 'c'.repeat(64)]);
  });

  // Controller ruling (overrides the brief): a dormant real identity is
  // NEVER the default and NEVER addressable, even when the persona slot is
  // itself keyless. Key absence is the routed/bunker backend's problem, not
  // a reason to fall back to the NP.
  it('never falls back to the natural person when dormant, even with a keyless persona', () => {
    const r = resolveDependantRouteSlots({
      ...base,
      persona: { ...base.persona, privateKey: '' },
    })!;
    expect(r.defaultSlot.publicKey).toBe(PERSONA);
    expect(r.addressableSlots.some(s => s.publicKey === NP)).toBe(false);
  });

  // C2: after the §7.6 activation ceremony the DEFAULT must not move. If it
  // did, the kid's pinned `record.dependantPubkey` would stop matching
  // `get_public_key` ("Bunker pubkey mismatch") and every template-without-
  // pubkey sign_event would go out under the real-name key.
  it('keeps the persona as the default after the real identity is activated', () => {
    const activated: DependantIdentity = {
      ...base,
      naturalPersonActive: true,
      naturalPerson: { ...base.naturalPerson, displayName: 'Lily Rivera' },
    };
    const r = resolveDependantRouteSlots(activated)!;
    expect(r.defaultSlot.publicKey).toBe(PERSONA);
    expect(r.addressableSlots.map(s => s.publicKey).sort()).toEqual([NP, PERSONA].sort());
  });

  it('defaults to an extra persona when that is the primary', () => {
    const EXTRA = 'c'.repeat(64);
    const r = resolveDependantRouteSlots({
      ...base,
      primaryKeypair: EXTRA,
      extraPersonas: [
        { publicKey: EXTRA, privateKey: 'c'.repeat(64), displayName: 'X', derivationName: 'dependant-0-persona-1' },
      ],
    })!;
    expect(r.defaultSlot.publicKey).toBe(EXTRA);
    expect(r.defaultSlotSignable).toBe(true);
  });

  describe('defaultSlotSignable (I4)', () => {
    it('is false for an active dependant whose NP key was stripped', () => {
      const r = resolveDependantRouteSlots({
        ...base,
        id: NP,
        primaryKeypair: 'natural-person',
        naturalPersonActive: true,
        naturalPerson: { publicKey: NP, privateKey: '', displayName: 'Lily Rivera' },
        persona: { ...base.persona, privateKey: 'b'.repeat(64) },
      })!;
      expect(r.defaultSlot.publicKey).toBe(NP);
      expect(r.defaultSlotSignable).toBe(false);
    });

    it('is false for a dormant dependant whose persona key was stripped, and the NP stays absent', () => {
      const r = resolveDependantRouteSlots({
        ...base,
        persona: { ...base.persona, privateKey: '' },
        naturalPerson: { ...base.naturalPerson, privateKey: 'a'.repeat(64) },
      })!;
      expect(r.defaultSlot.publicKey).toBe(PERSONA);
      expect(r.defaultSlotSignable).toBe(false);
      expect(r.addressableSlots.some(s => s.publicKey === NP)).toBe(false);
    });

    it('is true only for a real 64-hex key', () => {
      const short = resolveDependantRouteSlots(base)!;
      expect(short.defaultSlotSignable).toBe(false); // 'bb' is not a key
      const real = resolveDependantRouteSlots({
        ...base,
        persona: { ...base.persona, privateKey: 'b'.repeat(64) },
      })!;
      expect(real.defaultSlotSignable).toBe(true);
    });
  });

  it('returns null when no slot holds a key (post-migration strip)', () => {
    expect(resolveDependantRouteSlots({
      ...base,
      naturalPerson: { ...base.naturalPerson, privateKey: '' },
      persona: { ...base.persona, privateKey: '' },
    })).toBeNull();
  });
});
