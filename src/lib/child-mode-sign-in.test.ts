import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { childModeSignInRefusal, childModeSelectionRefused } from './child-mode-sign-in';
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
