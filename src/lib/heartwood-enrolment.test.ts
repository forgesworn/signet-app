import { describe, it, expect, vi } from 'vitest';
import {
  buildEnrolmentPlan,
  parseDerivePersonaResult,
  enrolSlot,
  derivePersonaToken,
  type EnrolmentSlot,
  type SkippedSlot,
} from './heartwood-enrolment';
import type { SignetIdentity } from '../types/identity';
import type { DependantIdentity } from '../types/dependants';
import { encodeNpub, hexToBytes } from './signet';

type OwnerIdentity = Pick<SignetIdentity, 'naturalPerson' | 'persona' | 'professionalPersona' | 'extraPersonas'>;

const NP_PUBKEY = 'aaaa00000000000000000000000000000000000000000000000000000000aaaa'; // 64 hex chars
const PERSONA_PUBKEY = 'bbbb00000000000000000000000000000000000000000000000000000000bbbb';
const PRO_PUBKEY = 'cccc00000000000000000000000000000000000000000000000000000000cccc';
const P1 = 'dddd00000000000000000000000000000000000000000000000000000000dddd'; // hidden tree-derived extra
const P2 = 'eeee00000000000000000000000000000000000000000000000000000000eeee'; // imported extra
const P3 = 'ffff00000000000000000000000000000000000000000000000000000000ffff'; // mirror extra
const D1 = '11110000000000000000000000000000000000000000000000000000000011a1'; // dep NP
const D2 = '22220000000000000000000000000000000000000000000000000000000022b2'; // dep persona
const D3 = '33330000000000000000000000000000000000000000000000000000000033c3'; // dep extra

function makeOwner(overrides: Partial<OwnerIdentity> = {}): OwnerIdentity {
  return {
    naturalPerson: {
      publicKey: NP_PUBKEY,
      privateKey: 'np-priv',
      displayName: 'Alex',
    },
    persona: {
      publicKey: PERSONA_PUBKEY,
      privateKey: 'persona-priv',
      displayName: 'Anon persona',
    },
    professionalPersona: {
      publicKey: PRO_PUBKEY,
      privateKey: 'pro-priv',
      displayName: 'Alex (Pro)',
    },
    extraPersonas: [
      { derivationName: 'persona-2', publicKey: P1, privateKey: 'p1-priv', displayName: 'Hidden Extra', hidden: true },
      { derivationName: '', imported: true, publicKey: P2, privateKey: 'p2-priv', displayName: 'Imported Extra' },
      { derivationName: '', publicKey: P3, privateKey: 'p3-priv', displayName: 'Mirror Extra' },
    ],
    ...overrides,
  };
}

function makeDependants(overrides: Partial<DependantIdentity>[] = []): DependantIdentity[] {
  const d1: DependantIdentity = {
    id: 'd1',
    guardianPubkey: NP_PUBKEY,
    displayName: 'Robin',
    naturalPerson: { publicKey: D1, privateKey: 'd1-np-priv', displayName: 'Robin' },
    persona: { publicKey: D2, privateKey: 'd1-persona-priv', displayName: 'Robin Persona' },
    extraPersonas: [
      { derivationName: 'dependant-0-persona-1', publicKey: D3, privateKey: 'd1-extra-priv', displayName: 'Robin Extra' },
    ],
    derivationPath: 'dependant-0',
    createdAt: 1,
    autonomyStage: 'full-control',
    primaryKeypair: 'natural-person',
  };
  const d2: DependantIdentity = {
    id: 'd2',
    guardianPubkey: NP_PUBKEY,
    displayName: 'Beau',
    naturalPerson: { publicKey: 'imp-np-pub', privateKey: 'imp-np-priv', displayName: 'Beau' },
    persona: { publicKey: 'imp-persona-pub', privateKey: 'imp-persona-priv', displayName: 'Beau Persona' },
    derivationPath: 'imported-abc12345',
    createdAt: 2,
    autonomyStage: 'full-control',
    primaryKeypair: 'natural-person',
  };
  const base = [d1, d2];
  return base.map((d, i) => ({ ...d, ...overrides[i] }));
}

function findSlot(slots: EnrolmentSlot[], token: string): EnrolmentSlot | undefined {
  return slots.find((s) => s.token === token);
}

