import { describe, it, expect } from 'vitest';
import { buildDeviceWipeInventory, describeTakedown, type DeviceWipeInput } from './device-wipe';
import type { DependantIdentity, ExtraPersona, SignetIdentity } from '../types';

const K = 'k'.repeat(64);

function slot(over: Record<string, unknown> = {}) {
  return { publicKey: 'p'.repeat(64), privateKey: '', displayName: '', ...over };
}

function ident(over: Record<string, unknown> = {}): SignetIdentity {
  return {
    id: 'a'.repeat(64),
    mnemonic: 'abandon abandon',
    naturalPerson: slot(),
    persona: slot(),
    primaryKeypair: 'persona',
    ...over,
  } as unknown as SignetIdentity;
}

function extra(over: Partial<ExtraPersona> = {}): ExtraPersona {
  return { publicKey: 'e'.repeat(64), privateKey: K, displayName: 'Extra', derivationName: 'persona-2', ...over } as ExtraPersona;
}

function dep(over: Record<string, unknown> = {}): DependantIdentity {
  return {
    id: 'd1',
    displayName: 'Kid',
    derivationPath: 'dependant-0',
    naturalPerson: slot(),
    persona: slot(),
    ...over,
  } as unknown as DependantIdentity;
}

function build(over: Partial<DeviceWipeInput> = {}) {
  return buildDeviceWipeInventory({
    identity: ident(),
    dependants: [],
    signingMode: 'local',
    hasOperatorKey: false,
    activeGrantCount: 0,
    childDirect: false,
    ...over,
  });
}

const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe('phoneOnly', () => {
  it('lists recovery words for a local mnemonic identity', () => {
    expect(build().phoneOnly).toEqual([{ id: 'recovery-words', label: 'Your recovery words' }]);
  });

  it('lists an nsec-imported identity (no mnemonic, a local key)', () => {
    const inv = build({ identity: ident({ mnemonic: '', persona: slot({ privateKey: K }) }) });
    expect(inv.phoneOnly.map((i) => i.label)).toEqual(["Your Signet's key (imported nsec)"]);
  });

  it('lists nothing for an empty-mnemonic identity that holds no key', () => {
    expect(build({ identity: ident({ mnemonic: '' }) }).phoneOnly).toEqual([]);
  });

  it('does not list recovery words or the nsec in bunker, nip07 or paired-child mode', () => {
    for (const signingMode of ['bunker', 'nip07', 'paired-child'] as const) {
      expect(build({ signingMode }).phoneOnly).toEqual([]);
      expect(build({ signingMode, identity: ident({ mnemonic: '', persona: slot({ privateKey: K }) }) }).phoneOnly).toEqual([]);
    }
  });

  it('lists imported extras with a key, by either marker, and skips derived or keyless ones', () => {
    const inv = build({
      identity: ident({
        extraPersonas: [
          extra({ publicKey: '1'.repeat(64), displayName: 'Flagged', imported: true, derivationName: '' }),
          extra({ publicKey: '2'.repeat(64), displayName: 'NoName', derivationName: '' }),
          extra({ publicKey: '3'.repeat(64), displayName: 'Derived' }),
          extra({ publicKey: '4'.repeat(64), displayName: 'Stripped', imported: true, privateKey: '' }),
        ],
      }),
    });
    expect(inv.phoneOnly.slice(1).map((i) => i.label)).toEqual([
      '"Flagged" persona (imported nsec)',
      '"NoName" persona (imported nsec)',
    ]);
  });

  it('lists imported-with-keys dependants but not derived or view-only ones', () => {
    const inv = build({
      dependants: [
        dep({ id: 'a', displayName: 'Imp', derivationPath: 'imported-abc', persona: slot({ privateKey: K }) }),
        dep({ id: 'b', displayName: 'View', derivationPath: 'imported-view-abc' }),
        dep({ id: 'c', displayName: 'Derived', persona: slot({ privateKey: K }) }),
        dep({ id: 'd', displayName: 'NoKey', derivationPath: 'imported-xyz' }),
      ],
    });
    expect(inv.phoneOnly.slice(1).map((i) => i.label)).toEqual(['"Imp" (imported dependant)']);
  });

  it('sanitises and truncates names', () => {
    const long = 'x'.repeat(100);
    const inv = build({
      identity: ident({ extraPersonas: [extra({ displayName: `‮ev\u0000il${long}`, imported: true })] }),
    });
    const label = inv.phoneOnly[1].label;
    expect(label).not.toMatch(/[‮\u0000]/);
    expect(label).toBe(`"evil${'x'.repeat(36)}" persona (imported nsec)`);
  });

  it('falls back for an empty name', () => {
    const inv = build({ identity: ident({ extraPersonas: [extra({ displayName: '  ', imported: true })] }) });
    expect(inv.phoneOnly[1].label).toBe('"Unnamed" persona (imported nsec)');
  });
});

