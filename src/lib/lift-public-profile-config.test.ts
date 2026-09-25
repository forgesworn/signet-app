import { describe, it, expect } from 'vitest';
import { liftPublicProfileConfig, liftDependantPublicProfileConfig } from './lift-public-profile-config';
import type { SignetIdentity, DependantIdentity, ExtraPersona } from '../types';

const NP_PK = 'a'.repeat(64);
const NP_SK = '1'.repeat(64);
const PERSONA_PK = 'b'.repeat(64);
const PERSONA_SK = '2'.repeat(64);
const PRO_PK = 'e'.repeat(64);
const PRO_SK = '5'.repeat(64);
const EXTRA_PK_1 = 'c'.repeat(64);
const EXTRA_SK_1 = '3'.repeat(64);
const EXTRA_PK_2 = 'd'.repeat(64);
const EXTRA_SK_2 = '4'.repeat(64);
const GUARDIAN_PK = 'f'.repeat(64);

function makeIdentity(overrides: Partial<SignetIdentity> = {}): SignetIdentity {
  return {
    id: NP_PK,
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    naturalPerson: {
      publicKey: NP_PK,
      privateKey: NP_SK,
      displayName: 'Alex',
    },
    persona: {
      publicKey: PERSONA_PK,
      privateKey: PERSONA_SK,
      displayName: 'Alex (anonymous)',
    },
    primaryKeypair: 'natural-person',
    isChild: false,
    createdAt: 1_700_000_000,
    ...overrides,
  };
}

function makeDependant(overrides: Partial<DependantIdentity> = {}): DependantIdentity {
  return {
    id: NP_PK,
    guardianPubkey: GUARDIAN_PK,
    displayName: 'Kid',
    naturalPerson: {
      publicKey: NP_PK,
      privateKey: NP_SK,
      displayName: 'Kid',
    },
    persona: {
      publicKey: PERSONA_PK,
      privateKey: PERSONA_SK,
      displayName: 'Kid (anonymous)',
    },
    derivationPath: 'dependant-0',
    createdAt: 1_700_000_000,
    autonomyStage: 'full-control',
    primaryKeypair: 'natural-person',
    ...overrides,
  };
}

function makeExtra(overrides: Partial<ExtraPersona> = {}): ExtraPersona {
  return {
    publicKey: EXTRA_PK_1,
    privateKey: EXTRA_SK_1,
    displayName: 'Gaming',
    derivationName: 'persona-2',
    ...overrides,
  };
}

const FULL_LEGACY = {
  enabled: true,
  name: 'Legacy Name',
  displayName: 'Legacy Display',
  about: 'I do stuff.',
  pictureUrl: 'https://example.com/p.jpg',
  pictureBlossomHash: 'aa'.repeat(32),
  bannerUrl: 'https://example.com/b.jpg',
  bannerBlossomHash: 'bb'.repeat(32),
  nip05: 'alex@example.com',
  lud16: 'alex@wallet.example',
  website: 'https://example.com',
  lastEventId: 'cc'.repeat(32),
  lastPublishedAt: 1_700_000_001,
  lastPublishedRelay: 'wss://relay.example',
} as const;

