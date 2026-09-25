/**
 * Tests for the auth-selection resolvers — focused on the
 * `resolveSelectedPublicProfile` helper added in Phase F (sign-in
 * correlation hint). The display-name / pubkey / token resolvers are
 * already covered by callers via Playwright e2e; this file pins the new
 * publicProfile resolver explicitly.
 *
 * Post persona-card-source-of-truth refactor (2026-05-17), the resolver
 * returns a `SelectedPublicProfile` shape that composes the slot's
 * display fields (displayName, pictureUrl, about, nip05) with the
 * state-only `publicProfile` block (enabled, lastEventId/At/Relay).
 */

import { describe, it, expect } from 'vitest';
import { resolveSelectedPublicProfile, buildGuardianKeypairOptions, buildDependantKeypairOptions } from './auth-selection';
import type { SignetIdentity, DependantIdentity, PersonaPublicProfile } from '../types';

const NP_PK = 'a'.repeat(64);
const PERSONA_PK = 'b'.repeat(64);
const EXTRA_PK = 'c'.repeat(64);
const DEP_NP_PK = 'd'.repeat(64);
const DEP_ID = DEP_NP_PK; // dep.id is the dep's NP pubkey by convention

function makeProfile(overrides?: Partial<PersonaPublicProfile>): PersonaPublicProfile {
  return { enabled: true, ...overrides };
}

function makeIdentity(overrides?: {
  npProfile?: PersonaPublicProfile;
  personaProfile?: PersonaPublicProfile;
  extraProfile?: PersonaPublicProfile;
  npDisplayName?: string;
  personaDisplayName?: string;
  extraDisplayName?: string;
}): SignetIdentity {
  return {
    id: 'aabbccdd'.repeat(8),
    mnemonic: '',
    naturalPerson: {
      publicKey: NP_PK,
      privateKey: '11'.repeat(32),
      displayName: overrides?.npDisplayName ?? 'NP',
      publicProfile: overrides?.npProfile,
    },
    persona: {
      publicKey: PERSONA_PK,
      privateKey: '22'.repeat(32),
      displayName: overrides?.personaDisplayName ?? 'Persona',
      publicProfile: overrides?.personaProfile,
    },
    extraPersonas: [{
      publicKey: EXTRA_PK,
      privateKey: '33'.repeat(32),
      displayName: overrides?.extraDisplayName ?? 'Extra',
      derivationName: 'persona-1',
      publicProfile: overrides?.extraProfile,
    }],
    primaryKeypair: 'natural-person',
    isChild: false,
    createdAt: Date.now(),
  };
}

function makeDep(overrides?: {
  npProfile?: PersonaPublicProfile;
  personaProfile?: PersonaPublicProfile;
  npDisplayName?: string;
}): DependantIdentity {
  return {
    id: DEP_ID,
    guardianPubkey: 'e'.repeat(64),
    displayName: 'Kid',
    naturalPerson: {
      publicKey: DEP_NP_PK,
      privateKey: '44'.repeat(32),
      displayName: overrides?.npDisplayName ?? 'Kid NP',
      publicProfile: overrides?.npProfile,
    },
    persona: {
      publicKey: 'f'.repeat(64),
      privateKey: '55'.repeat(32),
      displayName: 'Kid Persona',
      publicProfile: overrides?.personaProfile,
    },
    extraPersonas: [],
    derivationPath: 'dependant-0',
    createdAt: Date.now(),
    autonomyStage: 'request-approve',
    primaryKeypair: 'natural-person',
  };
}

describe('resolveSelectedPublicProfile', () => {
  it('returns null when selection is null', () => {
    expect(resolveSelectedPublicProfile(null, makeIdentity())).toBeNull();
  });

  it('returns guardian NP publicProfile when selected', () => {
    const id = makeIdentity({ npProfile: makeProfile(), npDisplayName: 'np-handle' });
    const pp = resolveSelectedPublicProfile(
      { source: 'guardian', keypairType: 'natural-person' },
      id,
    );
    expect(pp?.enabled).toBe(true);
    expect(pp?.displayName).toBe('np-handle');
  });

  it('returns undefined when slot exists but no publicProfile set', () => {
    const id = makeIdentity();
    const pp = resolveSelectedPublicProfile(
      { source: 'guardian', keypairType: 'natural-person' },
      id,
    );
    expect(pp).toBeUndefined();
  });

  it('returns guardian persona publicProfile when selected', () => {
    const id = makeIdentity({ personaProfile: makeProfile(), personaDisplayName: 'persona-handle' });
    const pp = resolveSelectedPublicProfile(
      { source: 'guardian', keypairType: 'persona' },
      id,
    );
    expect(pp?.displayName).toBe('persona-handle');
  });

  it('returns extra-persona publicProfile when keypairType is the extra pubkey', () => {
    const id = makeIdentity({ extraProfile: makeProfile(), extraDisplayName: 'extra-handle' });
    const pp = resolveSelectedPublicProfile(
      { source: 'guardian', keypairType: EXTRA_PK },
      id,
    );
    expect(pp?.displayName).toBe('extra-handle');
  });

  it('returns null when extra-persona keypair pubkey is unknown', () => {
    const id = makeIdentity();
    const pp = resolveSelectedPublicProfile(
      { source: 'guardian', keypairType: 'z'.repeat(64) },
      id,
    );
    // Unknown extra-persona pubkey: the resolver's guardian branch returns
    // `ep ? buildFromSlot(ep) : null` — explicitly null, not undefined.
    expect(pp).toBeNull();
  });

  it('returns dep NP publicProfile when selected', () => {
    const id = makeIdentity();
    const dep = makeDep({ npProfile: makeProfile(), npDisplayName: 'kid-handle' });
    const pp = resolveSelectedPublicProfile(
      { source: 'dependant', dependantId: DEP_ID, keypairType: 'natural-person' },
      id,
      [dep],
    );
    expect(pp?.displayName).toBe('kid-handle');
  });

  it('returns null when dependantId is unknown', () => {
    const pp = resolveSelectedPublicProfile(
      { source: 'dependant', dependantId: 'unknown', keypairType: 'natural-person' },
      makeIdentity(),
      [makeDep()],
    );
    expect(pp).toBeNull();
  });

  it('respects enabled=false (still returns the record so caller sees the off state)', () => {
    const id = makeIdentity({ npProfile: makeProfile({ enabled: false }), npDisplayName: 'np-handle' });
    const pp = resolveSelectedPublicProfile(
      { source: 'guardian', keypairType: 'natural-person' },
      id,
    );
    expect(pp?.enabled).toBe(false);
    expect(pp?.displayName).toBe('np-handle');
  });
});