describe('recoverable', () => {
  it('is empty for a plain local identity', () => {
    expect(build().recoverable).toEqual([]);
  });

  it('lists Heartwood keys in bunker mode', () => {
    expect(ids(build({ signingMode: 'bunker' }).recoverable)).toEqual(['heartwood-keys']);
  });

  it('lists the operator key when held', () => {
    expect(ids(build({ hasOperatorKey: true }).recoverable)).toEqual(['heartwood-operator']);
  });

  it('lists the pairing on a paired-child install', () => {
    expect(ids(build({ signingMode: 'paired-child' }).recoverable)).toEqual(['child-pairing']);
  });

  it('lists the extension in nip07 mode', () => {
    expect(ids(build({ signingMode: 'nip07' }).recoverable)).toEqual(['extension-keys']);
  });

  it('combines bunker and operator', () => {
    expect(ids(build({ signingMode: 'bunker', hasOperatorKey: true }).recoverable)).toEqual(['heartwood-keys', 'heartwood-operator']);
  });
});

describe('takedown', () => {
  const published = { enabled: true, lastEventId: 'ev' };

  it('counts only published slots a local key can sign for, across identity and dependants', () => {
    const inv = build({
      identity: ident({
        naturalPerson: slot({ privateKey: K, publicProfile: published }),
        persona: slot({ privateKey: K, publicProfile: { enabled: true } }), // no lastEventId
        professionalPersona: slot({ privateKey: K, publicProfile: published }),
        extraPersonas: [extra({ publicProfile: published }), extra({ publicProfile: { enabled: false, lastEventId: 'x' } })],
      }),
      dependants: [dep({ persona: slot({ privateKey: K, publicProfile: published }), extraPersonas: [extra({ publicProfile: published })] })],
      activeGrantCount: 3,
    });
    expect(inv.takedown).toEqual({ profiles: 5, appGrants: 3 });
  });

  it('counts keyless slots only when a router can sign for them', () => {
    const identity = ident({ persona: slot({ publicProfile: published }) });
    expect(build({ identity }).takedown.profiles).toBe(0);
    expect(build({ identity, hasBunkerRouter: true }).takedown.profiles).toBe(1);
  });

  it('is zero on a direct child install', () => {
    const inv = build({
      identity: ident({ persona: slot({ privateKey: K, publicProfile: published }) }),
      activeGrantCount: 2,
      childDirect: true,
    });
    expect(inv.takedown).toEqual({ profiles: 0, appGrants: 0 });
  });

  it('is zero with no identity', () => {
    expect(build({ identity: null, activeGrantCount: 2 }).takedown).toEqual({ profiles: 0, appGrants: 0 });
  });
});

describe('describeTakedown', () => {
  it('handles singular, plural and zero parts', () => {
    expect(describeTakedown({ profiles: 2, appGrants: 1 })).toBe('2 public profiles will be blanked · 1 connected app loses access');
    expect(describeTakedown({ profiles: 1, appGrants: 0 })).toBe('1 public profile will be blanked');
    expect(describeTakedown({ profiles: 0, appGrants: 3 })).toBe('3 connected apps lose access');
    expect(describeTakedown({ profiles: 0, appGrants: 0 })).toBe('');
  });
});
