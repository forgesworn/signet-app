import { describe, it, expect } from 'vitest';
import { buildPersonaFirstDependant } from './dependant-record';
import { buildAuditEventTemplate } from './audit';
import { buildAddDependantCallbackUrl, buildAddDependantProofTemplate } from './url-auth';
import { buildCompilerInput } from './policy-compiler';
import { resolveDependantRouteSlots } from './dependant-route-slots';
import { buildDependantKeypairOptions } from './auth-selection';
import { buildPairingURI } from './pairing-uri';
import { resolveDependantCardSlot } from './carousel-utils';

const GUARDIAN = 'f'.repeat(64);
const NP = 'a'.repeat(64);
const PERSONA = 'b'.repeat(64);
const ENDPOINT = 'c'.repeat(64);

const dep = buildPersonaFirstDependant({
  guardianPubkey: GUARDIAN,
  enteredName: 'Lily',
  dateOfBirth: '2015-06-01',
  derivationPath: 'dependant-0',
  naturalPerson: { publicKey: NP, privateKey: 'aa' },
  persona: { publicKey: PERSONA, privateKey: 'bb' },
  createdAt: 1_700_000_000,
});

describe('a persona-first dependant binds every surface to the persona (spec §7.6/§13)', () => {
  it('the record id IS the persona pubkey', () => {
    expect(dep.id).toBe(PERSONA);
  });

  it('the kind-31000 audit d tag carries the persona, not the real identity', () => {
    const tmpl = buildAuditEventTemplate(
      { dependantPubkey: dep.id, eventKind: 21236, outcome: 'auto-approved' },
      GUARDIAN,
    );
    const d = tmpl.tags.find(t => t[0] === 'd')![1];
    expect(d.startsWith(PERSONA)).toBe(true);
    expect(JSON.stringify(tmpl)).not.toContain(NP);
  });

  it('the add-dependant callback carries the persona in every param', () => {
    const url = buildAddDependantCallbackUrl(
      'https://consumer.example/cb',
      dep.id,
      'npub1fake',
      GUARDIAN,
      'sig'.repeat(10),
      'e'.repeat(64),
    )!;
    const params = new URL(url).searchParams;
    expect(params.get('dependantPubkey')).toBe(PERSONA);
    expect(params.get('guardianPubkey')).toBe(GUARDIAN);
    expect(url).not.toContain(NP);
  });

  it('the proof event’s ["dependant", pubkey] tag matches the callback param', () => {
    // App.tsx calls buildAddDependantProofTemplate with the same
    // `dependantPubkey` local it passes to buildAddDependantCallbackUrl,
    // which is `newDep.id`.
    const tmpl = buildAddDependantProofTemplate(
      { challenge: 'e'.repeat(64), origin: 'https://consumer.example' },
      dep.id,
      GUARDIAN,
      1_700_000_000,
    );
    const proofTag = tmpl.tags.find(t => t[0] === 'dependant')!;
    expect(proofTag[1]).toBe(PERSONA);
    expect(JSON.stringify(tmpl)).not.toContain(NP);
  });

  it('the pairing URI advertises the persona', () => {
    const uri = buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays: ['wss://relay.example'],
      secret: 's'.repeat(32),
      dependantPubkey: dep.id,
      dependantName: dep.displayName,
      guardianPubkey: GUARDIAN,
    });
    expect(uri).toContain(PERSONA);
    expect(uri).not.toContain(NP);
  });

  it('the compiler input marks the real identity dormant while still listing it', () => {
    const input = buildCompilerInput({
      dependants: [dep],
      grants: [],
      guardianClientPubkey: null,
      deviceSlots: [],
      nowSeconds: 1_700_000_000,
    });
    expect(input.dependants[0].id).toBe(PERSONA);
    expect(input.dependants[0].dormantIdentityPubkeys).toEqual([NP]);
  });

  it('the bunker route signs as the persona and cannot address the real identity', () => {
    const slots = resolveDependantRouteSlots(dep)!;
    expect(slots.defaultSlot.publicKey).toBe(PERSONA);
    expect(slots.addressableSlots.map(s => s.publicKey)).not.toContain(NP);
  });

  it('the sign-in picker offers only the persona', () => {
    expect(buildDependantKeypairOptions(dep).map(o => o.pubkey)).toEqual([PERSONA]);
  });

  it('the carousel card resolves to the persona slot', () => {
    expect(resolveDependantCardSlot(dep).slot.publicKey).toBe(PERSONA);
  });
});

describe('an existing dependant is unmoved by any of it', () => {
  const legacy = {
    ...dep,
    id: NP,
    primaryKeypair: 'natural-person' as const,
    naturalPersonActive: true,
    naturalPerson: { publicKey: NP, privateKey: 'aa', displayName: 'Lily Rivera' },
  };

  it('keeps its NP-keyed id on the audit d tag', () => {
    const tmpl = buildAuditEventTemplate(
      { dependantPubkey: legacy.id, eventKind: 21236, outcome: 'auto-approved' },
      GUARDIAN,
    );
    expect(tmpl.tags.find(t => t[0] === 'd')![1].startsWith(NP)).toBe(true);
  });

  it('keeps its NP-keyed id on the proof event’s ["dependant", pubkey] tag', () => {
    const tmpl = buildAddDependantProofTemplate(
      { challenge: 'e'.repeat(64), origin: 'https://consumer.example' },
      legacy.id,
      GUARDIAN,
      1_700_000_000,
    );
    const proofTag = tmpl.tags.find(t => t[0] === 'dependant')!;
    expect(proofTag[1]).toBe(NP);
  });

  it('keeps its real identity addressable and in the picker', () => {
    expect(resolveDependantRouteSlots(legacy)!.defaultSlot.publicKey).toBe(NP);
    expect(buildDependantKeypairOptions(legacy).map(o => o.pubkey)).toEqual([NP, PERSONA]);
  });

  it('compiles with no dormant slots', () => {
    const input = buildCompilerInput({
      dependants: [legacy],
      grants: [],
      guardianClientPubkey: null,
      deviceSlots: [],
      nowSeconds: 1_700_000_000,
    });
    expect(input.dependants[0].dormantIdentityPubkeys).toEqual([]);
  });
});
