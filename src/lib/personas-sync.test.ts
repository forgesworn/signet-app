import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the relay transport so publish/fetch resolve without a live relay —
// same pattern as contacts-sync.test.ts / relay-pool.test.ts. Tracks
// per-URL publish calls and lets each test seed per-URL fetch results.
// `fetchThrows` fails at connect() (never reaches fetch); `fetchFailUrls`
// fails at fetch() after a successful connect() — the two are distinct
// failure points a caller might handle differently.
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

import type { ExtraPersona, ExtraPersonaTombstone, SignetIdentity } from '../types';
import {
  SYNC_D_TAG,
  toWire,
  parsePayload,
  mergePersonas,
  publishPersonasSync,
  fetchPersonasSync,
  isWireRicherThan,
  computePublishDelayMs,
  type SyncedPersonasPayload,
  type MergeInput,
} from './personas-sync';
import { createSyncDecryptCache, forgetSyncCacheKeys } from './sync-decrypt-cache';

// Standard all-zeros BIP-39 mnemonic — same fixture as dependants-sync.test.ts.
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// deriveExtraPersona(TEST_MNEMONIC, 'persona-1' / 'persona-2') — pre-computed
// and pinned (see task-2 derivation script).
const P1_PUB = '743863716c1af825031a17d216ebf302e081f89da92d1a7939fd7f535a263f19';
const P1_PRIV = '7c493046b24e6e5af1ab6c086dccadb8d6b02757b23beff689c19d690cf20549';
const P2_PUB = '2c2520dece988406b7fac79cc67ef404cec560c20731d439451203c3e5bd3475';

function makeIdentity(overrides: Partial<SignetIdentity> = {}): SignetIdentity {
  return {
    id: 'a'.repeat(64),
    mnemonic: TEST_MNEMONIC,
    naturalPerson: { publicKey: 'b'.repeat(64), privateKey: 'c'.repeat(64), displayName: 'Alice' },
    persona: { publicKey: 'd'.repeat(64), privateKey: 'e'.repeat(64), displayName: 'Anon' },
    primaryKeypair: 'natural-person',
    isChild: false,
    createdAt: 1000,
    ...overrides,
  };
}

function makeExtra(overrides: Partial<ExtraPersona> = {}): ExtraPersona {
  return {
    publicKey: P1_PUB,
    privateKey: P1_PRIV,
    displayName: 'Persona One',
    derivationName: 'persona-1',
    updatedAt: 500,
    ...overrides,
  };
}

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

