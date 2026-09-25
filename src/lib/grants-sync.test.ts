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

import { mergeGrantLists, publishGrantsSync, fetchGrantsSync } from './grants-sync';
import type { RememberedGrant, GrantSchedule } from '../types';

const DEP = 'a'.repeat(64);
const DEP2 = 'b'.repeat(64);

function grant(overrides: Partial<RememberedGrant> = {}): RememberedGrant {
  return {
    dependantId: DEP,
    scope: 'sign-in',
    origin: 'https://roblox.com',
    decision: 'allow',
    decidedAt: 100,
    ...overrides,
  };
}

describe('mergeGrantLists', () => {
  it('adds remote-only records to the merged list', () => {
    const local: RememberedGrant[] = [];
    const remote = [grant()];
    const { merged, toSave } = mergeGrantLists(local, remote);
    expect(merged).toHaveLength(1);
    expect(toSave).toHaveLength(1);
    expect(merged[0].origin).toBe('https://roblox.com');
  });

  it('keeps local-only records', () => {
    const local = [grant()];
    const { merged, toSave } = mergeGrantLists(local, []);
    expect(merged).toHaveLength(1);
    expect(toSave).toHaveLength(0);
  });

  it('picks the newer decidedAt on conflict', () => {
    const local = [grant({ decidedAt: 100, decision: 'deny' })];
    const remote = [grant({ decidedAt: 200, decision: 'allow' })];
    const { merged, toSave } = mergeGrantLists(local, remote);
    expect(merged[0].decision).toBe('allow');
    expect(toSave).toHaveLength(1);
  });

  it('keeps local when local is newer', () => {
    const local = [grant({ decidedAt: 200, decision: 'allow' })];
    const remote = [grant({ decidedAt: 100, decision: 'deny' })];
    const { merged, toSave } = mergeGrantLists(local, remote);
    expect(merged[0].decision).toBe('allow');
    expect(toSave).toHaveLength(0);
  });

  it('treats a tombstone as newer than an older allow', () => {
    const local = [grant({ decidedAt: 100, decision: 'allow' })];
    const remote = [grant({ decidedAt: 100, decision: 'allow', tombstonedAt: 150 })];
    const { merged } = mergeGrantLists(local, remote);
    expect(merged[0].tombstonedAt).toBe(150);
  });

  it('lets a fresh allow supersede an older tombstone', () => {
    // Re-adding an origin after revoking it: the new allow has a higher
    // decidedAt than the tombstonedAt, so it wins.
    const local = [grant({ decidedAt: 100, tombstonedAt: 150 })];
    const remote = [grant({ decidedAt: 200, decision: 'allow' })];
    const { merged } = mergeGrantLists(local, remote);
    expect(merged[0].tombstonedAt).toBeUndefined();
    expect(merged[0].decidedAt).toBe(200);
  });

  it('breaks ties in favour of the tombstone', () => {
    // Same effective time — tombstone wins as the safer default.
    const local = [grant({ decidedAt: 100, decision: 'allow' })];
    const remote = [grant({ decidedAt: 100, decision: 'allow', tombstonedAt: 100 })];
    const { merged } = mergeGrantLists(local, remote);
    expect(merged[0].tombstonedAt).toBe(100);
  });

  it('handles multiple distinct keys independently', () => {
    const local = [
      grant({ origin: 'https://a.com', decidedAt: 100 }),
      grant({ dependantId: DEP2, origin: 'https://b.com', decidedAt: 50 }),
    ];
    const remote = [
      grant({ origin: 'https://a.com', decidedAt: 200 }), // newer, should win
      grant({ dependantId: DEP2, origin: 'https://c.com', decidedAt: 300 }), // new key
    ];
    const { merged, toSave } = mergeGrantLists(local, remote);
    expect(merged).toHaveLength(3);
    expect(toSave).toHaveLength(2); // a.com update + c.com new
  });

  it('keys on scope, not just origin (a sign-in for roblox.com !== dm-private for roblox.com)', () => {
    const local = [grant({ scope: 'sign-in', origin: 'https://roblox.com' })];
    const remote = [grant({ scope: 'dm-private', origin: 'https://roblox.com' })];
    const { merged } = mergeGrantLists(local, remote);
    expect(merged).toHaveLength(2);
  });

  it('keys on dependantId (same origin for two children stays separate)', () => {
    const local = [grant({ dependantId: DEP, origin: 'https://roblox.com' })];
    const remote = [grant({ dependantId: DEP2, origin: 'https://roblox.com' })];
    const { merged } = mergeGrantLists(local, remote);
    expect(merged).toHaveLength(2);
  });

  it('preserves optional fields through a merge', () => {
    const remote = [grant({
      decidedAt: 200,
      expiresAt: 999,
      lastUsedAt: 150,
    })];
    const { merged } = mergeGrantLists([], remote);
    expect(merged[0].expiresAt).toBe(999);
    expect(merged[0].lastUsedAt).toBe(150);
  });

  describe('schedule LWW (Charter clause #1, phase 3 sync)', () => {
    function schedule(issuedAt: number, hour: string = '16:00'): GrantSchedule {
      return {
        v: 1,
        tz: 'Europe/London',
        weekly: { fri: [{ start: hour, end: '20:00' }] },
        issuedAt,
      };
    }

    it('preserves local schedule when remote wins on decidedAt but has no schedule', () => {
      const local = [grant({ decidedAt: 100, schedule: schedule(500) })];
      const remote = [grant({ decidedAt: 200 })];
      const { merged, toSave } = mergeGrantLists(local, remote);
      expect(merged[0].decidedAt).toBe(200);
      expect(merged[0].schedule).toBeDefined();
      expect(merged[0].schedule!.issuedAt).toBe(500);
      expect(toSave).toHaveLength(1);
    });

    it('preserves local schedule when remote tombstones on tie-break', () => {
      const local = [grant({ decidedAt: 100, schedule: schedule(500) })];
      const remote = [grant({ decidedAt: 100, tombstonedAt: 100 })];
      const { merged } = mergeGrantLists(local, remote);
      expect(merged[0].tombstonedAt).toBe(100);
      expect(merged[0].schedule).toBeDefined();
    });

    it('takes remote schedule when remote.issuedAt is newer (independent of decidedAt)', () => {
      // Local grant is newer (decidedAt) but remote has a fresher schedule.
      // Schedule LWW is independent — take both: local grant + remote schedule.
      const local = [grant({ decidedAt: 200, schedule: schedule(100) })];
      const remote = [grant({ decidedAt: 100, schedule: schedule(500) })];
      const { merged, toSave } = mergeGrantLists(local, remote);
      expect(merged[0].decidedAt).toBe(200); // local won grant
      expect(merged[0].schedule!.issuedAt).toBe(500); // remote schedule is fresher
      expect(toSave).toHaveLength(1); // schedule changed locally
    });

    it('keeps local schedule when local.issuedAt is newer (no save needed)', () => {
      const local = [grant({ decidedAt: 100, schedule: schedule(500) })];
      const remote = [grant({ decidedAt: 100, schedule: schedule(100) })];
      const { merged, toSave } = mergeGrantLists(local, remote);
      expect(merged[0].schedule!.issuedAt).toBe(500);
      expect(toSave).toHaveLength(0); // no change
    });

    it('remote schedule wins on issuedAt tie (matches the merge\'s remote-on-tie posture)', () => {
      const local = [grant({ decidedAt: 100, schedule: schedule(500, '14:00') })];
      const remote = [grant({ decidedAt: 100, schedule: schedule(500, '16:00') })];
      const { merged } = mergeGrantLists(local, remote);
      expect(merged[0].schedule!.weekly.fri![0].start).toBe('16:00');
    });

    it('remote-only grant brings its schedule along', () => {
      const remote = [grant({ schedule: schedule(500) })];
      const { merged } = mergeGrantLists([], remote);
      expect(merged[0].schedule).toBeDefined();
      expect(merged[0].schedule!.issuedAt).toBe(500);
    });

    it('remote grant wins + remote has newer schedule = both updates take effect', () => {
      const local = [grant({ decidedAt: 100, schedule: schedule(100) })];
      const remote = [grant({ decidedAt: 200, schedule: schedule(500) })];
      const { merged, toSave } = mergeGrantLists(local, remote);
      expect(merged[0].decidedAt).toBe(200);
      expect(merged[0].schedule!.issuedAt).toBe(500);
      expect(toSave).toHaveLength(1);
    });

    it('does not invent a schedule when neither side has one', () => {
      const local = [grant({ decidedAt: 100 })];
      const remote = [grant({ decidedAt: 200 })];
      const { merged } = mergeGrantLists(local, remote);
      expect(merged[0].schedule).toBeUndefined();
    });
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

describe('publishGrantsSync — relay pool', () => {
  it('returns true when one of two relays accepts the publish', async () => {
    relayMock.publishOk = { 'wss://a.example': false, 'wss://b.example': true };
    const backend = makeSyncBackend();
    const ok = await publishGrantsSync([grant()], backend, ['wss://a.example', 'wss://b.example']);
    expect(ok).toBe(true);
    expect(relayMock.published.map(p => p.url).sort()).toEqual(['wss://a.example', 'wss://b.example']);
  });

  it('never publishes an information-free record (empty payload)', async () => {
    relayMock.published = [];
    const backend = makeSyncBackend();
    const ok = await publishGrantsSync([], backend, ['wss://a.example', 'wss://b.example']);
    expect(ok).toBe(false);
    expect(relayMock.published).toEqual([]);
  });
});

describe('fetchGrantsSync — relay pool', () => {
  const AUTHOR = 'a'.repeat(64);

  it('dedupes events across two relays and picks the newest', async () => {
    const payload = JSON.stringify({ v: 1, grants: [] });
    relayMock.fetchReturns = {
      'wss://a.example': [{ id: '1'.repeat(64), created_at: 1000, content: fakeNip44(payload) }],
      'wss://b.example': [{ id: '2'.repeat(64), created_at: 2000, content: fakeNip44(payload) }],
    };
    const backend = makeSyncBackend({ activePublicKeyHex: AUTHOR });
    const result = await fetchGrantsSync(AUTHOR, backend, ['wss://a.example', 'wss://b.example']);
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
    const result = await fetchGrantsSync(AUTHOR, backend, ['wss://a.example', 'wss://b.example']);
    expect(result).toBe('unreachable');
  });
});
