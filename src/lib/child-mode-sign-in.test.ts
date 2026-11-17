import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { childModeSignInRefusal, childModeSelectionRefused, childModeApprovalOffer, childModeState, childModeAlignStep, childRingRowFor, childModeSessionStale } from './child-mode-sign-in';
import { buildChildRows } from './carousel-utils';
import type { DependantIdentity } from '../types';
import { CHILD_MODE_SIGN_IN_COPY } from './child-device-copy';
import { buildPersonaFirstDependant } from './dependant-record';

/**
 * Device run 2026-11-17, F12: in child mode for a child whose own phone pairs
 * straight to the Heartwood, a sign-in offered only the guardian's identities.
 */

const KID = 'ab'.repeat(32);
const SIB = 'cd'.repeat(32);
const direct = { id: KID, displayName: 'RunKid', childDevice: { mode: 'heartwood-direct' } };
const phoneServed = { id: KID, displayName: 'RunKid' };

describe('childModeSignInRefusal', () => {
  it('refuses in child mode for a child paired straight to the Heartwood, naming them', () => {
    expect(childModeSignInRefusal({ childMode: true, dependant: direct })).toEqual({ child: 'RunKid' });
  });

  it('never refuses outside child mode', () => {
    expect(childModeSignInRefusal({ childMode: false, dependant: direct })).toBeNull();
  });

  it('does not refuse a phone-served (legacy) child, nor an unknown one', () => {
    expect(childModeSignInRefusal({ childMode: true, dependant: phoneServed })).toBeNull();
    expect(childModeSignInRefusal({ childMode: true, dependant: { ...phoneServed, childDevice: null } })).toBeNull();
    expect(childModeSignInRefusal({ childMode: true, dependant: null })).toBeNull();
    expect(childModeSignInRefusal({ childMode: true, dependant: undefined })).toBeNull();
  });

  it('cleans the name and never leaves it empty', () => {
    expect(childModeSignInRefusal({ childMode: true, dependant: { ...direct, displayName: '  Ru‮nKid\u0007 ' } })).toEqual({ child: 'RunKid' });
    expect(childModeSignInRefusal({ childMode: true, dependant: { ...direct, displayName: '' } })).toEqual({ child: 'your child' });
    expect(childModeSignInRefusal({ childMode: true, dependant: { ...direct, displayName: 'x'.repeat(200) } })?.child).toHaveLength(64);
  });
});

describe('the refusal copy', () => {
  it('reads as the owner asked', () => {
    expect(CHILD_MODE_SIGN_IN_COPY.refusalHeading('RunKid')).toBe('RunKid signs in on their own phone');
    expect(CHILD_MODE_SIGN_IN_COPY.refusalBody('RunKid')).toBe("This phone can't sign in for RunKid. Use RunKid's own phone.");
    expect(CHILD_MODE_SIGN_IN_COPY.decline).toBe('Decline');
  });

  it('starts the heading with a capital when the name is the fallback', () => {
    expect(CHILD_MODE_SIGN_IN_COPY.refusalHeading('your child')).toBe('Your child signs in on their own phone');
  });
});

describe('childModeSelectionRefused (the approval-time check)', () => {
  const guardian = { source: 'guardian' as const, keypairType: 'persona' };
  const asKid = { source: 'dependant' as const, dependantId: KID, keypairType: 'persona' };
  const asSibling = { source: 'dependant' as const, dependantId: SIB, keypairType: 'persona' };

  it('refuses nothing outside child mode', () => {
    for (const selection of [guardian, asKid, asSibling]) {
      expect(childModeSelectionRefused({ childMode: false, dependant: null, selection })).toBe(false);
    }
  });

  it('in child mode for a phone-served child: only that child signs, never the guardian or a sibling', () => {
    expect(childModeSelectionRefused({ childMode: true, dependant: phoneServed, selection: asKid })).toBe(false);
    expect(childModeSelectionRefused({ childMode: true, dependant: phoneServed, selection: guardian })).toBe(true);
    expect(childModeSelectionRefused({ childMode: true, dependant: phoneServed, selection: asSibling })).toBe(true);
  });

  it('in child mode for a child paired straight to the Heartwood: nothing signs', () => {
    for (const selection of [guardian, asKid, asSibling]) {
      expect(childModeSelectionRefused({ childMode: true, dependant: direct, selection })).toBe(true);
    }
  });

  it('in child mode with no known child: nothing signs', () => {
    expect(childModeSelectionRefused({ childMode: true, dependant: null, selection: guardian })).toBe(true);
    expect(childModeSelectionRefused({ childMode: true, dependant: null, selection: asKid })).toBe(true);
  });
});