function makeBackend(overrides: Partial<{
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

describe('toWire', () => {
  it('serialises derived extras, stripping private keys and publicProfile state', () => {
    const identity = makeIdentity({
      extraPersonas: [makeExtra({ publicProfile: { enabled: true, lastEventId: 'z'.repeat(64) } })],
    });
    const wire = toWire(identity);
    expect(wire.v).toBe(1);
    expect(wire.personas).toHaveLength(1);
    expect(wire.personas[0].publicKey).toBe(P1_PUB);
    expect(wire.personas[0].derivationName).toBe('persona-1');
    expect(JSON.stringify(wire)).not.toMatch(/privateKey/);
    expect(JSON.stringify(wire)).not.toMatch(/publicProfile/);
    expect(JSON.stringify(wire)).not.toMatch(/lastEventId/);
  });

  it('skips imported extras entirely', () => {
    const identity = makeIdentity({
      extraPersonas: [
        makeExtra(),
        { publicKey: 'f'.repeat(64), privateKey: 'a'.repeat(64), displayName: 'Imported', derivationName: '', imported: true },
      ],
    });
    const wire = toWire(identity);
    expect(wire.personas).toHaveLength(1);
    expect(wire.personas[0].derivationName).toBe('persona-1');
  });

  it('carries the 8 profile config fields under `profile`, never avatar fields', () => {
    const identity = makeIdentity({
      extraPersonas: [makeExtra({
        about: 'Hello',
        pictureUrl: 'https://example.com/pic.png',
        nip05: 'me@example.com',
        avatarHash: 'x'.repeat(64),
        avatarKey: 'y'.repeat(64),
      })],
    });
    const wire = toWire(identity);
    expect(wire.personas[0].profile).toEqual({ about: 'Hello', pictureUrl: 'https://example.com/pic.png', nip05: 'me@example.com' });
    expect(JSON.stringify(wire)).not.toMatch(/avatarHash/);
    expect(JSON.stringify(wire)).not.toMatch(/avatarKey/);
  });

  it('omits `profile` when no config fields are set', () => {
    const identity = makeIdentity({ extraPersonas: [makeExtra()] });
    const wire = toWire(identity);
    expect(wire.personas[0].profile).toBeUndefined();
  });

  it('never carries nip05CheckResult / nip05CheckedAt on the wire (device-local only)', () => {
    const identity = makeIdentity({
      extraPersonas: [makeExtra({
        nip05: 'me@example.com',
        nip05CheckResult: 'match',
        nip05CheckedAt: 1_700_000_000_000,
      })],
    });
    const wire = toWire(identity);
    expect(wire.personas[0].profile).toEqual({ nip05: 'me@example.com' });
    expect(JSON.stringify(wire)).not.toMatch(/nip05CheckResult/);
    expect(JSON.stringify(wire)).not.toMatch(/nip05CheckedAt/);
  });

  it('carries hidden only when explicitly set on the local record', () => {
    const identity = makeIdentity({
      extraPersonas: [makeExtra({ hidden: true }), makeExtra({ publicKey: P2_PUB, derivationName: 'persona-2' })],
    });
    const wire = toWire(identity);
    expect(wire.personas[0].hidden).toBe(true);
    expect(wire.personas[1].hidden).toBeUndefined();
  });

  it('carries tombstones (as fresh copies, not the same array reference) and professional persona when present', () => {
    const tombstones: ExtraPersonaTombstone[] = [{ derivationName: 'persona-3', removedAt: 999 }];
    const identity = makeIdentity({
      extraPersonaTombstones: tombstones,
      professionalPersona: { publicKey: 'p'.repeat(64), privateKey: 'q'.repeat(64), displayName: 'Dr. Alice', updatedAt: 555 },
    });
    const wire = toWire(identity);
    expect(wire.tombstones).toEqual(tombstones);
    expect(wire.tombstones).not.toBe(tombstones);
    expect(wire.professional).toEqual({ publicKey: 'p'.repeat(64), displayName: 'Dr. Alice', updatedAt: 555 });
  });

  it('defaults professional.updatedAt to 0 for a legacy professionalPersona with no updatedAt stamp', () => {
    const identity = makeIdentity({
      professionalPersona: { publicKey: 'p'.repeat(64), privateKey: 'q'.repeat(64), displayName: 'Dr. Alice' },
    });
    const wire = toWire(identity);
    expect(wire.professional).toEqual({ publicKey: 'p'.repeat(64), displayName: 'Dr. Alice', updatedAt: 0 });
  });

  it('produces an empty personas + tombstones payload for an identity with no extras', () => {
    const wire = toWire(makeIdentity({ naturalPersonActive: false }));
    expect(wire).toEqual({ v: 1, personas: [], tombstones: [] });
  });
});

describe('parsePayload', () => {
  function validRaw(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      v: 1,
      personas: [{ derivationName: 'persona-1', publicKey: P1_PUB, displayName: 'Persona One', updatedAt: 500 }],
      tombstones: [],
      ...overrides,
    });
  }

  it('parses a well-formed payload', () => {
    const parsed = parsePayload(validRaw());
    expect(parsed).not.toBeNull();
    expect(parsed!.personas).toHaveLength(1);
    expect(parsed!.personas[0].publicKey).toBe(P1_PUB);
  });

  it('rejects the whole payload on wrong `v`', () => {
    expect(parsePayload(validRaw({ v: 2 }))).toBeNull();
    expect(parsePayload(validRaw({ v: '1' }))).toBeNull();
  });

  it('rejects non-JSON / non-object input', () => {
    expect(parsePayload('not json')).toBeNull();
    expect(parsePayload('null')).toBeNull();
    expect(parsePayload('42')).toBeNull();
  });

  it('drops a persona entry with a bad-hex publicKey, keeping the rest of the payload', () => {
    const raw = JSON.stringify({
      v: 1,
      personas: [
        { derivationName: 'persona-1', publicKey: 'not-hex', displayName: 'Bad', updatedAt: 1 },
        { derivationName: 'persona-2', publicKey: P2_PUB, displayName: 'Good', updatedAt: 2 },
      ],
      tombstones: [],
    });
    const parsed = parsePayload(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.personas).toHaveLength(1);
    expect(parsed!.personas[0].derivationName).toBe('persona-2');
  });

  it('drops a persona entry with a bad derivationName', () => {
    const raw = JSON.stringify({
      v: 1,
      personas: [{ derivationName: 'not-a-persona-name', publicKey: P1_PUB, displayName: 'Bad', updatedAt: 1 }],
      tombstones: [],
    });
    const parsed = parsePayload(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.personas).toHaveLength(0);
  });

  it('drops a persona entry whose displayName exceeds the 100-char cap', () => {
    const raw = JSON.stringify({
      v: 1,
      personas: [{ derivationName: 'persona-1', publicKey: P1_PUB, displayName: 'x'.repeat(101), updatedAt: 1 }],
      tombstones: [],
    });
    const parsed = parsePayload(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.personas).toHaveLength(0);
  });

  it('accepts a displayName exactly at the 100-char cap', () => {
    const raw = JSON.stringify({
      v: 1,
      personas: [{ derivationName: 'persona-1', publicKey: P1_PUB, displayName: 'x'.repeat(100), updatedAt: 1 }],
      tombstones: [],
    });
    const parsed = parsePayload(raw);
    expect(parsed!.personas).toHaveLength(1);
  });

  it('parses tombstones and drops malformed ones', () => {
    const raw = JSON.stringify({
      v: 1,
      personas: [],
      tombstones: [
        { derivationName: 'persona-3', removedAt: 100 },
        { derivationName: 'bad name', removedAt: 100 },
        { derivationName: 'persona-4' },
      ],
    });
    const parsed = parsePayload(raw);
    expect(parsed!.tombstones).toEqual([{ derivationName: 'persona-3', removedAt: 100 }]);
  });

  it('parses a valid `profile` block, dropping invalid sub-fields', () => {
    const raw = JSON.stringify({
      v: 1,
      personas: [{
        derivationName: 'persona-1',
        publicKey: P1_PUB,
        displayName: 'Persona One',
        updatedAt: 500,
        profile: { about: 'hi', nip05: 'not-an-email', pictureUrl: 'javascript:alert(1)' },
      }],
      tombstones: [],
    });
    const parsed = parsePayload(raw);
    expect(parsed!.personas[0].profile).toEqual({ about: 'hi' });
  });

  it('parses a valid professional block and drops a malformed one', () => {
    const withGood = parsePayload(validRaw({ professional: { publicKey: P2_PUB, displayName: 'Dr. Alice', updatedAt: 42 } }));
    expect(withGood!.professional).toEqual({ publicKey: P2_PUB, displayName: 'Dr. Alice', updatedAt: 42 });

    const withBad = parsePayload(validRaw({ professional: { publicKey: 'not-hex', displayName: 'Dr. Alice', updatedAt: 42 } }));
    expect(withBad!.professional).toBeUndefined();
  });
});