function findSkipped(skipped: SkippedSlot[], label: string): SkippedSlot | undefined {
  return skipped.find((s) => s.label === label);
}

describe('buildEnrolmentPlan', () => {
  it('orders owner slots NP, persona, professional, extras', () => {
    const plan = buildEnrolmentPlan(makeOwner(), makeDependants());
    const ownerTokens = plan.slots
      .filter((s) => s.kind.startsWith('owner-'))
      .map((s) => s.token);
    expect(ownerTokens).toEqual(['natural-person', 'persona', 'professional', 'persona-2']);
  });

  it('enrols hidden tree-derived extras', () => {
    const plan = buildEnrolmentPlan(makeOwner(), makeDependants());
    const slot = findSlot(plan.slots, 'persona-2');
    expect(slot).toBeDefined();
    expect(slot?.kind).toBe('owner-extra');
    expect(slot?.expectedPubkeyHex).toBe(P1);
    expect(slot?.label).toBe('Hidden Extra');
  });

  it('skips imported extras with reason imported-persona', () => {
    const plan = buildEnrolmentPlan(makeOwner(), makeDependants());
    expect(findSkipped(plan.skipped, 'Imported Extra')).toEqual({
      label: 'Imported Extra',
      reason: 'imported-persona',
    });
  });

  it('skips mirror personas with reason mirror-persona', () => {
    const plan = buildEnrolmentPlan(makeOwner(), makeDependants());
    expect(findSkipped(plan.skipped, 'Mirror Extra')).toEqual({
      label: 'Mirror Extra',
      reason: 'mirror-persona',
    });
  });

  it('omits professional entirely (no slot, no skip entry) when the identity has no pro persona at all', () => {
    const ownerNoPro = makeOwner({ professionalPersona: undefined });
    const plan = buildEnrolmentPlan(ownerNoPro, []);
    expect(findSlot(plan.slots, 'professional')).toBeUndefined();
    expect(plan.skipped.some((s) => s.label === 'Alex (Pro)')).toBe(false);
  });

  it('reports a present-but-pubkey-empty professional persona as a missing-pubkey skip, not a silent omission', () => {
    const ownerEmptyPro = makeOwner({
      professionalPersona: { publicKey: '', privateKey: '', displayName: 'Alex (Pro)' },
    });
    const plan = buildEnrolmentPlan(ownerEmptyPro, []);
    expect(findSlot(plan.slots, 'professional')).toBeUndefined();
    expect(findSkipped(plan.skipped, 'Alex (Pro)')).toEqual({
      label: 'Alex (Pro)',
      reason: 'missing-pubkey',
    });
  });

  it('maps tree-derived dependants to -np/-persona/extra tokens with depId', () => {
    const plan = buildEnrolmentPlan(makeOwner(), makeDependants());
    const np = findSlot(plan.slots, 'dependant-0-np');
    const persona = findSlot(plan.slots, 'dependant-0-persona');
    const extra = findSlot(plan.slots, 'dependant-0-persona-1');

    expect(np).toEqual({
      token: 'dependant-0-np',
      kind: 'dep-np',
      depId: 'd1',
      label: 'Robin — natural person',
      expectedPubkeyHex: D1,
    });
    expect(persona).toEqual({
      token: 'dependant-0-persona',
      kind: 'dep-persona',
      depId: 'd1',
      label: 'Robin — anonymous persona',
      expectedPubkeyHex: D2,
    });
    expect(extra).toEqual({
      token: 'dependant-0-persona-1',
      kind: 'dep-extra',
      depId: 'd1',
      label: 'Robin — Robin Extra',
      expectedPubkeyHex: D3,
    });
  });

  it('skips imported dependants wholesale', () => {
    const plan = buildEnrolmentPlan(makeOwner(), makeDependants());
    expect(findSkipped(plan.skipped, 'Beau')).toEqual({ label: 'Beau', reason: 'imported-dependant' });
    // no per-slot tokens leaked out for the imported dependant
    expect(plan.slots.some((s) => s.depId === 'd2')).toBe(false);
  });

  it('skips a dep-scoped imported/mirror extra persona (dep-extra path is a separate loop from the owner-extra one)', () => {
    const P4 = '55550000000000000000000000000000000000000000000000000000000055e5'; // dep imported extra
    const P5 = '66660000000000000000000000000000000000000000000000000000000066f6'; // dep mirror extra
    const dependants = makeDependants([
      {
        extraPersonas: [
          { derivationName: 'dependant-0-persona-1', publicKey: D3, privateKey: 'd1-extra-priv', displayName: 'Robin Extra' },
          { derivationName: '', imported: true, publicKey: P4, privateKey: 'p4-priv', displayName: 'Robin Imported Extra' },
          { derivationName: '', publicKey: P5, privateKey: 'p5-priv', displayName: 'Robin Mirror Extra' },
        ],
      },
    ]);
    const plan = buildEnrolmentPlan(makeOwner(), dependants);

    expect(findSkipped(plan.skipped, 'Robin — Robin Imported Extra')).toEqual({
      label: 'Robin — Robin Imported Extra',
      reason: 'imported-persona',
    });
    expect(findSkipped(plan.skipped, 'Robin — Robin Mirror Extra')).toEqual({
      label: 'Robin — Robin Mirror Extra',
      reason: 'mirror-persona',
    });
    // the tree-derived dep extra still enrols normally alongside the skips
    expect(findSlot(plan.slots, 'dependant-0-persona-1')).toBeDefined();
    expect(plan.slots.some((s) => s.label === 'Robin — Robin Imported Extra')).toBe(false);
    expect(plan.slots.some((s) => s.label === 'Robin — Robin Mirror Extra')).toBe(false);
  });

  it('skips slots with empty publicKey with reason missing-pubkey', () => {
    const owner = makeOwner({
      persona: { publicKey: '', privateKey: 'persona-priv', displayName: 'Anon persona' },
    });
    const plan = buildEnrolmentPlan(owner, []);
    expect(findSlot(plan.slots, 'persona')).toBeUndefined();
    expect(findSkipped(plan.skipped, 'Anon persona')).toEqual({
      label: 'Anon persona',
      reason: 'missing-pubkey',
    });
  });

  it('lowercases expectedPubkeyHex', () => {
    const owner = makeOwner({
      naturalPerson: { publicKey: NP_PUBKEY.toUpperCase(), privateKey: 'np-priv', displayName: 'Alex' },
    });
    const plan = buildEnrolmentPlan(owner, []);
    const np = findSlot(plan.slots, 'natural-person');
    expect(np?.expectedPubkeyHex).toBe(NP_PUBKEY.toLowerCase());
    expect(np?.expectedPubkeyHex).not.toBe(NP_PUBKEY.toUpperCase());
  });
});

