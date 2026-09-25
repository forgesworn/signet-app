import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the relay transport so publish/fetch resolve without a live relay —
// same vi.hoisted per-URL pattern as personas-sync.test.ts.
const relayMock = vi.hoisted(() => ({
  fetchReturns: {} as Record<string, Array<{ id: string; created_at: number; content: string }>>,
  fetchThrows: new Set<string>(),
  fetchFailUrls: new Set<string>(),
  published: [] as Array<{ url: string; id: string }>,
  publishOk: {} as Record<string, boolean>,
}));
vi.mock('signet-protocol', async () => {
  const actual = await vi.importActual<typeof import('signet-protocol')>('signet-protocol');
  return {
    ...actual,
    RelayClient: class MockRelayClient {
      url: string;
      constructor(url: string) { this.url = url; }
      async connect(): Promise<void> {
        if (relayMock.fetchThrows.has(this.url)) throw new Error('connect failed');
      }
      // The pool fetch pins events to the requested author (sync-relays.ts)
      // — real relay events always carry `pubkey`, so default each seeded
      // event to the author the filter asked for unless a test sets one
      // explicitly (the foreign-author cases do).
      async fetch(filters: Array<{ authors?: string[] }>): Promise<Array<{ id: string; created_at: number; content: string; pubkey?: string }>> {
        if (relayMock.fetchFailUrls.has(this.url)) throw new Error('fetch failed');
        const author = filters?.[0]?.authors?.[0];
        return (relayMock.fetchReturns[this.url] ?? []).map((e) => ({ pubkey: author, ...e }));
      }
      async publish(ev: { id: string }): Promise<{ ok: boolean }> {
        relayMock.published.push({ url: this.url, id: ev.id });
        return { ok: relayMock.publishOk[this.url] ?? true };
      }
      disconnect(): void {}
    },
  };
});

beforeEach(() => {
  relayMock.fetchReturns = {};
  relayMock.fetchThrows = new Set();
  relayMock.fetchFailUrls = new Set();
  relayMock.published = [];
  relayMock.publishOk = {};
});

import type { DependantIdentity, DependantBunkerEndpoint, TrustedAppEndpoint } from '../types';
import { toSyncWire, fromSyncWire, mergeDependantWithLocal, parsePayload, publishDependantsSync, fetchDependantsSync } from './dependants-sync';
import { isDependantNaturalPersonActive } from './identity-display';

// Standard all-zeros BIP-39 mnemonic — deterministic test fixture.
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// deriveDependantIdentity of the above mnemonic at derivationPath 'dependant-0'
// gives these stable pubkeys. Pre-computed and pinned.
const DEP0_NP_PUB = '0b768e3218d0a2834b5503c96dac13089de2ee7ca6a3c2b50b1b4dd1aa5a2f10';
const DEP0_PERSONA_PUB = '6a42a6fa76e8d45386870c9202cb99f3e67dee7aa55b2971c38386077258a59b';

function makeDerivedDep(overrides?: Partial<DependantIdentity>): DependantIdentity {
  return {
    id: DEP0_NP_PUB,
    guardianPubkey: 'f'.repeat(64),
    displayName: 'Child',
    naturalPerson: { publicKey: DEP0_NP_PUB, privateKey: 'a'.repeat(64), displayName: 'Child' },
    persona: { publicKey: DEP0_PERSONA_PUB, privateKey: 'b'.repeat(64), displayName: 'Child (anon)' },
    derivationPath: 'dependant-0',
    createdAt: 1000,
    autonomyStage: 'full-control',
    primaryKeypair: 'natural-person',
    ...overrides,
  };
}

function makeViewOnlyDep(pubkey: string = 'c'.repeat(64)): DependantIdentity {
  return {
    id: pubkey,
    guardianPubkey: 'f'.repeat(64),
    displayName: 'View-Only Kid',
    naturalPerson: { publicKey: pubkey, privateKey: '', displayName: 'View-Only Kid' },
    persona: { publicKey: '', privateKey: '', displayName: '' },
    derivationPath: 'imported-view-' + pubkey.slice(0, 8),
    createdAt: 1000,
    autonomyStage: 'full-autonomy',
    primaryKeypair: 'natural-person',
  };
}

function makePrivateImportDep(pubkey: string = 'd'.repeat(64)): DependantIdentity {
  return {
    id: pubkey,
    guardianPubkey: 'f'.repeat(64),
    displayName: 'Imported',
    naturalPerson: { publicKey: pubkey, privateKey: 'e'.repeat(64), displayName: 'Imported' },
    persona: { publicKey: 'f'.repeat(64), privateKey: 'a'.repeat(64), displayName: 'Imported persona' },
    derivationPath: 'imported-' + pubkey.slice(0, 8),
    createdAt: 1000,
    autonomyStage: 'request-approve',
    primaryKeypair: 'natural-person',
  };
}