describe('mergePersonas', () => {
  function baseInput(overrides: Partial<MergeInput> = {}): MergeInput {
    return {
      local: [],
      localTombstones: [],
      localRecordAt: 100,
      remote: { v: 1, personas: [], tombstones: [] },
      remoteCreatedAt: 100,
      mnemonic: TEST_MNEMONIC,
      deviceHeldKeys: false,
      localNaturalPersonActive: false,
      localNaturalPersonDisplayName: '',
      ...overrides,
    };
  }

  it('remote-newer rename wins', () => {
    const local = [makeExtra({ displayName: 'Old Name', updatedAt: 100 })];
    const remote: SyncedPersonasPayload = {
      v: 1,
      personas: [{ derivationName: 'persona-1', publicKey: P1_PUB, displayName: 'New Name', updatedAt: 200 }],
      tombstones: [],
    };
    const result = mergePersonas(baseInput({ local, remote, remoteCreatedAt: 200 }));
    expect(result.extraPersonas).toHaveLength(1);
    expect(result.extraPersonas[0].displayName).toBe('New Name');
    expect(result.skipped).toEqual([]);
  });

  it('local-newer rename wins', () => {
    const local = [makeExtra({ displayName: 'Local Name', updatedAt: 300 })];
    const remote: SyncedPersonasPayload = {
      v: 1,
      personas: [{ derivationName: 'persona-1', publicKey: P1_PUB, displayName: 'Stale Remote Name', updatedAt: 100 }],
      tombstones: [],
    };
    const result = mergePersonas(baseInput({ local, remote, remoteCreatedAt: 50, localRecordAt: 300 }));
    expect(result.extraPersonas).toHaveLength(1);
    expect(result.extraPersonas[0].displayName).toBe('Local Name');
  });

  it('a tombstone removes a persona when removedAt >= its updatedAt (tie goes to the tombstone)', () => {
    const local = [makeExtra({ updatedAt: 100 })];
    const result = mergePersonas(baseInput({
      local,
      localTombstones: [{ derivationName: 'persona-1', removedAt: 100 }],
    }));
    expect(result.extraPersonas).toHaveLength(0);
    expect(result.tombstones).toEqual([{ derivationName: 'persona-1', removedAt: 100 }]);
  });

  it('a tombstone does NOT remove a persona updated strictly after the tombstone', () => {
    const local = [makeExtra({ updatedAt: 200 })];
    const result = mergePersonas(baseInput({
      local,
      localTombstones: [{ derivationName: 'persona-1', removedAt: 100 }],
    }));
    expect(result.extraPersonas).toHaveLength(1);
  });

  it('tombstones never apply to imported locals', () => {
    const imported: ExtraPersona = {
      publicKey: 'f'.repeat(64), privateKey: 'a'.repeat(64), displayName: 'Imported', derivationName: '', imported: true, updatedAt: 1,
    };
    const result = mergePersonas(baseInput({
      local: [imported],
      localTombstones: [{ derivationName: '', removedAt: 999999 }],
    }));
    expect(result.extraPersonas).toHaveLength(1);
    expect(result.extraPersonas[0].imported).toBe(true);
  });

  it('a local-only persona survives, appended at the tail when local order is kept', () => {
    const local = [
      makeExtra({ derivationName: 'persona-1', publicKey: P1_PUB, updatedAt: 100 }),
      makeExtra({ derivationName: 'persona-2', publicKey: P2_PUB, updatedAt: 100 }),
    ];
    // remote knows only persona-1; remote is not newer, so local order is kept
    // and remote brings nothing new — persona-2 simply survives untouched.
    const remote: SyncedPersonasPayload = {
      v: 1,
      personas: [{ derivationName: 'persona-1', publicKey: P1_PUB, displayName: 'Persona One', updatedAt: 50 }],
      tombstones: [],
    };
    const result = mergePersonas(baseInput({ local, remote, remoteCreatedAt: 50, localRecordAt: 100 }));
    expect(result.extraPersonas.map(p => p.derivationName)).toEqual(['persona-1', 'persona-2']);
  });

  it('adopts remote order (plus local-only tail) when the remote record is newer', () => {
    const local = [
      makeExtra({ derivationName: 'persona-1', publicKey: P1_PUB, updatedAt: 100 }),
      makeExtra({ derivationName: 'persona-2', publicKey: P2_PUB, updatedAt: 100 }),
    ];
    // Remote lists persona-2 before persona-1, and is newer than local's record.
    const remote: SyncedPersonasPayload = {
      v: 1,
      personas: [
        { derivationName: 'persona-2', publicKey: P2_PUB, displayName: 'Persona Two', updatedAt: 300 },
        { derivationName: 'persona-1', publicKey: P1_PUB, displayName: 'Persona One', updatedAt: 300 },
      ],
      tombstones: [],
    };
    const result = mergePersonas(baseInput({ local, remote, remoteCreatedAt: 500, localRecordAt: 100 }));
    expect(result.extraPersonas.map(p => p.derivationName)).toEqual(['persona-2', 'persona-1']);
  });

  it('keeps local order and appends a brand-new remote persona at the tail when local record is newer', () => {
    const local = [makeExtra({ derivationName: 'persona-1', publicKey: P1_PUB, updatedAt: 100 })];
    const remote: SyncedPersonasPayload = {
      v: 1,
      personas: [
        { derivationName: 'persona-2', publicKey: P2_PUB, displayName: 'Persona Two', updatedAt: 50 },
        { derivationName: 'persona-1', publicKey: P1_PUB, displayName: 'Persona One', updatedAt: 50 },
      ],
      tombstones: [],
    };
    const result = mergePersonas(baseInput({ local, remote, remoteCreatedAt: 50, localRecordAt: 200 }));
    expect(result.extraPersonas.map(p => p.derivationName)).toEqual(['persona-1', 'persona-2']);
  });

  it('clears the NIP-05 check result when a remote-wins merge changes nip05 (stale-Verified fix)', () => {
    const local = [makeExtra({
      nip05: 'alice@a.com',
      nip05CheckResult: 'match',
      nip05CheckedAt: 1_700_000_000_000,
      updatedAt: 100,
    })];
    const remote: SyncedPersonasPayload = {
      v: 1,
      personas: [{
        derivationName: 'persona-1',
        publicKey: P1_PUB,
        displayName: 'Persona One',
        updatedAt: 200,
        profile: { nip05: 'bob@b.com' },
      }],
      tombstones: [],
    };
    const result = mergePersonas(baseInput({ local, remote, remoteCreatedAt: 200, localRecordAt: 100 }));
    expect(result.extraPersonas).toHaveLength(1);
    expect(result.extraPersonas[0].nip05).toBe('bob@b.com');
    expect(result.extraPersonas[0].nip05CheckResult).toBeUndefined();
    expect(result.extraPersonas[0].nip05CheckedAt).toBeUndefined();
  });

  it('preserves the NIP-05 check result across a remote-wins merge when nip05 is unchanged', () => {
    const local = [makeExtra({
      nip05: 'alice@a.com',
      nip05CheckResult: 'match',
      nip05CheckedAt: 1_700_000_000_000,
      updatedAt: 100,
    })];
    const remote: SyncedPersonasPayload = {
      v: 1,
      personas: [{
        derivationName: 'persona-1',
        publicKey: P1_PUB,
        displayName: 'Persona One Renamed',
        updatedAt: 200,
        profile: { nip05: 'alice@a.com' },
      }],
      tombstones: [],
    };
    const result = mergePersonas(baseInput({ local, remote, remoteCreatedAt: 200, localRecordAt: 100 }));
    expect(result.extraPersonas[0].nip05).toBe('alice@a.com');
    expect(result.extraPersonas[0].nip05CheckResult).toBe('match');
    expect(result.extraPersonas[0].nip05CheckedAt).toBe(1_700_000_000_000);
  });

  it('accepts a keyless remote persona only when deviceHeldKeys is true', () => {
    const remote: SyncedPersonasPayload = {
      v: 1,
      personas: [{ derivationName: 'persona-1', publicKey: P1_PUB, displayName: 'Persona One', updatedAt: 100 }],
      tombstones: [],
    };
    const withDeviceKeys = mergePersonas(baseInput({ remote, mnemonic: null, deviceHeldKeys: true }));
    expect(withDeviceKeys.extraPersonas).toHaveLength(1);
    expect(withDeviceKeys.extraPersonas[0].privateKey).toBe('');
    expect(withDeviceKeys.skipped).toEqual([]);
  });

  it('skips a remote persona when there is no mnemonic and not deviceHeldKeys', () => {
    const remote: SyncedPersonasPayload = {
      v: 1,
      personas: [{ derivationName: 'persona-1', publicKey: P1_PUB, displayName: 'Persona One', updatedAt: 100 }],
      tombstones: [],
    };
    const result = mergePersonas(baseInput({ remote, mnemonic: null, deviceHeldKeys: false }));
    expect(result.extraPersonas).toHaveLength(0);
    expect(result.skipped).toEqual(['persona-1']);
  });

  it('skips a remote persona whose re-derived pubkey does not match the wire pubkey (forged-wire defence)', () => {
    const remote: SyncedPersonasPayload = {
      v: 1,
      personas: [{ derivationName: 'persona-1', publicKey: 'f'.repeat(64), displayName: 'Forged', updatedAt: 100 }],
      tombstones: [],
    };
    const result = mergePersonas(baseInput({ remote, mnemonic: TEST_MNEMONIC }));
    expect(result.extraPersonas).toHaveLength(0);
    expect(result.skipped).toEqual(['persona-1']);
  });

  it('re-derives correctly when the wire pubkey matches, keeping the real private key local', () => {
    const remote: SyncedPersonasPayload = {
      v: 1,
      personas: [{ derivationName: 'persona-1', publicKey: P1_PUB, displayName: 'Persona One', updatedAt: 100 }],
      tombstones: [],
    };
    const result = mergePersonas(baseInput({ remote, mnemonic: TEST_MNEMONIC }));
    expect(result.extraPersonas).toHaveLength(1);
    expect(result.extraPersonas[0].privateKey).toBe(P1_PRIV);
  });

  it('preserves local-only fields (avatar, publicProfile state) when the remote side wins a rename', () => {
    const local = [makeExtra({
      displayName: 'Old Name',
      updatedAt: 100,
      avatarHash: 'z'.repeat(64),
      publicProfile: { enabled: true, lastEventId: 'q'.repeat(64) },
    })];
    const remote: SyncedPersonasPayload = {
      v: 1,
      personas: [{ derivationName: 'persona-1', publicKey: P1_PUB, displayName: 'New Name', updatedAt: 200 }],
      tombstones: [],
    };
    const result = mergePersonas(baseInput({ local, remote, remoteCreatedAt: 200 }));
    expect(result.extraPersonas[0].displayName).toBe('New Name');
    expect(result.extraPersonas[0].avatarHash).toBe('z'.repeat(64));
    expect(result.extraPersonas[0].publicProfile).toEqual({ enabled: true, lastEventId: 'q'.repeat(64) });
  });

  it('a brand-new remote persona (no local counterpart) is built from the wire only', () => {
    const remote: SyncedPersonasPayload = {
      v: 1,
      personas: [{ derivationName: 'persona-1', publicKey: P1_PUB, displayName: 'Persona One', updatedAt: 100, hidden: true }],
      tombstones: [],
    };
    const result = mergePersonas(baseInput({ remote }));
    expect(result.extraPersonas).toHaveLength(1);
    expect(result.extraPersonas[0].hidden).toBe(true);
    expect(result.extraPersonas[0].publicProfile).toBeUndefined();
  });

  it('a keyless remote (equal updatedAt) never clobbers a populated local private key, and changed is false when nothing else differs', () => {
    const local = [makeExtra({ updatedAt: 100 })]; // displayName 'Persona One', privateKey P1_PRIV
    const remote: SyncedPersonasPayload = {
      v: 1,
      personas: [{ derivationName: 'persona-1', publicKey: P1_PUB, displayName: 'Persona One', updatedAt: 100 }],
      tombstones: [],
    };
    const result = mergePersonas(baseInput({
      local,
      remote,
      remoteCreatedAt: 100,
      localRecordAt: 100,
      mnemonic: null,
      deviceHeldKeys: true,
    }));
    expect(result.extraPersonas).toHaveLength(1);
    expect(result.extraPersonas[0].privateKey).toBe(P1_PRIV);
    expect(result.changed).toBe(false);
  });

  it('propagates a profile-field clear: local nip05 set, newer remote without nip05 clears it', () => {
    const local = [makeExtra({ updatedAt: 100, nip05: 'me@example.com' })];
    const remote: SyncedPersonasPayload = {
      v: 1,
      personas: [{ derivationName: 'persona-1', publicKey: P1_PUB, displayName: 'Persona One', updatedAt: 200 }],
      tombstones: [],
    };
    const result = mergePersonas(baseInput({ local, remote, remoteCreatedAt: 200, localRecordAt: 100 }));
    expect(result.extraPersonas[0].nip05).toBeUndefined();
  });

  it('does NOT clear a profile field when local wins (local is newer)', () => {
    const local = [makeExtra({ updatedAt: 300, nip05: 'me@example.com' })];
    const remote: SyncedPersonasPayload = {
      v: 1,
      personas: [{ derivationName: 'persona-1', publicKey: P1_PUB, displayName: 'Stale', updatedAt: 100 }],
      tombstones: [],
    };
    const result = mergePersonas(baseInput({ local, remote, remoteCreatedAt: 50, localRecordAt: 300 }));
    expect(result.extraPersonas[0].nip05).toBe('me@example.com');
  });

  it('a legacy local persona with no updatedAt is treated as 0 — a tombstone with removedAt 0 ties and wins', () => {
    const legacyLocal: ExtraPersona = {
      publicKey: P1_PUB, privateKey: P1_PRIV, displayName: 'Legacy', derivationName: 'persona-1',
    }; // no updatedAt at all
    const result = mergePersonas(baseInput({
      local: [legacyLocal],
      localTombstones: [{ derivationName: 'persona-1', removedAt: 0 }],
    }));
    expect(result.extraPersonas).toHaveLength(0);
  });

  it('changed is false for an identical round-trip (remote payload matches local exactly)', () => {
    const local = [makeExtra({ updatedAt: 100 })];
    const remote: SyncedPersonasPayload = {
      v: 1,
      personas: [{ derivationName: 'persona-1', publicKey: P1_PUB, displayName: 'Persona One', updatedAt: 100 }],
      tombstones: [],
    };
    const result = mergePersonas(baseInput({ local, remote, remoteCreatedAt: 100, localRecordAt: 100 }));
    expect(result.changed).toBe(false);
  });

  it('imported-splice ordering: [P1, IMPORTED, P2] becomes [P1, P2, IMPORTED]', () => {
    const imported: ExtraPersona = {
      publicKey: 'f'.repeat(64), privateKey: 'a'.repeat(64), displayName: 'Imported', derivationName: '', imported: true,
    };
    const local = [
      makeExtra({ derivationName: 'persona-1', publicKey: P1_PUB, updatedAt: 100 }),
      imported,
      makeExtra({ derivationName: 'persona-2', publicKey: P2_PUB, updatedAt: 100 }),
    ];
    const result = mergePersonas(baseInput({ local, remote: { v: 1, personas: [], tombstones: [] }, remoteCreatedAt: 0, localRecordAt: 100 }));
    expect(result.extraPersonas.map(p => p.derivationName)).toEqual(['persona-1', 'persona-2', '']);
  });
});