describe('parseDerivePersonaResult', () => {
  it('parses a valid payload', () => {
    const raw = JSON.stringify({
      npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqjnk9wu',
      purpose: 'nostr:persona:natural-person',
      index: 0,
      personaName: 'natural-person',
    });
    expect(parseDerivePersonaResult(raw)).toEqual({
      npub: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqjnk9wu',
      purpose: 'nostr:persona:natural-person',
      index: 0,
      personaName: 'natural-person',
    });
  });

  it('returns null for malformed JSON', () => {
    expect(parseDerivePersonaResult('not json')).toBeNull();
  });

  it('returns null for a non-object payload', () => {
    expect(parseDerivePersonaResult('"just a string"')).toBeNull();
    expect(parseDerivePersonaResult('42')).toBeNull();
    expect(parseDerivePersonaResult('[1,2,3]')).toBeNull();
  });

  it('returns null when a field is missing', () => {
    expect(parseDerivePersonaResult(JSON.stringify({ npub: 'npub1x', purpose: 'p', index: 0 }))).toBeNull();
  });

  it('returns null when a field has the wrong type', () => {
    expect(
      parseDerivePersonaResult(
        JSON.stringify({ npub: 'npub1x', purpose: 'p', index: '0', personaName: 'n' }),
      ),
    ).toBeNull();
  });
});

