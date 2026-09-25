import { describe, it, expect } from 'vitest';
import {
  ownerSlotPubkeys,
  dependantImportRefs,
  pairedChildImportRefs,
  stableActorPubkey,
  guardianPubkeysFor,
} from './contacts-v2-directories';
import { buildOperation } from './contacts-v2-mutations';
import { applyOperations, recordKey } from './contacts-v2-reducer';
import { resolveEffective } from './contacts-v2-effective';
import { directoryIdForDependant } from './contacts-v2-ids';
import type { DependantIdentity, SignetIdentity } from '../types';

const NP = 'a'.repeat(64);
const PERSONA = 'b'.repeat(64);
const EXTRA = 'c'.repeat(64);
const PRO = 'd'.repeat(64);
const DEP_NP = 'e'.repeat(64);
const DEP_PERSONA = 'f'.repeat(64);
const DEP_EXTRA = '1'.repeat(64);

function identity(over: Partial<SignetIdentity> = {}): SignetIdentity {
  return {
    id: NP,
    mnemonic: '',
    naturalPerson: { publicKey: NP, privateKey: '', displayName: 'Real' },
    persona: { publicKey: PERSONA, privateKey: '', displayName: 'Anon' },
    primaryKeypair: 'persona',
    isChild: false,
    createdAt: 1,
    ...over,
  } as SignetIdentity;
}

function dependant(over: Partial<DependantIdentity> = {}): DependantIdentity {
  return {
    id: DEP_NP,
    guardianPubkey: NP,
    displayName: 'Sam',
    naturalPerson: { publicKey: DEP_NP, privateKey: '', displayName: 'Sam' },
    persona: { publicKey: DEP_PERSONA, privateKey: '', displayName: 'Sam' },
    derivationPath: 'dependant-0',
    createdAt: 1,
    autonomyStage: 'full-control',
    primaryKeypair: 'persona',
    ...over,
  } as DependantIdentity;
}

describe('ownerSlotPubkeys', () => {
  it('collects NP, persona, extras and the professional slot', () => {
    const keys = ownerSlotPubkeys(identity({
      extraPersonas: [{ publicKey: EXTRA, privateKey: '', displayName: 'Side', derivationName: 'persona-1' }],
      professionalPersona: { publicKey: PRO, privateKey: '', displayName: 'Dr Real' },
    } as Partial<SignetIdentity>));
    expect(keys.sort()).toEqual([NP, PERSONA, EXTRA, PRO].sort());
  });

  it('deduplicates and drops empty slots', () => {
    expect(ownerSlotPubkeys(identity({ persona: { publicKey: NP, privateKey: '', displayName: 'Same' } } as Partial<SignetIdentity>))).toEqual([NP]);
    expect(ownerSlotPubkeys(null)).toEqual([]);
  });
});

describe('dependantImportRefs', () => {
  it('maps a tree-derived dependant to dependant:<id> with all of its slot pubkeys', () => {
    const refs = dependantImportRefs([dependant({
      extraPersonas: [{ publicKey: DEP_EXTRA, privateKey: '', displayName: 'Game', derivationName: 'dependant-0-persona-1' }],
    } as Partial<DependantIdentity>)]);
    expect(refs).toHaveLength(1);
    expect(refs[0].directoryId).toBe(`dependant:${DEP_NP.toLowerCase()}`);
    expect(refs[0].slotPubkeys.sort()).toEqual([DEP_NP, DEP_PERSONA, DEP_EXTRA].sort());
  });

  it('maps an imported dependant (no derivation path) by the SAME rule — no separate pk: form', () => {
    const refs = dependantImportRefs([dependant({ derivationPath: '' } as Partial<DependantIdentity>)]);
    expect(refs[0].directoryId).toBe(`dependant:${DEP_NP.toLowerCase()}`);
  });

  it('returns an empty list for no dependants', () => {
    expect(dependantImportRefs([])).toEqual([]);
  });
});