describe('computePublishDelayMs', () => {
  it('is 6000 when random() returns 0', () => {
    expect(computePublishDelayMs(() => 0)).toBe(6000);
  });

  it('is just under 91000 when random() returns just under 1', () => {
    const v = computePublishDelayMs(() => 0.999999999);
    expect(v).toBeLessThan(91000);
    expect(v).toBeGreaterThan(90000);
  });

  it('defaults to Math.random and stays within bounds', () => {
    const v = computePublishDelayMs();
    expect(v).toBeGreaterThanOrEqual(6000);
    expect(v).toBeLessThan(91000);
  });
});

describe('publishPersonasSync', () => {
  it('returns true when at least one of two relays accepts the publish', async () => {
    relayMock.published = [];
    relayMock.publishOk = { 'wss://a.example': false, 'wss://b.example': true };
    const identity = makeIdentity({ extraPersonas: [makeExtra()] });
    const backend = makeBackend();
    const ok = await publishPersonasSync(identity, backend, ['wss://a.example', 'wss://b.example']);
    expect(ok).toBe(true);
    expect(relayMock.published.map(p => p.url).sort()).toEqual(['wss://a.example', 'wss://b.example']);
  });

  it('returns false when every relay rejects', async () => {
    relayMock.published = [];
    relayMock.publishOk = { 'wss://a.example': false, 'wss://b.example': false };
    const identity = makeIdentity({ extraPersonas: [makeExtra()] });
    const backend = makeBackend();
    const ok = await publishPersonasSync(identity, backend, ['wss://a.example', 'wss://b.example']);
    expect(ok).toBe(false);
  });

  it('never publishes an information-free record (no personas, no tombstones, no professional)', async () => {
    relayMock.published = [];
    const identity = makeIdentity({
      extraPersonas: [], extraPersonaTombstones: [], professionalPersona: undefined,
      naturalPersonActive: false,
    });
    const backend = makeBackend();
    const ok = await publishPersonasSync(identity, backend, ['wss://a.example', 'wss://b.example']);
    expect(ok).toBe(false);
    expect(relayMock.published).toEqual([]);
  });

  it('does publish a record that is empty of personas but carries a tombstone', async () => {
    relayMock.published = [];
    const identity = makeIdentity({
      extraPersonas: [],
      extraPersonaTombstones: [{ derivationName: 'persona-1', removedAt: 10 }],
      professionalPersona: undefined,
    });
    const backend = makeBackend();
    const ok = await publishPersonasSync(identity, backend, ['wss://a.example']);
    expect(ok).toBe(true);
  });

  it('returns false when no relay URL is valid', async () => {
    const identity = makeIdentity();
    const backend = makeBackend();
    const ok = await publishPersonasSync(identity, backend, ['http://not-wss.example']);
    expect(ok).toBe(false);
  });
});