describe('toSyncWire', () => {
  it('serialises a derived dependant, stripping private keys', () => {
    const dep = makeDerivedDep();
    const wire = toSyncWire(dep);
    expect(wire).not.toBeNull();
    expect(wire!.derivationPath).toBe('dependant-0');
    expect(wire!.np.publicKey).toBe(DEP0_NP_PUB);
    expect(wire!.persona.publicKey).toBe(DEP0_PERSONA_PUB);
    // Private-key smoke-test: the wire shape has no privateKey field anywhere
    expect(JSON.stringify(wire)).not.toMatch(/privateKey/);
    // No mnemonic either
    expect(JSON.stringify(wire)).not.toMatch(/abandon/);
  });

  it('flags view-only imports', () => {
    const wire = toSyncWire(makeViewOnlyDep());
    expect(wire).not.toBeNull();
    expect(wire!.viewOnly).toBe(true);
  });

  it('skips imported-with-mnemonic dependants (returns null)', () => {
    expect(toSyncWire(makePrivateImportDep())).toBeNull();
  });

  it('preserves optional fields (DOB, extras)', () => {
    const dep = makeDerivedDep({
      dateOfBirth: '2015-03-14',
      extraPersonas: [{
        publicKey: 'e'.repeat(64),
        privateKey: 'f'.repeat(64),
        displayName: 'Alt',
        derivationName: 'dependant-0-persona-1',
        lastNameCredentialId: 'a'.repeat(64),
      }],
    });
    const wire = toSyncWire(dep)!;
    expect(wire.dateOfBirth).toBe('2015-03-14');
    expect(wire.extras).toHaveLength(1);
    expect(wire.extras![0].derivationName).toBe('dependant-0-persona-1');
    expect(wire.extras![0].lastNameCredentialId).toBe('a'.repeat(64));
    // Extras also strip privateKey
    expect(JSON.stringify(wire.extras)).not.toMatch(/privateKey/);
  });

  it('serialises defaultSchedule onto the wire (Charter clause #1, phase 3)', () => {
    const dep = makeDerivedDep({
      defaultSchedule: {
        v: 1,
        tz: 'Europe/London',
        weekly: { fri: [{ start: '16:00', end: '20:00' }] },
        issuedAt: 500,
      },
    });
    const wire = toSyncWire(dep)!;
    expect(wire.defaultSchedule).toBeDefined();
    expect(wire.defaultSchedule!.issuedAt).toBe(500);
    expect(wire.defaultSchedule!.tz).toBe('Europe/London');
  });

  it('omits defaultSchedule from the wire when not set on the dep', () => {
    const wire = toSyncWire(makeDerivedDep())!;
    expect(wire.defaultSchedule).toBeUndefined();
  });
});

describe('parsePayload — the real fetch path', () => {
  it('preserves defaultSchedule through parsePayload → fromSyncWire', () => {
    const dep = makeDerivedDep({
      defaultSchedule: {
        v: 1,
        tz: 'Europe/London',
        weekly: { fri: [{ start: '16:00', end: '20:00' }] },
        issuedAt: 500,
      },
    });
    const payload = JSON.stringify({ v: 1, dependants: [toSyncWire(dep)] });
    const parsed = parsePayload(payload);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(1);
    expect(parsed![0].defaultSchedule).toBeDefined();
    expect(parsed![0].defaultSchedule!.issuedAt).toBe(500);
    expect(parsed![0].defaultSchedule!.tz).toBe('Europe/London');
    const reconstructed = fromSyncWire(parsed![0], TEST_MNEMONIC)!;
    expect(reconstructed.defaultSchedule).toBeDefined();
    expect(reconstructed.defaultSchedule!.weekly.fri).toEqual([{ start: '16:00', end: '20:00' }]);
  });

  it('drops a malformed defaultSchedule at the parsePayload boundary', () => {
    const wire = toSyncWire(makeDerivedDep())!;
    const raw = JSON.parse(JSON.stringify({ v: 1, dependants: [wire] })) as {
      v: number; dependants: Record<string, unknown>[];
    };
    raw.dependants[0].defaultSchedule = { totally: 'bogus' };
    const parsed = parsePayload(JSON.stringify(raw));
    expect(parsed).not.toBeNull();
    expect(parsed![0].defaultSchedule).toBeUndefined();
  });
});

