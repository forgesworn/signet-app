import { describe, it, expect, vi, beforeEach } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'signet-protocol';

// Per-relay transport mock, same shape as sync-relays.test.ts. Events are REAL
// signed events so the signature check runs unmocked.
const relayMock = vi.hoisted(() => ({
  fetchReturns: {} as Record<string, unknown[]>,
  connectThrows: new Set<string>(),
  hangs: new Set<string>(),
  queried: [] as string[],
}));
vi.mock('signet-protocol', async () => {
  const actual = await vi.importActual<typeof import('signet-protocol')>('signet-protocol');
  return {
    ...actual,
    RelayClient: class MockRelayClient {
      url: string;
      constructor(url: string) { this.url = url; }
      async connect(): Promise<void> {
        relayMock.queried.push(this.url);
        if (relayMock.connectThrows.has(this.url)) throw new Error('connect failed');
        if (relayMock.hangs.has(this.url)) await new Promise(() => {});
      }
      async fetch(): Promise<unknown[]> { return relayMock.fetchReturns[this.url] ?? []; }
      disconnect(): void {}
    },
  };
});

import { fetchExistingProfile, buildMatchSeed, PROFILE_LOOKUP_RELAYS } from './existing-profile';

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const A = 'wss://a.example';
const B = 'wss://b.example';

function kind0(content: object | string, createdAt: number, key = sk, tags: string[][] = []): NostrEvent {
  return finalizeEvent(
    { kind: 0, created_at: createdAt, tags, content: typeof content === 'string' ? content : JSON.stringify(content) },
    key,
  ) as unknown as NostrEvent;
}

beforeEach(() => {
  relayMock.fetchReturns = {};
  relayMock.connectThrows = new Set();
  relayMock.hangs = new Set();
  relayMock.queried = [];
});