describe('fetchPersonasSync', () => {
  const AUTHOR = 'a'.repeat(64);

  it('dedupes events across two relays and picks the newest', async () => {
    forgetSyncCacheKeys();
    const payload: SyncedPersonasPayload = { v: 1, personas: [], tombstones: [] };
    relayMock.fetchThrows = new Set();
    relayMock.fetchReturns = {
      'wss://a.example': [{ id: '1'.repeat(64), created_at: 1000, content: fakeNip44(JSON.stringify(payload)) }],
      'wss://b.example': [{ id: '2'.repeat(64), created_at: 2000, content: fakeNip44(JSON.stringify(payload)) }],
    };
    const backend = makeBackend({ activePublicKeyHex: AUTHOR });
    const result = await fetchPersonasSync(AUTHOR, backend, ['wss://a.example', 'wss://b.example']);
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
    relayMock.fetchReturns = {};
    const backend = makeBackend({ activePublicKeyHex: AUTHOR });
    const result = await fetchPersonasSync(AUTHOR, backend, ['wss://a.example', 'wss://b.example']);
    expect(result).toBe('unreachable');
  });

  it('returns null when relays are reachable but nothing is found', async () => {
    relayMock.fetchThrows = new Set();
    relayMock.fetchReturns = { 'wss://a.example': [], 'wss://b.example': [] };
    const backend = makeBackend({ activePublicKeyHex: AUTHOR });
    const result = await fetchPersonasSync(AUTHOR, backend, ['wss://a.example', 'wss://b.example']);
    expect(result).toBeNull();
  });

  it('uses the decrypt cache: a second fetch of the same event skips nip44Decrypt', async () => {
    forgetSyncCacheKeys();
    const payload: SyncedPersonasPayload = { v: 1, personas: [], tombstones: [] };
    relayMock.fetchThrows = new Set();
    relayMock.fetchReturns = {
      'wss://a.example': [{ id: '3'.repeat(64), created_at: 1000, content: fakeNip44(JSON.stringify(payload)) }],
    };
    // F3: this override was a stale `ENC(...)` stripper from before `fakeNip44`
    // moved to the real v2-base64 shape (S5) — it no longer matched what the
    // fixture actually produces, so the "decrypt" silently no-op'd (the string
    // never started with `ENC(`) and the test passed vacuously on call count
    // alone. `openFakeNip44` is `fakeNip44`'s real inverse.
    const nip44Decrypt = vi.fn(async (_pub: string, ciphertext: string) => openFakeNip44(ciphertext));
    const backend = makeBackend({ activePublicKeyHex: AUTHOR, nip44Decrypt });
    const cache = createSyncDecryptCache({ dTag: SYNC_D_TAG, authorPubkey: AUTHOR, encryptionKey: 'a'.repeat(64) });

    await fetchPersonasSync(AUTHOR, backend, ['wss://a.example'], undefined, cache);
    await fetchPersonasSync(AUTHOR, backend, ['wss://a.example'], undefined, cache);

    expect(nip44Decrypt).toHaveBeenCalledTimes(1);
  });

  it('returns null when the latest event is not newer than sinceCreatedAt', async () => {
    relayMock.fetchThrows = new Set();
    const payload: SyncedPersonasPayload = { v: 1, personas: [], tombstones: [] };
    relayMock.fetchReturns = { 'wss://a.example': [{ id: '4'.repeat(64), created_at: 1000, content: fakeNip44(JSON.stringify(payload)) }] };
    const backend = makeBackend({ activePublicKeyHex: AUTHOR });
    const result = await fetchPersonasSync(AUTHOR, backend, ['wss://a.example'], 1000);
    expect(result).toBeNull();
  });

  it('an older event on one relay does not suppress a newer one on another under sinceCreatedAt', async () => {
    const payload: SyncedPersonasPayload = { v: 1, personas: [], tombstones: [] };
    relayMock.fetchReturns = {
      'wss://a.example': [{ id: 'a'.repeat(64), created_at: 1000, content: fakeNip44(JSON.stringify(payload)) }],
      'wss://b.example': [{ id: 'b'.repeat(64), created_at: 2000, content: fakeNip44(JSON.stringify(payload)) }],
    };
    const backend = makeBackend({ activePublicKeyHex: AUTHOR });
    const result = await fetchPersonasSync(AUTHOR, backend, ['wss://a.example', 'wss://b.example'], 1000);
    expect(result).not.toBeNull();
    expect(result).not.toBe('unreachable');
    if (result && result !== 'unreachable') {
      expect(result.eventId).toBe('b'.repeat(64));
      expect(result.createdAt).toBe(2000);
    }
  });

  it('returns null (not unreachable) for a malformed authorPubkey', async () => {
    const backend = makeBackend();
    const result = await fetchPersonasSync('not-hex', backend, ['wss://a.example']);
    expect(result).toBeNull();
  });

  it('returns null when decrypt throws', async () => {
    relayMock.fetchReturns = {
      'wss://a.example': [{ id: '5'.repeat(64), created_at: 1000, content: 'garbage' }],
    };
    const nip44Decrypt = vi.fn(async () => { throw new Error('bad decrypt'); });
    const backend = makeBackend({ activePublicKeyHex: AUTHOR, nip44Decrypt });
    const result = await fetchPersonasSync(AUTHOR, backend, ['wss://a.example']);
    expect(result).toBeNull();
  });

  it('counts a relay unreachable when connect succeeds but fetch throws, without failing relays that succeed', async () => {
    const payload: SyncedPersonasPayload = { v: 1, personas: [], tombstones: [] };
    relayMock.fetchFailUrls = new Set(['wss://a.example']);
    relayMock.fetchReturns = {
      'wss://b.example': [{ id: '6'.repeat(64), created_at: 1000, content: fakeNip44(JSON.stringify(payload)) }],
    };
    const backend = makeBackend({ activePublicKeyHex: AUTHOR });
    const result = await fetchPersonasSync(AUTHOR, backend, ['wss://a.example', 'wss://b.example']);
    expect(result).not.toBeNull();
    expect(result).not.toBe('unreachable');
    if (result && result !== 'unreachable') {
      expect(result.reachableRelays).toBe(1);
      expect(result.eventId).toBe('6'.repeat(64));
    }
  });
});