describe('liftPublicProfileConfig', () => {
  it('lifts a full legacy publicProfile up to slot top-level', () => {
    const id = makeIdentity({
      naturalPerson: {
        publicKey: NP_PK,
        privateKey: NP_SK,
        displayName: 'Alex',
        // legacy: all config fields buried inside publicProfile
        publicProfile: { ...FULL_LEGACY } as never,
      },
    });

    const lifted = liftPublicProfileConfig(id);
    const np = lifted.naturalPerson;

    // All 8 config fields lifted to top-level
    expect(np.about).toBe('I do stuff.');
    expect(np.pictureUrl).toBe('https://example.com/p.jpg');
    expect(np.pictureBlossomHash).toBe('aa'.repeat(32));
    expect(np.bannerUrl).toBe('https://example.com/b.jpg');
    expect(np.bannerBlossomHash).toBe('bb'.repeat(32));
    expect(np.nip05).toBe('alex@example.com');
    expect(np.lud16).toBe('alex@wallet.example');
    expect(np.website).toBe('https://example.com');

    // publicProfile shrinks to state-only
    expect(np.publicProfile).toEqual({
      enabled: true,
      lastEventId: 'cc'.repeat(32),
      lastPublishedAt: 1_700_000_001,
      lastPublishedRelay: 'wss://relay.example',
    });

    // `name` is dropped (not on PersonaPublicProfile)
    expect((np.publicProfile as unknown as Record<string, unknown>).name).toBeUndefined();
    expect((np.publicProfile as unknown as Record<string, unknown>).about).toBeUndefined();
    expect((np.publicProfile as unknown as Record<string, unknown>).pictureUrl).toBeUndefined();
  });

  it('is idempotent — running on an already-lifted slot yields same structure', () => {
    const id = makeIdentity({
      naturalPerson: {
        publicKey: NP_PK,
        privateKey: NP_SK,
        displayName: 'Alex',
        about: 'I do stuff.',
        publicProfile: { enabled: true, lastEventId: 'cc'.repeat(32) },
      },
    });

    const once = liftPublicProfileConfig(id);
    const twice = liftPublicProfileConfig(once);

    // No config remnants on the publicProfile object — already state-only
    expect(twice).toBe(once); // same reference since needsLift returns false
    expect(twice.naturalPerson.about).toBe('I do stuff.');
    expect(twice.naturalPerson.publicProfile).toEqual({ enabled: true, lastEventId: 'cc'.repeat(32) });
  });

  it('returns original (same reference) when publicProfile is absent', () => {
    const id = makeIdentity();
    const lifted = liftPublicProfileConfig(id);
    expect(lifted).toBe(id);
  });

  it('returns original (same reference) when publicProfile carries only state fields', () => {
    const id = makeIdentity({
      naturalPerson: {
        publicKey: NP_PK,
        privateKey: NP_SK,
        displayName: 'Alex',
        publicProfile: { enabled: true, lastEventId: 'cc'.repeat(32), lastPublishedAt: 1, lastPublishedRelay: 'wss://r' },
      },
    });
    const lifted = liftPublicProfileConfig(id);
    expect(lifted).toBe(id);
  });

  it('top-level field wins over legacy when both set; legacy is discarded', () => {
    const id = makeIdentity({
      naturalPerson: {
        publicKey: NP_PK,
        privateKey: NP_SK,
        displayName: 'Alex',
        about: 'TOP-LEVEL',
        pictureUrl: 'https://top.example/p.jpg',
        publicProfile: {
          enabled: true,
          about: 'LEGACY',
          pictureUrl: 'https://legacy.example/p.jpg',
          nip05: 'lifted@example.com',
        } as never,
      },
    });

    const lifted = liftPublicProfileConfig(id);
    expect(lifted.naturalPerson.about).toBe('TOP-LEVEL');
    expect(lifted.naturalPerson.pictureUrl).toBe('https://top.example/p.jpg');
    // Legacy-only field still lifts
    expect(lifted.naturalPerson.nip05).toBe('lifted@example.com');
    // publicProfile shrunk to state-only
    expect(lifted.naturalPerson.publicProfile).toEqual({ enabled: true });
  });

  it('lifts NP + persona + professionalPersona + multiple extras in one call', () => {
    const id = makeIdentity({
      naturalPerson: {
        publicKey: NP_PK,
        privateKey: NP_SK,
        displayName: 'Alex',
        publicProfile: { enabled: true, about: 'np-about' } as never,
      },
      persona: {
        publicKey: PERSONA_PK,
        privateKey: PERSONA_SK,
        displayName: 'Alex (anon)',
        publicProfile: { enabled: false, pictureUrl: 'https://p.example/p.jpg' } as never,
      },
      professionalPersona: {
        publicKey: PRO_PK,
        privateKey: PRO_SK,
        displayName: 'Dr Alex',
        publicProfile: { enabled: true, nip05: 'dr@example.com' } as never,
      },
      extraPersonas: [
        makeExtra({
          publicKey: EXTRA_PK_1,
          privateKey: EXTRA_SK_1,
          displayName: 'Gaming',
          publicProfile: { enabled: true, lud16: 'gaming@wallet.example' } as never,
        }),
        makeExtra({
          publicKey: EXTRA_PK_2,
          privateKey: EXTRA_SK_2,
          displayName: 'School',
          derivationName: 'persona-3',
          publicProfile: { enabled: false, website: 'https://school.example' } as never,
        }),
      ],
    });

    const lifted = liftPublicProfileConfig(id);

    expect(lifted.naturalPerson.about).toBe('np-about');
    expect(lifted.naturalPerson.publicProfile).toEqual({ enabled: true });

    expect(lifted.persona.pictureUrl).toBe('https://p.example/p.jpg');
    expect(lifted.persona.publicProfile).toEqual({ enabled: false });

    expect(lifted.professionalPersona?.nip05).toBe('dr@example.com');
    expect(lifted.professionalPersona?.publicProfile).toEqual({ enabled: true });

    expect(lifted.extraPersonas?.[0].lud16).toBe('gaming@wallet.example');
    expect(lifted.extraPersonas?.[0].publicProfile).toEqual({ enabled: true });

    expect(lifted.extraPersonas?.[1].website).toBe('https://school.example');
    expect(lifted.extraPersonas?.[1].publicProfile).toEqual({ enabled: false });
  });

  it('legacy publicProfile.name with undefined slot.displayName → lifts to slot.displayName', () => {
    // Pass-4 tightened the check from !slot.displayName to
    // slot.displayName === undefined so an intentionally-empty value is
    // preserved. Lift still fires when displayName is absent entirely.
    const id = makeIdentity({
      naturalPerson: {
        publicKey: NP_PK,
        privateKey: NP_SK,
        // displayName intentionally omitted
        publicProfile: { enabled: true, name: 'Lifted From Legacy' } as never,
      } as never,
    });
    const lifted = liftPublicProfileConfig(id);
    expect(lifted.naturalPerson.displayName).toBe('Lifted From Legacy');
  });

  it('legacy publicProfile.name with empty slot.displayName → preserved as empty (audit-4)', () => {
    const id = makeIdentity({
      naturalPerson: {
        publicKey: NP_PK,
        privateKey: NP_SK,
        displayName: '', // intentionally empty
        publicProfile: { enabled: true, name: 'Should Not Win' } as never,
      },
    });
    const lifted = liftPublicProfileConfig(id);
    expect(lifted.naturalPerson.displayName).toBe('');
  });

  it('legacy publicProfile.name with populated slot.displayName → slot value wins; legacy `name` discarded', () => {
    const id = makeIdentity({
      naturalPerson: {
        publicKey: NP_PK,
        privateKey: NP_SK,
        displayName: 'Alex',
        publicProfile: { enabled: true, name: 'Old Name' } as never,
      },
    });
    const lifted = liftPublicProfileConfig(id);
    expect(lifted.naturalPerson.displayName).toBe('Alex');
    expect((lifted.naturalPerson.publicProfile as unknown as Record<string, unknown>).name).toBeUndefined();
  });

  it('legacy publicProfile.displayName preferred over .name when both present', () => {
    const id = makeIdentity({
      naturalPerson: {
        publicKey: NP_PK,
        privateKey: NP_SK,
        // displayName intentionally omitted so lift fires (pass-4 semantics)
        publicProfile: { enabled: true, name: 'short', displayName: 'Long Display' } as never,
      } as never,
    });
    const lifted = liftPublicProfileConfig(id);
    expect(lifted.naturalPerson.displayName).toBe('Long Display');
  });

  it('does not mutate the input identity', () => {
    const id = makeIdentity({
      naturalPerson: {
        publicKey: NP_PK,
        privateKey: NP_SK,
        displayName: 'Alex',
        publicProfile: { enabled: true, about: 'orig' } as never,
      },
    });
    const snapshot = JSON.parse(JSON.stringify(id));
    liftPublicProfileConfig(id);
    expect(id).toEqual(snapshot);
  });
});