describe('fetchExistingProfile', () => {
  it('queries the caller\'s relays plus the lookup relays, deduped and validated', async () => {
    await fetchExistingProfile(pk, [A, A, 'ws://evil.example', 'not a url', PROFILE_LOOKUP_RELAYS[0]]);
    expect(relayMock.queried.sort()).toEqual([A, ...PROFILE_LOOKUP_RELAYS].sort());
  });

  it('can be restricted to exactly the given relays (dev relay)', async () => {
    await fetchExistingProfile(pk, ['ws://localhost:7777'], 500, { includeLookupRelays: false });
    expect(relayMock.queried).toEqual(['ws://localhost:7777']);
  });

  it('newest created_at wins across relays', async () => {
    relayMock.fetchReturns[A] = [kind0({ name: 'old' }, 100)];
    relayMock.fetchReturns[B] = [kind0({ name: 'new', about: 'hello' }, 200, sk, [['client', 'x']])];
    const r = await fetchExistingProfile(pk, [A, B]);
    expect(r).not.toBeNull();
    expect(r).not.toBe('unreachable');
    if (r && r !== 'unreachable') {
      expect(r.profile.displayName).toBe('new');
      expect(r.event.created_at).toBe(200);
      expect(r.base?.tags).toEqual([['client', 'x']]);
      expect(r.base?.content).toBe(r.event.content);
      expect(r.relay).toBe(B);
    }
  });

  it('breaks a created_at tie with the lowest id', async () => {
    const e1 = kind0({ name: 'one' }, 300);
    const e2 = kind0({ name: 'two' }, 300);
    relayMock.fetchReturns[A] = [e1, e2];
    const r = await fetchExistingProfile(pk, [A]);
    const lowest = e1.id < e2.id ? e1 : e2;
    expect(r && r !== 'unreachable' && r.event.id).toBe(lowest.id);
  });

  it('drops events authored by someone else even if they are newer and validly signed', async () => {
    const stranger = generateSecretKey();
    relayMock.fetchReturns[A] = [kind0({ name: 'stranger' }, 999, stranger), kind0({ name: 'mine' }, 100)];
    const r = await fetchExistingProfile(pk, [A]);
    expect(r && r !== 'unreachable' && r.profile.displayName).toBe('mine');
  });

  it('drops an event with a bad signature and falls back to the older valid one', async () => {
    const forged = kind0({ name: 'forged' }, 900);
    // Round-trip through JSON like a relay would deliver it (nostr-tools caches a
    // "verified" mark on the object finalizeEvent returns), then change the content.
    const tampered = { ...JSON.parse(JSON.stringify(forged)), content: JSON.stringify({ name: 'tampered' }) } as NostrEvent;
    relayMock.fetchReturns[A] = [tampered];
    relayMock.fetchReturns[B] = [kind0({ name: 'genuine' }, 100)];
    const r = await fetchExistingProfile(pk, [A, B]);
    expect(r && r !== 'unreachable' && r.profile.displayName).toBe('genuine');
  });

  it('drops non-kind-0 events', async () => {
    const note = finalizeEvent({ kind: 1, created_at: 500, tags: [], content: '{"name":"note"}' }, sk) as unknown as NostrEvent;
    relayMock.fetchReturns[A] = [note];
    expect(await fetchExistingProfile(pk, [A])).toBeNull();
  });

  it('returns null when relays answered but nothing usable was found', async () => {
    expect(await fetchExistingProfile(pk, [A])).toBeNull();
  });

  it('returns null when the newest valid event is not a JSON object', async () => {
    relayMock.fetchReturns[A] = [kind0('[1,2,3]', 200), kind0({ name: 'older' }, 100)];
    expect(await fetchExistingProfile(pk, [A])).toBeNull();
  });

  it('returns "unreachable" only when no relay could be reached at all', async () => {
    const all = [A, ...PROFILE_LOOKUP_RELAYS];
    relayMock.connectThrows = new Set(all);
    expect(await fetchExistingProfile(pk, [A])).toBe('unreachable');
    // One relay answering (even empty) is "reachable but nothing found".
    relayMock.connectThrows = new Set(all.filter(u => u !== A));
    expect(await fetchExistingProfile(pk, [A])).toBeNull();
  });

  it('a relay that never connects times out instead of hanging the lookup', async () => {
    relayMock.hangs = new Set([A]);
    relayMock.fetchReturns[B] = [kind0({ name: 'from b' }, 100)];
    const r = await fetchExistingProfile(pk, [A, B], 150);
    expect(r && r !== 'unreachable' && r.profile.displayName).toBe('from b');
  });

  it('prefers a caller relay over a lookup relay when attributing the winning event', async () => {
    const ev = kind0({ name: 'same' }, 100);
    relayMock.fetchReturns[PROFILE_LOOKUP_RELAYS[0]] = [ev];
    relayMock.fetchReturns[A] = [ev];
    const r = await fetchExistingProfile(pk, [A]);
    expect(r && r !== 'unreachable' && r.relay).toBe(A);
  });

  it('rejects a malformed pubkey without touching any relay', async () => {
    expect(await fetchExistingProfile('nope', [A])).toBeNull();
    expect(relayMock.queried).toEqual([]);
  });
});

describe('buildMatchSeed', () => {
  it('seeds the card, the already-published state, and a matched base', async () => {
    relayMock.fetchReturns[A] = [kind0({ name: 'handle', display_name: 'Alice', about: 'hi\nthere', website: 'https://x.example' }, 777)];
    const found = await fetchExistingProfile(pk, [A]);
    if (!found || found === 'unreachable') throw new Error('expected a profile');
    const seed = buildMatchSeed(found, ' Alice B ');
    expect(seed.config).toMatchObject({ displayName: 'Alice B', about: 'hi\nthere', website: 'https://x.example' });
    expect(seed.state).toMatchObject({ enabled: true, lastEventId: found.event.id, lastPublishedAt: 777, lastPublishedRelay: A });
    expect(seed.state.lastPublishedContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(seed.base).toMatchObject({ eventId: found.event.id, createdAt: 777, content: found.event.content, matched: true });
  });
});