describe('isWireRicherThan', () => {
  const persona = (over: Partial<SyncedPersonasPayload['personas'][number]> = {}) => ({
    derivationName: 'persona-1',
    publicKey: 'f'.repeat(64),
    displayName: 'One',
    updatedAt: 500,
    ...over,
  });
  const wire = (over: Partial<SyncedPersonasPayload> = {}): SyncedPersonasPayload => ({
    v: 1, personas: [], tombstones: [], ...over,
  });
  const PRO = { publicKey: '7'.repeat(64), displayName: 'Dr Who', updatedAt: 100 };

  it('two identical records are not richer', () => {
    const a = wire({ personas: [persona()], tombstones: [{ derivationName: 'persona-9', removedAt: 5 }], professional: PRO });
    const b = wire({ personas: [persona()], tombstones: [{ derivationName: 'persona-9', removedAt: 5 }], professional: PRO });
    expect(isWireRicherThan(a, b)).toBe(false);
  });

  it('merged holding a persona the remote lacks is richer', () => {
    const merged = wire({ personas: [persona(), persona({ derivationName: 'persona-2', publicKey: '1'.repeat(64) })] });
    expect(isWireRicherThan(merged, wire({ personas: [persona()] }))).toBe(true);
  });

  it('remote holding a persona the merged record lacks is NOT richer (the skipped-persona case)', () => {
    const remote = wire({ personas: [persona(), persona({ derivationName: 'persona-2', publicKey: '1'.repeat(64) })] });
    expect(isWireRicherThan(wire({ personas: [persona()] }), remote)).toBe(false);
  });

  it('a differing persona field counts (newer local rename)', () => {
    const merged = wire({ personas: [persona({ displayName: 'Renamed', updatedAt: 900 })] });
    expect(isWireRicherThan(merged, wire({ personas: [persona()] }))).toBe(true);
  });

  it('a profile-field clear counts (absent on one side, present on the other)', () => {
    const withAbout = wire({ personas: [persona({ profile: { about: 'hi' } })] });
    const without = wire({ personas: [persona()] });
    expect(isWireRicherThan(withAbout, without)).toBe(true);
    expect(isWireRicherThan(without, withAbout)).toBe(true);
  });

  it('a tombstone the remote lacks, or a newer removedAt, counts', () => {
    const merged = wire({ tombstones: [{ derivationName: 'persona-3', removedAt: 10 }] });
    expect(isWireRicherThan(merged, wire())).toBe(true);
    expect(isWireRicherThan(merged, wire({ tombstones: [{ derivationName: 'persona-3', removedAt: 5 }] }))).toBe(true);
    expect(isWireRicherThan(merged, wire({ tombstones: [{ derivationName: 'persona-3', removedAt: 20 }] }))).toBe(false);
  });

  it('order-only differences do not count', () => {
    const p1 = persona();
    const p2 = persona({ derivationName: 'persona-2', publicKey: '1'.repeat(64) });
    const t1 = { derivationName: 'persona-8', removedAt: 1 };
    const t2 = { derivationName: 'persona-9', removedAt: 2 };
    const a = wire({ personas: [p1, p2], tombstones: [t1, t2] });
    const b = wire({ personas: [p2, p1], tombstones: [t2, t1] });
    expect(isWireRicherThan(a, b)).toBe(false);
    expect(isWireRicherThan(b, a)).toBe(false);
  });

  it('a professional block the remote lacks, or one that differs, counts', () => {
    expect(isWireRicherThan(wire({ professional: PRO }), wire())).toBe(true);
    expect(isWireRicherThan(wire({ professional: { ...PRO, displayName: 'Dr Other' } }), wire({ professional: PRO }))).toBe(true);
  });

  it('a professional block only the REMOTE has is not richer (the no-Pro-slot device)', () => {
    expect(isWireRicherThan(wire(), wire({ professional: PRO }))).toBe(false);
  });
});

