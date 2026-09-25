import { describe, it, expect } from 'vitest';
import type { DependantIdentity } from '../types';
import { buildPersonaFirstDependant } from './dependant-record';
import { resolveDependantRouteSlots } from './dependant-route-slots';
import { resolveDependantCardSlot } from './carousel-utils';
import { buildDependantKeypairOptions } from './auth-selection';
import { resolveSlotTargetFromRow } from '../components/SettingsCard';

const GUARDIAN = 'f'.repeat(64);
const NP = 'a'.repeat(64);
const PERSONA = 'b'.repeat(64);

/**
 * The whole life of a persona-first dependant, in one file (review
 * recommendation 3, spec §7.6/§13).
 *
 * The transition under test is the one every surface has to survive: the
 * guardian runs the activation ceremony, which writes `naturalPerson.displayName`
 * and `naturalPersonActive: true` and NOTHING else. Because `primaryKeypair`
 * does not move, the child must keep landing, showing and signing as their
 * handle — "Activation does not change primaryKeypair, so the child continues
 * to land and sign as their handle". What activation DOES change is reach: the
 * real identity becomes addressable and pickable, just never the default.
 */
const created = buildPersonaFirstDependant({
  guardianPubkey: GUARDIAN,
  enteredName: 'Lily',
  dateOfBirth: '2015-06-01',
  derivationPath: 'dependant-0',
  naturalPerson: { publicKey: NP, privateKey: 'a'.repeat(64) },
  persona: { publicKey: PERSONA, privateKey: 'b'.repeat(64) },
  createdAt: 1_700_000_000,
});

/** Exactly what `useDependants.activateDependantNaturalPerson` writes. */
const activated: DependantIdentity = {
  ...created,
  naturalPerson: { ...created.naturalPerson, displayName: 'Lily Rivera' },
  naturalPersonActive: true,
};

describe('a persona-first dependant, from creation to real-identity activation', () => {
  describe('at creation, every surface is the persona', () => {
    it('the record id is the persona pubkey', () => {
      expect(created.id).toBe(PERSONA);
    });

    it('the card, the cog, the route default and the picker all say persona', () => {
      expect(resolveDependantCardSlot(created).slotTarget).toBe('persona');
      expect(resolveSlotTargetFromRow({ type: 'dependant', dependant: created })).toBe('persona');
      expect(resolveDependantRouteSlots(created)!.defaultSlot.publicKey).toBe(PERSONA);
      expect(buildDependantKeypairOptions(created)[0].pubkey).toBe(PERSONA);
    });

    it('the dormant real identity is nowhere — not addressable, not in the picker', () => {
      expect(resolveDependantRouteSlots(created)!.addressableSlots.map(s => s.publicKey)).toEqual([PERSONA]);
      expect(buildDependantKeypairOptions(created).map(o => o.pubkey)).toEqual([PERSONA]);
    });
  });

  describe('after activation, nothing that decides which key acts has moved', () => {
    it('leaves primaryKeypair and the record id untouched', () => {
      expect(activated.primaryKeypair).toBe('persona');
      expect(activated.id).toBe(PERSONA);
    });

    it('still shows the persona on the card', () => {
      expect(resolveDependantCardSlot(activated).slotTarget).toBe('persona');
      expect(resolveDependantCardSlot(activated).slot.publicKey).toBe(PERSONA);
    });

    it('still opens the persona from the gear-fab', () => {
      expect(resolveSlotTargetFromRow({ type: 'dependant', dependant: activated })).toBe('persona');
    });

    it('still signs as the persona by default over NIP-46', () => {
      // A template-without-pubkey sign_event, and the get_public_key the kid's
      // pinned `record.dependantPubkey` is compared against, both use this.
      expect(resolveDependantRouteSlots(activated)!.defaultSlot.publicKey).toBe(PERSONA);
      expect(resolveDependantRouteSlots(activated)!.defaultSlotSignable).toBe(true);
    });

    it('still leads the sign-in picker with the persona', () => {
      expect(buildDependantKeypairOptions(activated)[0].pubkey).toBe(PERSONA);
    });
  });

  describe('what activation does change: reach, never the default', () => {
    it('makes the real identity addressable over NIP-46', () => {
      const before = resolveDependantRouteSlots(created)!.addressableSlots.map(s => s.publicKey);
      const after = resolveDependantRouteSlots(activated)!.addressableSlots.map(s => s.publicKey);
      expect(before).not.toContain(NP);
      expect(after).toContain(NP);
      expect(after).toContain(PERSONA);
    });

    it('adds the real identity to the picker, behind the persona', () => {
      const opts = buildDependantKeypairOptions(activated).map(o => o.pubkey);
      expect(opts).toEqual([PERSONA, NP]);
    });
  });

  describe('an existing (lifted-active, NP-primary) dependant is unmoved by any of it', () => {
    const legacy: DependantIdentity = {
      ...created,
      id: NP,
      primaryKeypair: 'natural-person',
      naturalPersonActive: true,
      naturalPerson: { ...created.naturalPerson, displayName: 'Ben Smith' },
    };

    it('keeps the real identity on the card, the cog, the default and the head of the picker', () => {
      expect(resolveDependantCardSlot(legacy).slotTarget).toBe('natural-person');
      expect(resolveSlotTargetFromRow({ type: 'dependant', dependant: legacy })).toBe('natural-person');
      expect(resolveDependantRouteSlots(legacy)!.defaultSlot.publicKey).toBe(NP);
      expect(buildDependantKeypairOptions(legacy).map(o => o.pubkey)).toEqual([NP, PERSONA]);
    });
  });
});