describe('pairedChildImportRefs', () => {
  it('scopes the kid device to its own dependant:<id> directory with its own slot pubkeys', () => {
    const kidOwnIdentity = identity({
      id: DEP_NP,
      naturalPerson: { publicKey: DEP_NP, privateKey: '', displayName: 'Sam' },
      persona: { publicKey: DEP_PERSONA, privateKey: '', displayName: 'Sam' },
      extraPersonas: [{ publicKey: DEP_EXTRA, privateKey: '', displayName: 'Game', derivationName: 'persona-1' }],
    } as Partial<SignetIdentity>);
    const refs = pairedChildImportRefs(kidOwnIdentity);
    expect(refs).toHaveLength(1);
    // Byte-identical to what the guardian's device computes for this same
    // dependant via directoryIdForDependant({ id: DEP_NP }) — that's the point.
    expect(refs[0].directoryId).toBe(`dependant:${DEP_NP.toLowerCase()}`);
    expect(refs[0].slotPubkeys.sort()).toEqual([DEP_NP, DEP_PERSONA, DEP_EXTRA].sort());
  });

  it('returns an empty list with no identity', () => {
    expect(pairedChildImportRefs(null)).toEqual([]);
  });
});

describe('stableActorPubkey / guardianPubkeysFor (R-ACTOR)', () => {
  it('is the natural-person pubkey, even while the real identity is dormant', () => {
    expect(stableActorPubkey(identity({ naturalPersonActive: false } as Partial<SignetIdentity>))).toBe(NP);
    expect(stableActorPubkey(null)).toBeNull();
  });

  it('falls back to the persona only when there is no NP slot at all', () => {
    const noNp = identity({ naturalPerson: { publicKey: '', privateKey: '', displayName: '' } } as Partial<SignetIdentity>);
    expect(stableActorPubkey(noNp)).toBe(PERSONA);
  });

  it('does not change when the primary keypair is switched', () => {
    // `identity.id` IS the primary pubkey, so it moves; the actor id must not.
    const personaPrimary = identity({ id: PERSONA, primaryKeypair: 'persona' } as Partial<SignetIdentity>);
    const npPrimary = identity({ id: NP, primaryKeypair: 'natural-person' } as Partial<SignetIdentity>);
    expect(personaPrimary.id).not.toBe(npPrimary.id);
    expect(stableActorPubkey(personaPrimary)).toBe(stableActorPubkey(npPrimary));
  });

  it('lowercases, and yields an empty list for a pairing with no guardian pubkey', () => {
    expect(guardianPubkeysFor({ guardianPubkey: NP.toUpperCase() })).toEqual([NP]);
    expect(guardianPubkeysFor({})).toEqual([]);
    expect(guardianPubkeysFor(null)).toEqual([]);
  });

  it('authors a guardian operation under a pubkey the dependant directory counts as a guardian', () => {
    const dep = dependant();
    const actorPubkey = stableActorPubkey(identity())!;
    const activeGuardianPubkeys = guardianPubkeysFor(dep);
    expect(activeGuardianPubkeys).toContain(actorPubkey);

    const directoryId = directoryIdForDependant(dep);
    const contactId = '0'.repeat(32);
    const actor = { actorPubkey, actorRole: 'guardian' as const, actorDeviceId: 'd'.repeat(32) };
    const ops = [
      buildOperation({
        directoryId, contactId, action: 'add', value: { type: 'person', displayName: 'Dave', tier: 'ken' },
        clock: 1, actor, now: 1, operationId: 'a'.repeat(32),
      }),
      buildOperation({
        directoryId, contactId, action: 'vouch', value: { guardianPubkey: actorPubkey, tier: 'kith' },
        clock: 2, actor, now: 2, operationId: 'b'.repeat(32),
      }),
    ];
    const record = applyOperations(ops).get(recordKey(directoryId, contactId))!;
    // The vouch only survives (`guardianPubkey === actorPubkey`) and only
    // counts (`activeGuardianPubkeys`) because both sides agree on the pubkey.
    expect(record.vouches).toHaveLength(1);
    const effective = resolveEffective(record, {
      activeGuardianPubkeys, defaultChildCeiling: 'ken', directoryIsDependant: true,
    });
    expect(effective.effectiveTier).toBe('kith');
    expect(effective.tierSource).toBe('guardian-vouched');
  });
});