describe('naturalPersonActive on the wire', () => {
  it('toWire carries the flag only when the real identity is active', () => {
    const active = makeIdentity({ naturalPersonActive: true });
    const dormant = makeIdentity({ naturalPersonActive: false });
    expect(toWire(active).naturalPersonActive).toBe(true);
    expect(toWire(dormant).naturalPersonActive).toBeUndefined();
  });

  it('parsePayload accepts a literal true and ignores anything else', () => {
    const base = { v: 1, personas: [], tombstones: [] };
    expect(parsePayload(JSON.stringify({ ...base, naturalPersonActive: true }))!.naturalPersonActive).toBe(true);
    expect(parsePayload(JSON.stringify({ ...base, naturalPersonActive: false }))!.naturalPersonActive).toBeUndefined();
    expect(parsePayload(JSON.stringify({ ...base, naturalPersonActive: 'yes' }))!.naturalPersonActive).toBeUndefined();
    expect(parsePayload(JSON.stringify({ ...base, naturalPersonActive: 1 }))!.naturalPersonActive).toBeUndefined();
  });

  it('mergePersonas ORs the flag — a remote activation propagates', () => {
    const result = mergePersonas({
      local: [], localTombstones: [], localRecordAt: 0,
      remote: { v: 1, personas: [], tombstones: [], naturalPersonActive: true },
      remoteCreatedAt: 100, mnemonic: null, deviceHeldKeys: true,
      localNaturalPersonActive: false, localNaturalPersonDisplayName: '',
    });
    expect(result.naturalPersonActive).toBe(true);
    expect(result.changed).toBe(true);
  });

  it('mergePersonas never lets an absent remote flag deactivate a local activation', () => {
    const result = mergePersonas({
      local: [], localTombstones: [], localRecordAt: 0,
      remote: { v: 1, personas: [], tombstones: [] },
      remoteCreatedAt: 100, mnemonic: null, deviceHeldKeys: true,
      localNaturalPersonActive: true, localNaturalPersonDisplayName: 'Alice',
    });
    expect(result.naturalPersonActive).toBe(true);
    expect(result.changed).toBe(false);
  });

  it('mergePersonas reports no change when both sides agree the slot is dormant', () => {
    const result = mergePersonas({
      local: [], localTombstones: [], localRecordAt: 0,
      remote: { v: 1, personas: [], tombstones: [] },
      remoteCreatedAt: 100, mnemonic: null, deviceHeldKeys: true,
      localNaturalPersonActive: false, localNaturalPersonDisplayName: '',
    });
    expect(result.naturalPersonActive).toBe(false);
    expect(result.changed).toBe(false);
  });

  it('isWireRicherThan fires when we hold the activation and the relay does not', () => {
    const merged = { v: 1 as const, personas: [], tombstones: [], naturalPersonActive: true as const };
    const remote = { v: 1 as const, personas: [], tombstones: [] };
    expect(isWireRicherThan(merged, remote)).toBe(true);
    expect(isWireRicherThan(remote, merged)).toBe(false);
  });
});