describe('liftDependantPublicProfileConfig', () => {
  it('lifts NP + persona + extras on a dependant', () => {
    const dep = makeDependant({
      naturalPerson: {
        publicKey: NP_PK,
        privateKey: NP_SK,
        displayName: 'Kid',
        publicProfile: { ...FULL_LEGACY } as never,
      },
      persona: {
        publicKey: PERSONA_PK,
        privateKey: PERSONA_SK,
        displayName: 'Kid (anonymous)',
        publicProfile: { enabled: false, about: 'persona-about' } as never,
      },
      extraPersonas: [
        makeExtra({
          publicKey: EXTRA_PK_1,
          privateKey: EXTRA_SK_1,
          displayName: 'School Account',
          publicProfile: { enabled: true, nip05: 'kid@school.example' } as never,
        }),
      ],
    });

    const lifted = liftDependantPublicProfileConfig(dep);

    expect(lifted.naturalPerson.about).toBe('I do stuff.');
    expect(lifted.naturalPerson.pictureUrl).toBe('https://example.com/p.jpg');
    expect(lifted.naturalPerson.nip05).toBe('alex@example.com');
    expect(lifted.naturalPerson.publicProfile).toEqual({
      enabled: true,
      lastEventId: 'cc'.repeat(32),
      lastPublishedAt: 1_700_000_001,
      lastPublishedRelay: 'wss://relay.example',
    });

    expect(lifted.persona.about).toBe('persona-about');
    expect(lifted.persona.publicProfile).toEqual({ enabled: false });

    expect(lifted.extraPersonas?.[0].nip05).toBe('kid@school.example');
    expect(lifted.extraPersonas?.[0].publicProfile).toEqual({ enabled: true });
  });

  it('is idempotent on dependants — second call returns same reference', () => {
    const dep = makeDependant({
      naturalPerson: {
        publicKey: NP_PK,
        privateKey: NP_SK,
        displayName: 'Kid',
        about: 'already-lifted',
        publicProfile: { enabled: true },
      },
    });
    const once = liftDependantPublicProfileConfig(dep);
    const twice = liftDependantPublicProfileConfig(once);
    expect(twice).toBe(once);
  });

  it('returns original (same reference) when no legacy fields on any slot', () => {
    const dep = makeDependant();
    expect(liftDependantPublicProfileConfig(dep)).toBe(dep);
  });

  it('legacy name lifts to displayName on a dep NP only when undefined (audit-4)', () => {
    // Empty string is an intentional value — should NOT trigger lift.
    // Matches the CONFIG_KEYS loop's `slot[k] === undefined` semantics so
    // displayName behaves consistently with the other 8 config fields.
    const depEmpty = makeDependant({
      naturalPerson: {
        publicKey: NP_PK,
        privateKey: NP_SK,
        displayName: '',
        publicProfile: { enabled: true, name: 'Dep Lifted' } as never,
      },
    });
    const liftedEmpty = liftDependantPublicProfileConfig(depEmpty);
    expect(liftedEmpty.naturalPerson.displayName).toBe('');

    // Undefined: lift fires.
    const depMissing = makeDependant({
      naturalPerson: {
        publicKey: NP_PK,
        privateKey: NP_SK,
        // displayName intentionally omitted
        publicProfile: { enabled: true, name: 'Dep Lifted' } as never,
      } as never,
    });
    const liftedMissing = liftDependantPublicProfileConfig(depMissing);
    expect(liftedMissing.naturalPerson.displayName).toBe('Dep Lifted');
  });

  it('does not mutate the input dependant', () => {
    const dep = makeDependant({
      naturalPerson: {
        publicKey: NP_PK,
        privateKey: NP_SK,
        displayName: 'Kid',
        publicProfile: { enabled: true, about: 'orig' } as never,
      },
    });
    const snapshot = JSON.parse(JSON.stringify(dep));
    liftDependantPublicProfileConfig(dep);
    expect(dep).toEqual(snapshot);
  });
});
