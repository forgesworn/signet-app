import { describe, it, expect, vi, beforeEach } from 'vitest';

// Relay transport mock for the `fetchNewestFromRelays` tests below — same
// per-URL shape as the rail test files, but seeded events carry an explicit
// `pubkey` so the author-pin behaviour is what's under test.
const relayMock = vi.hoisted(() => ({
  fetchReturns: {} as Record<string, Array<{ id: string; created_at: number; content: string; pubkey: string }>>,
  fetchThrows: new Set<string>(),
  published: [] as string[],
  afterConnect: async () => {},
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
        await relayMock.afterConnect();
      }
      async fetch(): Promise<Array<{ id: string; created_at: number; content: string; pubkey: string }>> {
        return relayMock.fetchReturns[this.url] ?? [];
      }
      async publish(): Promise<{ ok: boolean }> { relayMock.published.push(this.url); return { ok: true }; }
      disconnect(): void {}
    },
  };
});

beforeEach(() => {
  relayMock.fetchReturns = {};
  relayMock.published = []; relayMock.afterConnect = async () => {};
  relayMock.fetchThrows = new Set();
});

import type { RelayConfig } from '../types';
import { resolveSyncRelays, fetchNewestFromRelays, publishToRelays } from './sync-relays';

function relay(overrides: Partial<RelayConfig> & { url: string }): RelayConfig {
  return { enabled: true, read: true, write: true, ...overrides };
}

describe('resolveSyncRelays', () => {
  it('falls back to the given fallback when no relays are configured', () => {
    const result = resolveSyncRelays({}, 'wss://fallback.example');
    expect(result).toEqual({ read: ['wss://fallback.example'], write: ['wss://fallback.example'] });
  });

  it('falls back when relays is an empty array', () => {
    const result = resolveSyncRelays({ relays: [] }, 'wss://fallback.example');
    expect(result).toEqual({ read: ['wss://fallback.example'], write: ['wss://fallback.example'] });
  });

  it('filters entries by enabled / read / write independently', () => {
    const relays: RelayConfig[] = [
      relay({ url: 'wss://a.example', enabled: true, read: true, write: false }),
      relay({ url: 'wss://b.example', enabled: true, read: false, write: true }),
      relay({ url: 'wss://c.example', enabled: false, read: true, write: true }),
    ];
    const result = resolveSyncRelays({ relays }, 'wss://fallback.example');
    expect(result.read).toEqual(['wss://a.example']);
    expect(result.write).toEqual(['wss://b.example']);
  });

  it('drops invalid relay URLs (ws:// on a non-localhost host, http://)', () => {
    const relays: RelayConfig[] = [
      relay({ url: 'ws://evil.example' }),
      relay({ url: 'http://evil.example' }),
      relay({ url: 'wss://good.example' }),
      relay({ url: 'ws://localhost:4869' }),
    ];
    const result = resolveSyncRelays({ relays }, 'wss://fallback.example');
    expect(result.read).toEqual(['wss://good.example', 'ws://localhost:4869']);
    expect(result.write).toEqual(['wss://good.example', 'ws://localhost:4869']);
  });

  it('falls back to the fallback when every relay is disabled', () => {
    const relays: RelayConfig[] = [
      relay({ url: 'wss://a.example', enabled: false }),
      relay({ url: 'wss://b.example', enabled: false }),
    ];
    const result = resolveSyncRelays({ relays }, 'wss://fallback.example');
    expect(result).toEqual({ read: ['wss://fallback.example'], write: ['wss://fallback.example'] });
  });

  it('dedupes repeated URLs while preserving first-seen order', () => {
    const relays: RelayConfig[] = [
      relay({ url: 'wss://a.example' }),
      relay({ url: 'wss://b.example' }),
      relay({ url: 'wss://a.example' }),
    ];
    const result = resolveSyncRelays({ relays }, 'wss://fallback.example');
    expect(result.read).toEqual(['wss://a.example', 'wss://b.example']);
    expect(result.write).toEqual(['wss://a.example', 'wss://b.example']);
  });

  it('read and write pools can diverge independently and each falls back on their own', () => {
    const relays: RelayConfig[] = [
      relay({ url: 'wss://readonly.example', read: true, write: false }),
    ];
    const result = resolveSyncRelays({ relays }, 'wss://fallback.example');
    expect(result.read).toEqual(['wss://readonly.example']);
    expect(result.write).toEqual(['wss://fallback.example']);
  });

  it('uses relayUrl as the fallback ahead of the explicit fallback when relays is empty', () => {
    const result = resolveSyncRelays({ relayUrl: 'wss://legacy.example' }, 'wss://fallback.example');
    expect(result).toEqual({ read: ['wss://legacy.example'], write: ['wss://legacy.example'] });
  });

  it('uses relayUrl as the fallback ahead of the explicit fallback when every relay is disabled', () => {
    const relays: RelayConfig[] = [relay({ url: 'wss://a.example', enabled: false })];
    const result = resolveSyncRelays({ relays, relayUrl: 'wss://legacy.example' }, 'wss://fallback.example');
    expect(result).toEqual({ read: ['wss://legacy.example'], write: ['wss://legacy.example'] });
  });

  it('falls through to the explicit fallback when relayUrl is invalid', () => {
    const result = resolveSyncRelays({ relayUrl: 'http://bad.example' }, 'wss://fallback.example');
    expect(result).toEqual({ read: ['wss://fallback.example'], write: ['wss://fallback.example'] });
  });

  it('falls through to the explicit fallback when relayUrl is absent', () => {
    const result = resolveSyncRelays({}, 'wss://fallback.example');
    expect(result).toEqual({ read: ['wss://fallback.example'], write: ['wss://fallback.example'] });
  });
});