describe('childModeApprovalOffer (every sign-in and connect entry)', () => {
  const ids = [KID, SIB];

  it('outside child mode offers the guardian and every dependant, and refuses nothing', () => {
    const offer = childModeApprovalOffer({ childMode: false, dependant: direct });
    expect(offer.refuse).toBeNull();
    expect(offer.guardian).toBe(true);
    expect(ids.filter(offer.offersDependant)).toEqual(ids);
  });

  it('a phone-served child in child mode: only that child, never the guardian or a sibling', () => {
    const offer = childModeApprovalOffer({ childMode: true, dependant: phoneServed });
    expect(offer.refuse).toBeNull();
    expect(offer.guardian).toBe(false);
    expect(ids.filter(offer.offersDependant)).toEqual([KID]);
  });

  it('a child paired straight to the Heartwood: refused, naming them, with nobody offered', () => {
    const offer = childModeApprovalOffer({ childMode: true, dependant: direct });
    expect(offer.refuse).toEqual({ child: 'RunKid' });
    expect(offer.guardian).toBe(false);
    expect(ids.filter(offer.offersDependant)).toEqual([]);
  });

  it('child mode with no known child offers nobody at all', () => {
    const offer = childModeApprovalOffer({ childMode: true, dependant: null });
    expect(offer.guardian).toBe(false);
    expect(ids.filter(offer.offersDependant)).toEqual([]);
  });
});

describe('childModeState (how phone apps are answered)', () => {
  it('is unknown until child mode as saved has been read, then off with no session', () => {
    expect(childModeState({ live: false, saved: undefined })).toBe('unknown');
    expect(childModeState({ live: false, saved: null })).toBe('off');
  });

  it('is on while child mode is live, or saved and not yet restored', () => {
    expect(childModeState({ live: true, saved: null })).toBe('on');
    expect(childModeState({ live: true, saved: undefined })).toBe('on');
    expect(childModeState({ live: false, saved: phoneServed })).toBe('on');
  });
});

describe('childModeAlignStep (the carousel step after an approval)', () => {
  const guardian = { source: 'guardian' as const, keypairType: 'persona' };
  const asKid = { source: 'dependant' as const, dependantId: KID, keypairType: 'persona' };
  const asSibling = { source: 'dependant' as const, dependantId: SIB, keypairType: 'persona' };

  it('outside child mode lands as before', () => {
    for (const selection of [guardian, asKid, asSibling]) {
      expect(childModeAlignStep({ childMode: false, childModeDependantId: null, selection })).toBe('outside-child-mode');
    }
  });

  it('in child mode the child\'s own approval stays in child mode on their card', () => {
    expect(childModeAlignStep({ childMode: true, childModeDependantId: KID, selection: asKid })).toBe('land-on-child');
    expect(childModeAlignStep({ childMode: true, childModeDependantId: KID, selection: { ...asKid, keypairType: 'natural-person' } })).toBe('land-on-child');
  });

  it('in child mode nothing else leaves it: the guardian, a sibling, or an unknown child stay put', () => {
    expect(childModeAlignStep({ childMode: true, childModeDependantId: KID, selection: guardian })).toBe('stay-put');
    expect(childModeAlignStep({ childMode: true, childModeDependantId: KID, selection: asSibling })).toBe('stay-put');
    expect(childModeAlignStep({ childMode: true, childModeDependantId: null, selection: asKid })).toBe('stay-put');
    expect(childModeAlignStep({ childMode: true, childModeDependantId: undefined, selection: asKid })).toBe('stay-put');
  });
});