describe('naturalPersonDisplayName on the wire', () => {
  const wire = (over: Partial<SyncedPersonasPayload> = {}): SyncedPersonasPayload => ({
    v: 1, personas: [], tombstones: [], ...over,
  });

  it('toWire carries the real-identity name alongside the flag', () => {
    const payload = toWire(makeIdentity({ naturalPersonActive: true }));
    expect(payload.naturalPersonActive).toBe(true);
    expect(payload.naturalPersonDisplayName).toBe('Alice');
  });

  it('toWire omits the name for a dormant real identity', () => {
    const payload = toWire(makeIdentity({
      naturalPersonActive: false,
      naturalPerson: { publicKey: 'b'.repeat(64), privateKey: 'c'.repeat(64), displayName: 'Alice' },
    }));
    expect(payload.naturalPersonActive).toBeUndefined();
    expect(payload.naturalPersonDisplayName).toBeUndefined();
  });

  it('toWire omits the name when the slot is active but nameless', () => {
    const payload = toWire(makeIdentity({
      naturalPersonActive: true,
      naturalPerson: { publicKey: 'b'.repeat(64), privateKey: 'c'.repeat(64), displayName: '' },
    }));
    expect(payload.naturalPersonActive).toBe(true);
    expect(payload.naturalPersonDisplayName).toBeUndefined();
  });

  it('parsePayload accepts a sane name and sanitises control/bidi characters', () => {
    const base = { v: 1, personas: [], tombstones: [], naturalPersonActive: true };
    expect(parsePayload(JSON.stringify({ ...base, naturalPersonDisplayName: '  Alice  ' }))!.naturalPersonDisplayName)
      .toBe('Alice');
    expect(parsePayload(JSON.stringify({ ...base, naturalPersonDisplayName: 'Al‮ice' }))!.naturalPersonDisplayName)
      .toBe('Alice');
  });

  it('parsePayload drops a non-string, empty or over-long name', () => {
    const base = { v: 1, personas: [], tombstones: [], naturalPersonActive: true };
    expect(parsePayload(JSON.stringify({ ...base, naturalPersonDisplayName: 42 }))!.naturalPersonDisplayName).toBeUndefined();
    expect(parsePayload(JSON.stringify({ ...base, naturalPersonDisplayName: '   ' }))!.naturalPersonDisplayName).toBeUndefined();
    expect(parsePayload(JSON.stringify({ ...base, naturalPersonDisplayName: 'a'.repeat(101) }))!.naturalPersonDisplayName).toBeUndefined();
    // Exactly at the cap survives.
    expect(parsePayload(JSON.stringify({ ...base, naturalPersonDisplayName: 'a'.repeat(100) }))!.naturalPersonDisplayName)
      .toBe('a'.repeat(100));
  });

  it('parsePayload drops a name carried without the activation flag', () => {
    const parsed = parsePayload(JSON.stringify({ v: 1, personas: [], tombstones: [], naturalPersonDisplayName: 'Alice' }));
    expect(parsed!.naturalPersonActive).toBeUndefined();
    expect(parsed!.naturalPersonDisplayName).toBeUndefined();
  });

  it('mergePersonas adopts the remote name when the local real identity is nameless', () => {
    const result = mergePersonas({
      local: [], localTombstones: [], localRecordAt: 0,
      remote: wire({ naturalPersonActive: true, naturalPersonDisplayName: 'Alice' }),
      remoteCreatedAt: 100, mnemonic: null, deviceHeldKeys: true,
      localNaturalPersonActive: false, localNaturalPersonDisplayName: '',
    });
    expect(result.naturalPersonActive).toBe(true);
    expect(result.naturalPersonDisplayName).toBe('Alice');
    expect(result.changed).toBe(true);
  });

  it('mergePersonas never overwrites a non-empty local real-identity name', () => {
    const result = mergePersonas({
      local: [], localTombstones: [], localRecordAt: 0,
      remote: wire({ naturalPersonActive: true, naturalPersonDisplayName: 'Someone Else' }),
      remoteCreatedAt: 100, mnemonic: null, deviceHeldKeys: true,
      localNaturalPersonActive: true, localNaturalPersonDisplayName: 'Alice',
    });
    expect(result.naturalPersonDisplayName).toBeUndefined();
    expect(result.changed).toBe(false);
  });

  it('mergePersonas adopts nothing when the remote activation carries no name', () => {
    const result = mergePersonas({
      local: [], localTombstones: [], localRecordAt: 0,
      remote: wire({ naturalPersonActive: true }),
      remoteCreatedAt: 100, mnemonic: null, deviceHeldKeys: true,
      localNaturalPersonActive: false, localNaturalPersonDisplayName: '',
    });
    expect(result.naturalPersonActive).toBe(true);
    expect(result.naturalPersonDisplayName).toBeUndefined();
  });

  it('isWireRicherThan counts a name we hold and the relay does not', () => {
    const named = wire({ naturalPersonActive: true, naturalPersonDisplayName: 'Alice' });
    const nameless = wire({ naturalPersonActive: true });
    expect(isWireRicherThan(named, nameless)).toBe(true);
    // The reverse must NOT count — publishing then would strip the relay's name.
    expect(isWireRicherThan(nameless, named)).toBe(false);
  });
});