describe('fromSyncWire — derived dependants', () => {
  it('re-derives private keys from guardian mnemonic', () => {
    const wire = toSyncWire(makeDerivedDep())!;
    const reconstructed = fromSyncWire(wire, TEST_MNEMONIC);
    expect(reconstructed).not.toBeNull();
    expect(reconstructed!.naturalPerson.publicKey).toBe(DEP0_NP_PUB);
    expect(reconstructed!.naturalPerson.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(reconstructed!.persona.publicKey).toBe(DEP0_PERSONA_PUB);
    expect(reconstructed!.persona.privateKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects wires whose pubkeys do not match the re-derivation (tamper / wrong mnemonic)', () => {
    const wire = toSyncWire(makeDerivedDep())!;
    // Swap the claimed NP pubkey to a value that won't match re-derivation.
    wire.np = { ...wire.np, publicKey: 'z'.repeat(64) };
    const bad = fromSyncWire(wire, TEST_MNEMONIC);
    expect(bad).toBeNull();
  });

  it('round-trips defaultSchedule via toSyncWire → fromSyncWire', () => {
    const dep = makeDerivedDep({
      defaultSchedule: {
        v: 1,
        tz: 'Europe/London',
        weekly: { fri: [{ start: '16:00', end: '20:00' }] },
        issuedAt: 500,
      },
    });
    const wire = toSyncWire(dep)!;
    const reconstructed = fromSyncWire(wire, TEST_MNEMONIC)!;
    expect(reconstructed.defaultSchedule).toBeDefined();
    expect(reconstructed.defaultSchedule!.issuedAt).toBe(500);
    expect(reconstructed.defaultSchedule!.weekly.fri).toEqual([{ start: '16:00', end: '20:00' }]);
  });

  it('drops malformed defaultSchedule on receive (defence-in-depth)', () => {
    const wire = toSyncWire(makeDerivedDep())!;
    // Inject a malformed schedule directly onto the wire (simulates a
    // rogue or buggy peer). parseScheduleField should reject it; the
    // rest of the dep record should still reconstruct.
    (wire as unknown as Record<string, unknown>).defaultSchedule = {
      v: 1,
      tz: 'Atlantis/Lost', // invalid IANA
      weekly: {},
      issuedAt: 500,
    };
    const reconstructed = fromSyncWire(wire, TEST_MNEMONIC);
    expect(reconstructed).not.toBeNull();
    expect(reconstructed!.defaultSchedule).toBeUndefined();
  });
});

describe('fromSyncWire — view-only imports', () => {
  it('reconstructs with empty private keys', () => {
    const wire = toSyncWire(makeViewOnlyDep())!;
    const reconstructed = fromSyncWire(wire, TEST_MNEMONIC);
    expect(reconstructed).not.toBeNull();
    expect(reconstructed!.naturalPerson.privateKey).toBe('');
    expect(reconstructed!.persona.privateKey).toBe('');
  });
});

describe('mergeDependantWithLocal', () => {
  function makeLocalEndpoint(): DependantBunkerEndpoint {
    return {
      publicKey: '1'.repeat(64),
      privateKey: '2'.repeat(64),
      createdAt: 9999,
      authorizedClientPubkey: '3'.repeat(64),
    };
  }

  function makeAppEndpoint(): TrustedAppEndpoint {
    return {
      publicKey: '4'.repeat(64),
      privateKey: '5'.repeat(64),
      createdAt: 8888,
      pairings: [{
        clientPubkey: '6'.repeat(64),
        label: 'Fathom',
        pairedAt: 7777,
      }],
    };
  }

  it('returns remote unchanged when local is null (new dependant from sync)', () => {
    const remote = makeDerivedDep();
    expect(mergeDependantWithLocal(remote, null)).toBe(remote);
  });

  it('preserves local extras when remote has none (regression)', () => {
    const local = makeDerivedDep({
      extraPersonas: [{
        publicKey: 'a'.repeat(64),
        privateKey: 'b'.repeat(64),
        displayName: 'BenGamer1',
        derivationName: 'dependant-0-persona-1',
      }],
    });
    const remote = makeDerivedDep(); // no extras — stale wire from before persona was added
    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.extraPersonas).toHaveLength(1);
    expect(merged.extraPersonas![0].publicKey).toBe('a'.repeat(64));
  });

  it('unions extras by publicKey when both sides have entries', () => {
    const local = makeDerivedDep({
      extraPersonas: [{
        publicKey: 'a'.repeat(64),
        privateKey: 'b'.repeat(64),
        displayName: 'LocalOnly',
        derivationName: 'dependant-0-persona-1',
      }],
    });
    const remote = makeDerivedDep({
      extraPersonas: [{
        publicKey: 'c'.repeat(64),
        privateKey: 'd'.repeat(64),
        displayName: 'RemoteOnly',
        derivationName: 'dependant-0-persona-2',
      }],
    });
    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.extraPersonas).toHaveLength(2);
    const keys = merged.extraPersonas!.map(e => e.publicKey).sort();
    expect(keys).toEqual(['a'.repeat(64), 'c'.repeat(64)]);
  });

  it('prefers remote metadata for an extra that exists on both sides', () => {
    const shared = 'a'.repeat(64);
    const local = makeDerivedDep({
      extraPersonas: [{
        publicKey: shared,
        privateKey: 'local-priv',
        displayName: 'OldName',
        derivationName: 'dependant-0-persona-1',
      }],
    });
    const remote = makeDerivedDep({
      extraPersonas: [{
        publicKey: shared,
        privateKey: 'remote-priv',
        displayName: 'NewName',
        derivationName: 'dependant-0-persona-1',
      }],
    });
    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.extraPersonas).toHaveLength(1);
    expect(merged.extraPersonas![0].displayName).toBe('NewName');
    expect(merged.extraPersonas![0].privateKey).toBe('remote-priv');
  });

  it('falls back to local privateKey when remote re-derivation produced an empty one', () => {
    const shared = 'a'.repeat(64);
    const local = makeDerivedDep({
      extraPersonas: [{
        publicKey: shared,
        privateKey: 'local-priv',
        displayName: 'LocalName',
        derivationName: 'dependant-0-persona-1',
      }],
    });
    const remote = makeDerivedDep({
      extraPersonas: [{
        publicKey: shared,
        privateKey: '', // re-derivation lost it (e.g. view-only path)
        displayName: 'RemoteName',
        derivationName: 'dependant-0-persona-1',
      }],
    });
    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.extraPersonas![0].privateKey).toBe('local-priv');
    expect(merged.extraPersonas![0].displayName).toBe('RemoteName');
  });

  it('preserves local bunkerEndpoint (per-device, never synced)', () => {
    const endpoint = makeLocalEndpoint();
    const local = makeDerivedDep({ bunkerEndpoint: endpoint });
    const remote = makeDerivedDep(); // wire never carries bunkerEndpoint
    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.bunkerEndpoint).toEqual(endpoint);
  });

  it('preserves local appBunkerEndpoint (per-device trusted-app pairings, never synced)', () => {
    const endpoint = makeAppEndpoint();
    const local = makeDerivedDep({ appBunkerEndpoint: endpoint });
    const remote = makeDerivedDep();
    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.appBunkerEndpoint).toEqual(endpoint);
  });

  it('preserves local auditVisibility override (not in wire schema)', () => {
    const local = makeDerivedDep({ auditVisibility: 'force-visible' });
    const remote = makeDerivedDep();
    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.auditVisibility).toBe('force-visible');
  });

  it('preserves local petitionOnDeny opt-in (device-local, like auditVisibility)', () => {
    const local = makeDerivedDep({ petitionOnDeny: true });
    const remote = makeDerivedDep();
    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.petitionOnDeny).toBe(true);
  });

  it('preserves local photo metadata (device-local, never synced)', () => {
    const local = makeDerivedDep({
      photoHash: 'aa'.repeat(32),
      blossomUrl: 'https://blossom.example.com',
      photoKey: 'bb'.repeat(32),
      photoUpdatedAt: 4242,
    });
    const remote = makeDerivedDep(); // wire never carries photo fields
    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.photoHash).toBe('aa'.repeat(32));
    expect(merged.blossomUrl).toBe('https://blossom.example.com');
    expect(merged.photoKey).toBe('bb'.repeat(32));
    expect(merged.photoUpdatedAt).toBe(4242);
  });

  it('does not propagate photo fields from remote (a buggy peer that smuggled them in)', () => {
    // Local has nothing; remote (buggy) has photo metadata. The merge must
    // strip them so a stale or rogue device can't overwrite this device's
    // photo posture (each device captures its own).
    const local = makeDerivedDep();
    const remote = makeDerivedDep({
      photoHash: 'aa'.repeat(32),
      blossomUrl: 'https://blossom.example.com',
      photoKey: 'bb'.repeat(32),
      photoUpdatedAt: 4242,
    });
    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.photoHash).toBeUndefined();
    expect(merged.blossomUrl).toBeUndefined();
    expect(merged.photoKey).toBeUndefined();
    expect(merged.photoUpdatedAt).toBeUndefined();
  });

  it('preserves local defaultSchedule when remote has none', () => {
    const local = makeDerivedDep({
      defaultSchedule: {
        v: 1,
        tz: 'Europe/London',
        weekly: { fri: [{ start: '16:00', end: '20:00' }] },
        issuedAt: 500,
      },
    });
    const remote = makeDerivedDep();
    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.defaultSchedule).toBeDefined();
    expect(merged.defaultSchedule!.issuedAt).toBe(500);
  });

  it('takes remote defaultSchedule when its issuedAt is newer (LWW)', () => {
    const local = makeDerivedDep({
      defaultSchedule: { v: 1, tz: 'Europe/London', weekly: {}, issuedAt: 100 },
    });
    const remote = makeDerivedDep({
      defaultSchedule: { v: 1, tz: 'Europe/London', weekly: { fri: [{ start: '14:00', end: '18:00' }] }, issuedAt: 500 },
    });
    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.defaultSchedule!.issuedAt).toBe(500);
    expect(merged.defaultSchedule!.weekly.fri).toEqual([{ start: '14:00', end: '18:00' }]);
  });

  it('keeps local defaultSchedule when its issuedAt is newer', () => {
    const local = makeDerivedDep({
      defaultSchedule: { v: 1, tz: 'Europe/London', weekly: { fri: [{ start: '16:00', end: '20:00' }] }, issuedAt: 500 },
    });
    const remote = makeDerivedDep({
      defaultSchedule: { v: 1, tz: 'Europe/London', weekly: {}, issuedAt: 100 },
    });
    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.defaultSchedule!.issuedAt).toBe(500);
  });

  it('remote breaks ties on equal issuedAt', () => {
    const local = makeDerivedDep({
      defaultSchedule: { v: 1, tz: 'Europe/London', weekly: { fri: [{ start: '16:00', end: '18:00' }] }, issuedAt: 500 },
    });
    const remote = makeDerivedDep({
      defaultSchedule: { v: 1, tz: 'Europe/London', weekly: { fri: [{ start: '14:00', end: '18:00' }] }, issuedAt: 500 },
    });
    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.defaultSchedule!.weekly.fri![0].start).toBe('14:00');
  });

  it('preserves device-local slot avatar + extras hidden/imported flags (audit-4)', () => {
    // The bug: avatarHash/avatarBlossomUrl/avatarKey/avatarUpdatedAt are
    // per-device encrypted-Blossom mirrors — must NEVER propagate
    // cross-device. `hidden` and `imported` are ExtraPersona device-local
    // flags. preserveLocalSlotState previously omitted all six fields,
    // so every sync clobbered them to undefined.
    const sharedExtraKey = '7'.repeat(64);
    const local = makeDerivedDep({
      naturalPerson: {
        publicKey: DEP0_NP_PUB,
        privateKey: 'a'.repeat(64),
        displayName: 'Child',
        avatarHash: 'aa'.repeat(32),
        avatarBlossomUrl: 'https://blossom.example/aa',
        avatarKey: 'bb'.repeat(32),
        avatarUpdatedAt: 4242,
      },
      extraPersonas: [{
        publicKey: sharedExtraKey,
        privateKey: 'e'.repeat(64),
        displayName: 'BenGamer1',
        derivationName: 'dependant-0-persona-1',
        hidden: true,
        imported: true,
        avatarHash: 'cc'.repeat(32),
      }],
    });
    const remote = makeDerivedDep({
      naturalPerson: {
        publicKey: DEP0_NP_PUB,
        privateKey: 'a'.repeat(64),
        displayName: 'Child',
        // remote omits all avatar fields — wire never carries them.
      },
      extraPersonas: [{
        publicKey: sharedExtraKey,
        privateKey: 'e'.repeat(64),
        displayName: 'BenGamer1',
        derivationName: 'dependant-0-persona-1',
        // remote omits hidden/imported/avatar fields.
      }],
    });
    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.naturalPerson.avatarHash).toBe('aa'.repeat(32));
    expect(merged.naturalPerson.avatarBlossomUrl).toBe('https://blossom.example/aa');
    expect(merged.naturalPerson.avatarKey).toBe('bb'.repeat(32));
    expect(merged.naturalPerson.avatarUpdatedAt).toBe(4242);
    expect(merged.extraPersonas).toHaveLength(1);
    expect(merged.extraPersonas![0].hidden).toBe(true);
    expect(merged.extraPersonas![0].imported).toBe(true);
    expect(merged.extraPersonas![0].avatarHash).toBe('cc'.repeat(32));
  });

  it('preserves local nip05CheckResult/nip05CheckedAt across sync (device-local, never synced)', () => {
    const sharedExtraKey = '8'.repeat(64);
    const local = makeDerivedDep({
      naturalPerson: {
        publicKey: DEP0_NP_PUB,
        privateKey: 'a'.repeat(64),
        displayName: 'Child',
        nip05: 'child@example.com',
        nip05CheckResult: 'match',
        nip05CheckedAt: 1_700_000_000_000,
      },
      extraPersonas: [{
        publicKey: sharedExtraKey,
        privateKey: 'e'.repeat(64),
        displayName: 'BenGamer1',
        derivationName: 'dependant-0-persona-1',
        nip05: 'ben@example.com',
        nip05CheckResult: 'unreachable',
        nip05CheckedAt: 1_700_000_001_000,
      }],
    });
    const remote = makeDerivedDep({
      naturalPerson: {
        publicKey: DEP0_NP_PUB,
        privateKey: 'a'.repeat(64),
        displayName: 'Child',
        // remote (wire) never carries the check fields.
      },
      extraPersonas: [{
        publicKey: sharedExtraKey,
        privateKey: 'e'.repeat(64),
        displayName: 'BenGamer1',
        derivationName: 'dependant-0-persona-1',
      }],
    });
    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.naturalPerson.nip05CheckResult).toBe('match');
    expect(merged.naturalPerson.nip05CheckedAt).toBe(1_700_000_000_000);
    expect(merged.extraPersonas![0].nip05CheckResult).toBe('unreachable');
    expect(merged.extraPersonas![0].nip05CheckedAt).toBe(1_700_000_001_000);
  });

  it('takes wire-eligible fields from remote (displayName, autonomyStage)', () => {
    const local = makeDerivedDep({ displayName: 'OldName', autonomyStage: 'full-control' });
    const remote = makeDerivedDep({ displayName: 'NewName', autonomyStage: 'request-approve' });
    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.displayName).toBe('NewName');
    expect(merged.autonomyStage).toBe('request-approve');
  });

  it('preserves local NP slot publicProfile state + kind-0 config across sync round-trip (security audit 2026-05-18)', () => {
    // The bug: a freshly-fetched wire entry lacks `publicProfile` + the 8
    // kind-0 config fields. Naive `...remote` overlay clobbers local
    // state, breaking the §5.1.3 atomicity contract (`enabled`/
    // `lastEventId`/`lastPublishedAt`/`lastPublishedRelay` move together).
    const local = makeDerivedDep({
      naturalPerson: {
        publicKey: DEP0_NP_PUB,
        privateKey: 'a'.repeat(64),
        displayName: 'Child',
        about: 'local about',
        pictureUrl: 'https://example.com/p.png',
        nip05: 'child@example.com',
        publicProfile: {
          enabled: true,
          lastEventId: 'a'.repeat(64),
          lastPublishedAt: 1000,
          lastPublishedRelay: 'wss://relay.example.com',
          lastPublishedContentHash: 'b'.repeat(64),
        },
      },
    });
    // Simulate the full round-trip: wire never carries these fields.
    const wire = toSyncWire(local)!;
    const reconstructed = fromSyncWire(wire, TEST_MNEMONIC)!;
    // Sanity: wire stripped them.
    expect(reconstructed.naturalPerson.publicProfile).toBeUndefined();
    expect(reconstructed.naturalPerson.about).toBeUndefined();
    expect(reconstructed.naturalPerson.pictureUrl).toBeUndefined();
    expect(reconstructed.naturalPerson.nip05).toBeUndefined();

    const merged = mergeDependantWithLocal(reconstructed, local);
    expect(merged.naturalPerson.publicProfile).toBeDefined();
    expect(merged.naturalPerson.publicProfile!.enabled).toBe(true);
    expect(merged.naturalPerson.publicProfile!.lastEventId).toBe('a'.repeat(64));
    expect(merged.naturalPerson.publicProfile!.lastPublishedAt).toBe(1000);
    expect(merged.naturalPerson.publicProfile!.lastPublishedRelay).toBe('wss://relay.example.com');
    expect(merged.naturalPerson.about).toBe('local about');
    expect(merged.naturalPerson.pictureUrl).toBe('https://example.com/p.png');
    expect(merged.naturalPerson.nip05).toBe('child@example.com');
  });

  it('preserves local Persona slot publicProfile + kind-0 config (security audit 2026-05-18)', () => {
    const local = makeDerivedDep({
      persona: {
        publicKey: DEP0_PERSONA_PUB,
        privateKey: 'b'.repeat(64),
        displayName: 'Child (anon)',
        about: 'persona about',
        publicProfile: { enabled: true, lastEventId: 'c'.repeat(64), lastPublishedAt: 2000 },
      },
    });
    const wire = toSyncWire(local)!;
    const reconstructed = fromSyncWire(wire, TEST_MNEMONIC)!;
    const merged = mergeDependantWithLocal(reconstructed, local);
    expect(merged.persona.publicProfile?.enabled).toBe(true);
    expect(merged.persona.publicProfile?.lastEventId).toBe('c'.repeat(64));
    expect(merged.persona.about).toBe('persona about');
  });

  it('preserves local extra-persona publicProfile + kind-0 config across union (security audit 2026-05-18)', () => {
    // Test the merge step directly (extras path). Simulates: local has
    // publicProfile/about/etc.; remote (reconstructed from wire) has the
    // same extra by publicKey but the wire-stripped (no publicProfile,
    // no about, no pictureUrl) shape.
    const sharedPub = 'a'.repeat(64);
    const local = makeDerivedDep({
      extraPersonas: [{
        publicKey: sharedPub,
        privateKey: 'b'.repeat(64),
        displayName: 'Alt',
        derivationName: 'dependant-0-persona-1',
        about: 'extra about',
        pictureUrl: 'https://example.com/x.png',
        publicProfile: { enabled: true, lastEventId: 'd'.repeat(64), lastPublishedAt: 3000 },
      }],
    });
    const remote = makeDerivedDep({
      extraPersonas: [{
        publicKey: sharedPub,
        privateKey: 'b'.repeat(64),
        displayName: 'Alt (renamed remote)',
        derivationName: 'dependant-0-persona-1',
        // wire stripped publicProfile + about + pictureUrl
      }],
    });
    const merged = mergeDependantWithLocal(remote, local);
    const extra = merged.extraPersonas!.find(e => e.publicKey === sharedPub)!;
    expect(extra.publicProfile?.enabled).toBe(true);
    expect(extra.publicProfile?.lastEventId).toBe('d'.repeat(64));
    expect(extra.about).toBe('extra about');
    expect(extra.pictureUrl).toBe('https://example.com/x.png');
    // Remote still wins on its own wire-eligible field
    expect(extra.displayName).toBe('Alt (renamed remote)');
  });

  it('never clobbers a locally-held NP/persona key with a keyless remote (family-bunker §11.1.8)', () => {
    // Regression: a keyless-derived remote (privateKey: '' on every slot,
    // family-bunker §11.1.8) can legitimately arrive on a device whose
    // local copy still holds real key material — e.g. the generic-bunker
    // connect path, where dependants stay local while `deviceHeldKeys`
    // also evaluates true. The merge must never let an empty remote key
    // overwrite a non-empty local one (mirrors unionExtras' existing
    // fallback for extras).
    const local = makeDerivedDep();
    const wire = toSyncWire(local)!;
    const remote = fromSyncWire(wire, '', { deviceHeldKeys: true })!;
    expect(remote.naturalPerson.privateKey).toBe('');
    expect(remote.persona.privateKey).toBe('');

    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.naturalPerson.privateKey).toBe(local.naturalPerson.privateKey);
    expect(merged.persona.privateKey).toBe(local.persona.privateKey);
  });

  it('still lets a keyed remote win over an empty local key (symmetry)', () => {
    const local = makeDerivedDep({
      naturalPerson: { publicKey: DEP0_NP_PUB, privateKey: '', displayName: 'Child' },
      persona: { publicKey: DEP0_PERSONA_PUB, privateKey: '', displayName: 'Child (anon)' },
    });
    const remote = makeDerivedDep(); // has real re-derived keys
    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.naturalPerson.privateKey).toBe(remote.naturalPerson.privateKey);
    expect(merged.persona.privateKey).toBe(remote.persona.privateKey);
  });
});