describe('fetchNewestFromRelays — author pin', () => {
  const AUTHOR = 'a'.repeat(64);
  const FOREIGN = 'b'.repeat(64);
  const filter = { kinds: [30078], authors: [AUTHOR], '#d': ['signet:personas'], limit: 1 };

  it('drops a newer foreign-author event so the own-author older one still wins', async () => {
    relayMock.fetchReturns = {
      'wss://a.example': [{ id: '1'.repeat(64), created_at: 1000, content: 'mine', pubkey: AUTHOR }],
      'wss://b.example': [{ id: '2'.repeat(64), created_at: 9000, content: 'theirs', pubkey: FOREIGN }],
    };
    const { event, reachableRelays } = await fetchNewestFromRelays(filter, ['wss://a.example', 'wss://b.example']);
    expect(reachableRelays).toBe(2);
    expect(event?.id).toBe('1'.repeat(64));
    expect(event?.content).toBe('mine');
  });

  it('matches the author case-insensitively', async () => {
    relayMock.fetchReturns = {
      'wss://a.example': [{ id: '3'.repeat(64), created_at: 1000, content: 'mine', pubkey: AUTHOR.toUpperCase() }],
    };
    const { event } = await fetchNewestFromRelays({ ...filter, authors: [AUTHOR] }, ['wss://a.example']);
    expect(event?.id).toBe('3'.repeat(64));
  });

  it('drops an event with no pubkey at all (malformed)', async () => {
    relayMock.fetchReturns = {
      'wss://a.example': [{ id: '4'.repeat(64), created_at: 1000, content: 'x' } as never],
    };
    const { event, reachableRelays } = await fetchNewestFromRelays(filter, ['wss://a.example']);
    expect(reachableRelays).toBe(1);
    expect(event).toBeNull();
  });

  it('honours an explicit authorPubkey argument over the filter', async () => {
    relayMock.fetchReturns = {
      'wss://a.example': [
        { id: '5'.repeat(64), created_at: 1000, content: 'mine', pubkey: AUTHOR },
        { id: '6'.repeat(64), created_at: 5000, content: 'theirs', pubkey: FOREIGN },
      ],
    };
    const { event } = await fetchNewestFromRelays({ ...filter, authors: undefined }, ['wss://a.example'], AUTHOR);
    expect(event?.id).toBe('5'.repeat(64));
  });
});


it('checks guarded publication after connecting and refuses a session that ends during the guard', async () => {
  let connected = false, current = true;
  relayMock.afterConnect = async () => { connected = true; };
  const beforeSend = vi.fn(async () => { expect(connected).toBe(true); current = false; });
  expect(await publishToRelays({} as import('signet-protocol').NostrEvent, ['wss://relay.example'], { beforeSend, isCurrent: () => current })).toBe(false);
  expect(beforeSend).toHaveBeenCalledOnce(); expect(relayMock.published).toEqual([]);
  expect(await publishToRelays({} as import('signet-protocol').NostrEvent, ['wss://relay.example'], {
    beforeSend: async () => { throw new Error('Consent withdrawn'); }, isCurrent: () => true,
  })).toBe(false);
  expect(relayMock.published).toEqual([]);
});