describe('childRingRowFor (the card in the child\'s ring)', () => {
  const EXTRA = '9'.repeat(64);
  const dep = {
    id: KID, displayName: 'RunKid',
    naturalPerson: { publicKey: KID, privateKey: '' },
    persona: { publicKey: 'e'.repeat(64), privateKey: '' },
    extraPersonas: [{ publicKey: EXTRA, privateKey: '', displayName: 'Kid Extra' }],
    naturalPersonActive: true,
  } as unknown as DependantIdentity;

  it('finds the real-name, persona and extra persona cards of the child ring', () => {
    const rows = buildChildRows(dep);
    expect(rows[childRingRowFor(rows, 'natural-person')].type).toBe('dependant');
    expect(rows[childRingRowFor(rows, 'persona')].type).toBe('dependant-persona');
    expect(rows[childRingRowFor(rows, EXTRA)].type).toBe('dependant-extra-persona');
    expect(childRingRowFor(rows, 'f'.repeat(64))).toBe(-1);
  });

  it('a dormant real name has no card in the ring', () => {
    const rows = buildChildRows({ ...dep, naturalPersonActive: false } as DependantIdentity);
    expect(childRingRowFor(rows, 'natural-person')).toBe(-1);
  });
});

describe('childModeSessionStale (a saved session that can never restore)', () => {
  const base = { unlocked: true, dependantsLoadedWithKey: true, childModeLive: false, sessionDependantId: KID, dependantIds: [SIB] };

  it('is stale once unlocked and read with the key, when the session\'s child is not there', () => {
    expect(childModeSessionStale(base)).toBe(true);
    expect(childModeSessionStale({ ...base, dependantIds: [] })).toBe(true);
  });

  it('is never stale while the child is there: the restore will put child mode back', () => {
    expect(childModeSessionStale({ ...base, dependantIds: [SIB, KID] })).toBe(false);
  });

  it('is never stale before the keyed read, so a valid session survives the keyless or empty window', () => {
    expect(childModeSessionStale({ ...base, unlocked: false, dependantIds: [] })).toBe(false);
    expect(childModeSessionStale({ ...base, dependantsLoadedWithKey: false, dependantIds: [] })).toBe(false);
  });

  it('is never stale while child mode is live, or with no session', () => {
    expect(childModeSessionStale({ ...base, childModeLive: true })).toBe(false);
    expect(childModeSessionStale({ ...base, sessionDependantId: null })).toBe(false);
    expect(childModeSessionStale({ ...base, sessionDependantId: undefined })).toBe(false);
  });
});

describe('loadDependantSignInFacts (read before unlock)', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.resetModules();
  });

  const KEY = 'k'.repeat(64);
  const GUARDIAN = 'f'.repeat(64);
  function makeDep() {
    return buildPersonaFirstDependant({
      guardianPubkey: GUARDIAN, enteredName: 'RunKid', derivationPath: 'dependant-0',
      naturalPerson: { publicKey: getPublicKey(generateSecretKey()), privateKey: '' },
      persona: { publicKey: getPublicKey(generateSecretKey()), privateKey: '' },
      createdAt: 1_700_000_000,
    });
  }
  const CD = { mode: 'heartwood-direct' as const, slotLabel: 'signet:child-device:v2:x', secretFingerprint: 'ab'.repeat(32), slotIndex: 3,
    clientPubkey: 'c'.repeat(64), boundPersona: 'd'.repeat(64), pairedAt: 1, railRelay: 'wss://rail.example.com' };

  it('reads the name and the child-phone link of an encrypted record with no key', async () => {
    const db = await import('./db');
    const dep = makeDep();
    await db.saveDependant({ ...dep, childDevice: CD }, KEY);
    const facts = await db.loadDependantSignInFacts(dep.id);
    expect(facts).toEqual({ id: dep.id, displayName: dep.displayName, childDevice: { mode: 'heartwood-direct' } });
    expect(childModeSignInRefusal({ childMode: true, dependant: facts })).toEqual({ child: dep.displayName });
  });

  it('has no child-phone link for a phone-served child, and nothing for a missing one', async () => {
    const db = await import('./db');
    const dep = makeDep();
    await db.saveDependant(dep, KEY);
    expect(await db.loadDependantSignInFacts(dep.id)).toEqual({ id: dep.id, displayName: dep.displayName });
    expect(await db.loadDependantSignInFacts('9'.repeat(64))).toBeNull();
  });
});
