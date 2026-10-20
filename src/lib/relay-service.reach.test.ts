import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from 'signet-protocol';

type Behaviour = 'answers' | 'silent' | 'refuses-connect';
const behaviours = new Map<string, Behaviour>();
const stored: NostrEvent[] = [];

vi.mock('signet-protocol', async importOriginal => {
  const actual = await importOriginal<typeof import('signet-protocol')>();
  class FakeRelayClient {
    private state: 'disconnected' | 'connected' = 'disconnected';
    constructor(private url: string) {}
    getState() { return this.state; }
    async connect() {
      if (behaviours.get(this.url) === 'refuses-connect') throw new Error('connection refused');
      this.state = 'connected';
    }
    disconnect() { this.state = 'disconnected'; }
    subscribe(_f: unknown, onEvent: (e: NostrEvent) => void, onEose?: () => void) {
      if (behaviours.get(this.url) === 'answers') {
        queueMicrotask(() => { for (const e of stored) onEvent(e); onEose?.(); });
      }
      return 'sub-1';
    }
    closeSubscription() {}
  }
  return { ...actual, RelayClient: FakeRelayClient };
});

const ev = (id: string): NostrEvent => ({ id, pubkey: 'a'.repeat(64), created_at: 1, kind: 1, tags: [], content: '', sig: 'b'.repeat(128) });
const A = 'wss://relay-a.example';
const B = 'wss://relay-b.example';

async function fresh() {
  vi.resetModules();
  return import('./relay-service');
}

beforeEach(() => { behaviours.clear(); stored.length = 0; });

describe('fetchEventsWithReach', () => {
  it('counts every relay that answers and dedupes events', async () => {
    behaviours.set(A, 'answers'); behaviours.set(B, 'answers');
    stored.push(ev('1'.repeat(64)));
    const rs = await fresh();
    const r = await rs.fetchEventsWithReach([{ kinds: [1] }], { relays: [A, B], timeoutMs: 200 });
    expect(r).toMatchObject({ attempted: 2, reached: 2 });
    expect(r.events).toHaveLength(1);
  });

  it('does not count a relay that times out without EOSE', async () => {
    behaviours.set(A, 'answers'); behaviours.set(B, 'silent');
    stored.push(ev('2'.repeat(64)));
    const rs = await fresh();
    const r = await rs.fetchEventsWithReach([{ kinds: [1] }], { relays: [A, B], timeoutMs: 50 });
    expect(r).toMatchObject({ attempted: 2, reached: 1 });
    expect(r.events).toHaveLength(1);
  });

  it('reports zero reached when every relay fails to connect or stays silent', async () => {
    behaviours.set(A, 'refuses-connect'); behaviours.set(B, 'silent');
    const rs = await fresh();
    const r = await rs.fetchEventsWithReach([{ kinds: [1] }], { relays: [A, B], timeoutMs: 50 });
    expect(r).toEqual({ events: [], attempted: 2, reached: 0 });
  });

  it('reports nothing attempted when no relay URL is valid', async () => {
    const rs = await fresh();
    const r = await rs.fetchEventsWithReach([{ kinds: [1] }], { relays: ['http://nope.example'] });
    expect(r).toEqual({ events: [], attempted: 0, reached: 0 });
  });
});