describe('fromSyncWire — unsyncable sources', () => {
  it('returns null for imported-with-mnemonic paths (already filtered in toSyncWire, but belt+braces)', () => {
    // Synthesise a wire record that claims to be imported-* (not -view-)
    const wire = {
      id: 'd'.repeat(64),
      guardianPubkey: 'f'.repeat(64),
      displayName: 'x',
      derivationPath: 'imported-deadbeef',
      autonomyStage: 'full-control' as const,
      primaryKeypair: 'natural-person',
      createdAt: 1,
      np: { publicKey: 'a'.repeat(64), displayName: 'x' },
      persona: { publicKey: 'b'.repeat(64), displayName: 'y' },
    };
    expect(fromSyncWire(wire, TEST_MNEMONIC)).toBeNull();
  });

  it('returns null for unknown derivation path shapes', () => {
    const wire = {
      id: 'a'.repeat(64),
      guardianPubkey: 'f'.repeat(64),
      displayName: 'x',
      derivationPath: 'not-a-recognised-shape',
      autonomyStage: 'full-control' as const,
      primaryKeypair: 'natural-person',
      createdAt: 1,
      np: { publicKey: 'a'.repeat(64), displayName: 'x' },
      persona: { publicKey: 'b'.repeat(64), displayName: 'y' },
    };
    expect(fromSyncWire(wire, TEST_MNEMONIC)).toBeNull();
  });
});