// ── Shared guardian picker builder (spec §6) ─────────────────────────────

function identityWith(o: Partial<SignetIdentity> = {}): SignetIdentity {
  return {
    id: 'a'.repeat(64),
    mnemonic: '',
    naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'Real Name' },
    persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Shade' },
    primaryKeypair: 'persona',
    isChild: false,
    createdAt: 0,
    ...o,
  } as SignetIdentity;
}

describe('buildGuardianKeypairOptions', () => {
  it('excludes the natural person while it is dormant', () => {
    const opts = buildGuardianKeypairOptions(identityWith({
      naturalPersonActive: false,
      naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
    }));
    expect(opts.map(o => o.key)).toEqual(['persona']);
  });

  it('includes the natural person once activated, after the persona', () => {
    const opts = buildGuardianKeypairOptions(identityWith({ naturalPersonActive: true }));
    expect(opts.map(o => o.key)).toEqual(['persona', 'natural-person']);
    expect(opts[1].token).toBe('natural-person');
    expect(opts[1].label).toBe('Real Name');
  });

  it('includes visible extras and skips hidden ones', () => {
    const opts = buildGuardianKeypairOptions(identityWith({
      naturalPersonActive: true,
      extraPersonas: [
        { publicKey: 'x1', privateKey: '', displayName: 'Gamer', derivationName: 'persona-1' },
        { publicKey: 'x2', privateKey: '', displayName: 'Gone', derivationName: 'persona-2', hidden: true },
      ],
    }));
    expect(opts.map(o => o.key)).toEqual(['persona', 'x1', 'natural-person']);
  });

  it('omits the persona when the slot has no pubkey', () => {
    const opts = buildGuardianKeypairOptions(identityWith({
      naturalPersonActive: true,
      persona: { publicKey: '', privateKey: '', displayName: '' },
    }));
    expect(opts.map(o => o.key)).toEqual(['natural-person']);
  });

  it('falls back to a generic label for an unnamed persona', () => {
    const opts = buildGuardianKeypairOptions(identityWith({
      naturalPersonActive: false,
      persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: '' },
    }));
    expect(opts[0].label).toBe('Persona');
  });
});

describe('buildDependantKeypairOptions (spec §6/§7.6)', () => {
  const activeDep: DependantIdentity = {
    id: 'dep-np',
    guardianPubkey: 'g',
    displayName: 'Ben Smith',
    naturalPerson: { publicKey: 'dep-np', privateKey: '', displayName: 'Ben Smith' },
    persona: { publicKey: 'dep-p', privateKey: '', displayName: 'BenGamer' },
    derivationPath: 'dependant-0',
    createdAt: 0,
    autonomyStage: 'full-control',
    primaryKeypair: 'natural-person',
  };

  const dormantDep: DependantIdentity = {
    ...activeDep,
    id: 'dep-p',
    primaryKeypair: 'persona',
    naturalPersonActive: false,
    naturalPerson: { publicKey: 'dep-np', privateKey: '', displayName: '' },
    persona: { publicKey: 'dep-p', privateKey: '', displayName: 'Lily' },
  };

  it('offers the real identity first for an existing dependant', () => {
    const opts = buildDependantKeypairOptions(activeDep);
    expect(opts.map(o => o.key)).toEqual(['natural-person', 'persona']);
    expect(opts[0].pubkey).toBe('dep-np');
  });

  it('omits a dormant real identity entirely', () => {
    const opts = buildDependantKeypairOptions(dormantDep);
    expect(opts.map(o => o.key)).toEqual(['persona']);
    expect(opts.some(o => o.pubkey === 'dep-np')).toBe(false);
  });

  it('includes unhidden extras and skips hidden ones', () => {
    const opts = buildDependantKeypairOptions({
      ...dormantDep,
      extraPersonas: [
        { publicKey: 'ep1', privateKey: '', displayName: 'LilyPlays', derivationName: 'dependant-0-persona-1' },
        { publicKey: 'ep2', privateKey: '', displayName: 'Gone', derivationName: 'dependant-0-persona-2', hidden: true },
      ],
    });
    expect(opts.map(o => o.key)).toEqual(['persona', 'ep1']);
  });

  it('omits the persona when there is no persona key (view-only import)', () => {
    const opts = buildDependantKeypairOptions({
      ...activeDep,
      persona: { publicKey: '', privateKey: '', displayName: '' },
    });
    expect(opts.map(o => o.key)).toEqual(['natural-person']);
  });

  it('returns an empty list when the NP is dormant and there is no persona', () => {
    expect(buildDependantKeypairOptions({
      ...dormantDep,
      persona: { publicKey: '', privateKey: '', displayName: '' },
    })).toEqual([]);
  });
});