describe('enrolSlot', () => {
  const baseSlot: EnrolmentSlot = {
    token: 'natural-person',
    expectedPubkeyHex: NP_PUBKEY,
    label: 'Alex (you)',
    kind: 'owner-np',
  };

  function deriveResponse(hex: string, token = 'natural-person') {
    const npub = encodeNpub(hexToBytes(hex));
    return JSON.stringify({ npub, purpose: `nostr:persona:${token}`, index: 0, personaName: token });
  }

  it('calls requestFn with the derive method and slot token', async () => {
    const requestFn = vi.fn().mockResolvedValue(deriveResponse(NP_PUBKEY));
    await enrolSlot(requestFn, baseSlot);
    expect(requestFn).toHaveBeenCalledWith('heartwood_derive_persona', ['natural-person']);
  });

  it('verifies a matching derived pubkey', async () => {
    const requestFn = vi.fn().mockResolvedValue(deriveResponse(NP_PUBKEY));
    const outcome = await enrolSlot(requestFn, baseSlot);
    expect(outcome).toEqual({ status: 'verified', pubkeyHex: NP_PUBKEY.toLowerCase() });
  });

  it('reports a mismatch with the got pubkey when the derived key differs', async () => {
    const otherHex = 'dead00000000000000000000000000000000000000000000000000000000dead';
    const requestFn = vi.fn().mockResolvedValue(deriveResponse(otherHex));
    const outcome = await enrolSlot(requestFn, baseSlot);
    expect(outcome).toEqual({ status: 'mismatch', gotPubkeyHex: otherHex.toLowerCase() });
  });

  it('returns an error for an unparseable response', async () => {
    const requestFn = vi.fn().mockResolvedValue('not json');
    const outcome = await enrolSlot(requestFn, baseSlot);
    expect(outcome).toEqual({ status: 'error', message: 'Unexpected response from signer' });
  });

  it('maps a storage-full rejection to status storage-full with the verbatim message', async () => {
    const requestFn = vi.fn().mockRejectedValue(new Error('identity storage full: 8/8 slots used'));
    const outcome = await enrolSlot(requestFn, baseSlot);
    expect(outcome).toEqual({ status: 'storage-full', message: 'identity storage full: 8/8 slots used' });
  });

  it('maps any other rejection to status error with the message', async () => {
    const requestFn = vi.fn().mockRejectedValue(new Error('user rejected the request'));
    const outcome = await enrolSlot(requestFn, baseSlot);
    expect(outcome).toEqual({ status: 'error', message: 'user rejected the request' });
  });

  it('times out a never-resolving requestFn', async () => {
    const requestFn = vi.fn().mockReturnValue(new Promise<string>(() => {}));
    const outcome = await enrolSlot(requestFn, baseSlot, 10);
    expect(outcome).toEqual({
      status: 'error',
      message: 'Timed out waiting for the signer — check the device and try again',
    });
  });

  it('returns an error (not a crash) for an invalid npub in an otherwise-parsed result', async () => {
    const raw = JSON.stringify({
      npub: 'npub1invalidnotbech32',
      purpose: 'nostr:persona:natural-person',
      index: 0,
      personaName: 'natural-person',
    });
    const requestFn = vi.fn().mockResolvedValue(raw);
    const outcome = await enrolSlot(requestFn, baseSlot);
    expect(outcome).toEqual({ status: 'error', message: 'Unexpected response from signer' });
  });
});

describe('derivePersonaToken', () => {
  const PK = 'c'.repeat(64);
  it('returns ok with the decoded pubkey, index and purpose', async () => {
    const requestFn = vi.fn(async () => JSON.stringify({ npub: encodeNpub(hexToBytes(PK)), purpose: 'dependant-2-np', index: 0, personaName: 'x' }));
    const out = await derivePersonaToken(requestFn, 'dependant-2-np');
    expect(out).toEqual({ status: 'ok', pubkeyHex: PK, index: 0, purpose: 'dependant-2-np' });
    expect(requestFn).toHaveBeenCalledWith('heartwood_derive_persona', ['dependant-2-np']);
  });
  it('maps the -4 storage message to storage-full', async () => {
    const requestFn = vi.fn(async () => { throw new Error('identity storage full (-4)'); });
    expect((await derivePersonaToken(requestFn, 't')).status).toBe('storage-full');
  });
  it('maps garbage to error', async () => {
    const requestFn = vi.fn(async () => 'nope');
    expect(await derivePersonaToken(requestFn, 't')).toEqual({ status: 'error', message: 'Unexpected response from signer' });
  });
});