describe('fromSyncWire — keyless receiver (family-bunker §11.1.8)', () => {
  it('accepts a derived dependant keyless when the receiver holds no keys (deviceHeldKeys)', () => {
    const wire = toSyncWire(makeDerivedDep())!;
    const dep = fromSyncWire(wire, '', { deviceHeldKeys: true });
    expect(dep).not.toBeNull();
    expect(dep!.derivationPath).toBe('dependant-0');
    expect(dep!.naturalPerson).toMatchObject({ publicKey: wire.np.publicKey, privateKey: '' });
    expect(dep!.persona).toMatchObject({ publicKey: wire.persona.publicKey, privateKey: '' });
    for (const ep of dep!.extraPersonas ?? []) expect(ep.privateKey).toBe('');
  });
  it('still returns null for a derived dependant with no mnemonic and no deviceHeldKeys (unchanged)', () => {
    const wire = toSyncWire(makeDerivedDep())!;
    expect(fromSyncWire(wire, '')).toBeNull();
    expect(fromSyncWire(wire, '', { deviceHeldKeys: false })).toBeNull();
  });
  it('prefers re-derivation when a mnemonic IS available even if deviceHeldKeys is set', () => {
    const wire = toSyncWire(makeDerivedDep())!;
    const dep = fromSyncWire(wire, TEST_MNEMONIC, { deviceHeldKeys: true });
    expect(dep!.naturalPerson.privateKey).toMatch(/^[0-9a-f]{64}$/);
  });
});

/**
 * A fake NIP-44 v2 ciphertext: the version byte 2, then the plaintext,
 * space-padded to the 96-byte body a real v2 payload's floor implies, then
 * base64. `openVaultPayload` pre-filters the legacy fallback on exactly that
 * shape (S5). Trailing spaces are harmless: every rail parses its plaintext
 * with `JSON.parse`, which ignores trailing whitespace.
 */
function fakeNip44(plaintext: string): string {
  const body = new TextEncoder().encode(plaintext.padEnd(96, ' '));
  const bytes = new Uint8Array(1 + body.length);
  bytes[0] = 2;
  bytes.set(body, 1);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Reverse `fakeNip44`. Throws for anything that is not one, as a real signer would. */
function openFakeNip44(ciphertext: string): string {
  const bytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  if (bytes[0] !== 2) throw new Error('not our ciphertext');
  return new TextDecoder().decode(bytes.subarray(1));
}

function makeSyncBackend(overrides: Partial<{
  activePublicKeyHex: string;
  nip44Encrypt: ReturnType<typeof vi.fn>;
  nip44Decrypt: ReturnType<typeof vi.fn>;
  signEvent: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    activePublicKeyHex: 'a'.repeat(64),
    nip44Encrypt: vi.fn(async (_pub: string, plaintext: string) => fakeNip44(plaintext)),
    nip44Decrypt: vi.fn(async (_pub: string, ciphertext: string) => openFakeNip44(ciphertext)),
    signEvent: vi.fn(async (ev: Record<string, unknown>) => ({ ...ev, id: 'sig'.padEnd(64, '0'), sig: 's'.repeat(128) })),
    type: 'local',
    ...overrides,
  } as never;
}

describe('publishDependantsSync — relay pool', () => {
  it('returns true when one of two relays accepts the publish', async () => {
    relayMock.publishOk = { 'wss://a.example': false, 'wss://b.example': true };
    const backend = makeSyncBackend();
    const ok = await publishDependantsSync([makeDerivedDep()], backend, ['wss://a.example', 'wss://b.example']);
    expect(ok).toBe(true);
    expect(relayMock.published.map(p => p.url).sort()).toEqual(['wss://a.example', 'wss://b.example']);
  });

  it('accepts a plain string relayUrl (single-relay pool)', async () => {
    relayMock.publishOk = { 'wss://a.example': true };
    const backend = makeSyncBackend();
    const ok = await publishDependantsSync([makeDerivedDep()], backend, 'wss://a.example');
    expect(ok).toBe(true);
  });

  it('never publishes an information-free record (empty payload)', async () => {
    relayMock.published = [];
    const backend = makeSyncBackend();
    const ok = await publishDependantsSync([], backend, ['wss://a.example', 'wss://b.example']);
    expect(ok).toBe(false);
    expect(relayMock.published).toEqual([]);
  });
});

describe('fetchDependantsSync — relay pool', () => {
  const AUTHOR = 'a'.repeat(64);

  it('dedupes events across two relays and picks the newest', async () => {
    const payload = JSON.stringify({ v: 1, dependants: [] });
    relayMock.fetchReturns = {
      'wss://a.example': [{ id: '1'.repeat(64), created_at: 1000, content: fakeNip44(payload) }],
      'wss://b.example': [{ id: '2'.repeat(64), created_at: 2000, content: fakeNip44(payload) }],
    };
    const backend = makeSyncBackend({ activePublicKeyHex: AUTHOR });
    const result = await fetchDependantsSync(AUTHOR, backend, ['wss://a.example', 'wss://b.example']);
    expect(result).not.toBe('unreachable');
    expect(result).not.toBeNull();
    if (result && result !== 'unreachable') {
      expect(result.eventId).toBe('2'.repeat(64));
      expect(result.createdAt).toBe(2000);
      expect(result.reachableRelays).toBe(2);
    }
  });

  it('returns "unreachable" when every relay fails to connect', async () => {
    relayMock.fetchThrows = new Set(['wss://a.example', 'wss://b.example']);
    const backend = makeSyncBackend({ activePublicKeyHex: AUTHOR });
    const result = await fetchDependantsSync(AUTHOR, backend, ['wss://a.example', 'wss://b.example']);
    expect(result).toBe('unreachable');
  });

  it('accepts a plain string relayUrl (single-relay pool)', async () => {
    const payload = JSON.stringify({ v: 1, dependants: [] });
    relayMock.fetchReturns = { 'wss://a.example': [{ id: '1'.repeat(64), created_at: 1000, content: fakeNip44(payload) }] };
    const backend = makeSyncBackend({ activePublicKeyHex: AUTHOR });
    const result = await fetchDependantsSync(AUTHOR, backend, 'wss://a.example');
    expect(result).not.toBe('unreachable');
    expect(result).not.toBeNull();
    if (result && result !== 'unreachable') expect(result.createdAt).toBe(1000);
  });
});

describe('naturalPersonActive on the dependants rail (spec §3.4/§7.6)', () => {
  it('emits the flag only when the dependant is active', () => {
    const active = makeDerivedDep({ naturalPersonActive: true });
    const dormant = makeDerivedDep({
      naturalPersonActive: false,
      naturalPerson: { publicKey: DEP0_NP_PUB, privateKey: '', displayName: '' },
    });
    expect(toSyncWire(active)!.naturalPersonActive).toBe(true);
    expect(toSyncWire(dormant)!.naturalPersonActive).toBeUndefined();
  });

  it('round-trips the flag through parsePayload', () => {
    const wire = toSyncWire(makeDerivedDep({ naturalPersonActive: true }))!;
    const parsed = parsePayload(JSON.stringify({ v: 1, dependants: [wire] }))!;
    expect(parsed[0].naturalPersonActive).toBe(true);
  });

  it('never accepts a non-true value off the wire', () => {
    const wire = toSyncWire(makeDerivedDep({ naturalPersonActive: true }))!;
    const raw = JSON.stringify({ v: 1, dependants: [{ ...wire, naturalPersonActive: 'yes' }] });
    expect(parsePayload(raw)![0].naturalPersonActive).toBeUndefined();
  });

  it('falls back to the §3.2 lift rule for a record from an older build', () => {
    const wire = toSyncWire(makeDerivedDep({ naturalPersonActive: true }))!;
    delete (wire as { naturalPersonActive?: true }).naturalPersonActive;
    const rebuilt = fromSyncWire(wire, TEST_MNEMONIC)!;
    // np.displayName is non-empty on this fixture, so it lifts to active.
    expect(isDependantNaturalPersonActive(rebuilt)).toBe(true);
  });

  it('lifts an unnamed NP from an older build to dormant', () => {
    const wire = toSyncWire(makeDerivedDep({
      naturalPersonActive: false,
      naturalPerson: { publicKey: DEP0_NP_PUB, privateKey: '', displayName: '' },
    }))!;
    const rebuilt = fromSyncWire(wire, TEST_MNEMONIC)!;
    expect(rebuilt.naturalPersonActive).toBe(false);
  });

  it('OR-merges: a remote activation propagates to a dormant local', () => {
    const local = makeDerivedDep({
      naturalPersonActive: false,
      naturalPerson: { publicKey: DEP0_NP_PUB, privateKey: '', displayName: '' },
    });
    const remote = { ...local, naturalPersonActive: true };
    expect(mergeDependantWithLocal(remote, local).naturalPersonActive).toBe(true);
  });

  it('OR-merges: a dormant remote NEVER deactivates an active local', () => {
    const local = makeDerivedDep({ naturalPersonActive: true });
    const remote = {
      ...local,
      naturalPersonActive: false,
      naturalPerson: { ...local.naturalPerson, displayName: '' },
    };
    expect(mergeDependantWithLocal(remote, local).naturalPersonActive).toBe(true);
  });

  it('keeps a brand-new remote dependant as sent when there is no local copy', () => {
    const remote = makeDerivedDep({
      naturalPersonActive: false,
      naturalPerson: { publicKey: DEP0_NP_PUB, privateKey: '', displayName: '' },
    });
    expect(mergeDependantWithLocal(remote, null).naturalPersonActive).toBe(false);
  });
});


describe('deleted dependant persona recovery', () => {
  it('retains deleted numbers through the actual wire parser and keyless/local recovery, rejecting stale resurrection', async () => {
    const { nextDependantPersonaName } = await import('./dependant-persona-allocation');
    const deleted = makeDerivedDep({
      extraPersonaTombstones: [{ derivationName: 'dependant-0-persona-7', removedAt: 1234 }],
    });
    const payload = parsePayload(JSON.stringify({ v: 1, dependants: [toSyncWire(deleted)] }))!;
    expect(payload[0].extraPersonaTombstones).toEqual(deleted.extraPersonaTombstones);
    for (const deviceHeldKeys of [false, true]) {
      const restored = fromSyncWire(payload[0], TEST_MNEMONIC, { deviceHeldKeys })!;
      expect(nextDependantPersonaName(restored)).toBe('dependant-0-persona-8');
      const stale = makeDerivedDep({
        extraPersonas: [{ derivationName: 'dependant-0-persona-7', publicKey: 'e'.repeat(64), privateKey: '', displayName: 'Deleted' }],
        primaryKeypair: 'e'.repeat(64),
      });
      for (const merged of [mergeDependantWithLocal(stale, restored), mergeDependantWithLocal(restored, stale)]) {
        expect(merged.extraPersonas).toEqual([]);
        expect(merged.primaryKeypair).not.toBe('e'.repeat(64));
        expect(nextDependantPersonaName(merged)).toBe('dependant-0-persona-8');
      }
    }
  });

  it('continues above old one-based live names and ignores another dependant’s tombstones', async () => {
    const { nextDependantPersonaName } = await import('./dependant-persona-allocation');
    const dep = makeDerivedDep({
      extraPersonas: [{ derivationName: 'dependant-0-persona-4', publicKey: 'e'.repeat(64), privateKey: '', displayName: 'Existing' }],
      extraPersonaTombstones: [{ derivationName: 'dependant-1-persona-99', removedAt: 1 }],
    });
    expect(nextDependantPersonaName(dep)).toBe('dependant-0-persona-5');
  });
});
