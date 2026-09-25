import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  published: [] as Array<{ url: string; id: string }>,
  fetchReturns: {} as Record<string, Array<{ id: string }>>,
}));

vi.mock('signet-protocol', () => {
  class FakeRelayClient {
    url: string;
    state: 'connected' | 'disconnected' = 'disconnected';
    stateCallback: ((s: string) => void) | null = null;
    constructor(url: string) { this.url = url; }
    async connect() { this.state = 'connected'; }
    disconnect() { this.state = 'disconnected'; }
    getState() { return this.state; }
    async publish(ev: { id: string }) { hoisted.published.push({ url: this.url, id: ev.id }); return { ok: true, message: '' }; }
    async fetch() { return hoisted.fetchReturns[this.url] ?? []; }
    // Single-slot by design — matches the real signet-protocol client this
    // mock stands in for (M8's whole premise: only one listener at a time).
    onStateChanged(cb: (s: string) => void) { this.stateCallback = cb; }
    emitState(s: string) { this.stateCallback?.(s); }
  }
  return { RelayClient: FakeRelayClient };
});

async function freshPool() {
  vi.resetModules();
  return await import('./relay-service');
}

beforeEach(() => { hoisted.published.length = 0; hoisted.fetchReturns = {}; });

describe('publishEvent fan-out', () => {
  it('publishes only to enabled+write relays', async () => {
    const rs = await freshPool();
    rs.setRelays([
      { url: 'wss://w1.example', enabled: true, read: true, write: true },
      { url: 'wss://readonly.example', enabled: true, read: true, write: false },
      { url: 'wss://off.example', enabled: false, read: true, write: true },
    ]);
    const res = await rs.publishEvent({ id: 'abc' } as never);
    expect(res.ok).toBe(true);
    expect(hoisted.published.map(p => p.url).sort()).toEqual(['wss://w1.example']);
  });

  it('ok=false when no write relay is configured', async () => {
    const rs = await freshPool();
    rs.setRelays([{ url: 'wss://readonly.example', enabled: true, read: true, write: false }]);
    const res = await rs.publishEvent({ id: 'abc' } as never);
    expect(res.ok).toBe(false);
  });
});

describe('fetchEvents fan-out', () => {
  it('merges + dedupes by id across enabled+read relays', async () => {
    const rs = await freshPool();
    rs.setRelays([
      { url: 'wss://r1.example', enabled: true, read: true, write: true },
      { url: 'wss://r2.example', enabled: true, read: true, write: true },
      { url: 'wss://nowrite-noread.example', enabled: false, read: true, write: true },
    ]);
    hoisted.fetchReturns['wss://r1.example'] = [{ id: 'x' }, { id: 'y' }];
    hoisted.fetchReturns['wss://r2.example'] = [{ id: 'y' }, { id: 'z' }];
    const events = await rs.fetchEvents([{ kinds: [0] }] as never);
    expect((events as Array<{ id: string }>).map(e => e.id).sort()).toEqual(['x', 'y', 'z']);
  });
});

// ── C2: targeted publish/fetch via opts.relays ───────────────────────────────

describe('publishEvent targeted relays (C2)', () => {
  it('publishes ONLY to the explicit relays list, ignoring the configured pool', async () => {
    const rs = await freshPool();
    rs.setRelays([
      { url: 'wss://pool-a.example', enabled: true, read: true, write: true },
      { url: 'wss://pool-b.example', enabled: true, read: true, write: true },
    ]);
    const res = await rs.publishEvent({ id: 'abc' } as never, { relays: ['wss://target-only.example'] });
    expect(res.ok).toBe(true);
    expect(hoisted.published.map(p => p.url)).toEqual(['wss://target-only.example']);
  });

  it('targets a relay outside the configured pool (retraction scenario)', async () => {
    const rs = await freshPool();
    rs.setRelays([{ url: 'wss://current-preference.example', enabled: true, read: true, write: true }]);
    // lastPublishedRelay differs from preferences.relayUrl — the whole point
    // of C2: retraction must reach the relay the ORIGINAL event lives on.
    const res = await rs.publishEvent({ id: 'del' } as never, { relays: ['wss://old-relay-it-was-published-to.example'] });
    expect(res.ok).toBe(true);
    expect(hoisted.published.map(p => p.url)).toEqual(['wss://old-relay-it-was-published-to.example']);
  });

  it('creates a client for a targeted relay even when absent from the pool', async () => {
    const rs = await freshPool();
    rs.setRelays([]); // empty pool entirely
    const res = await rs.publishEvent({ id: 'xyz' } as never, { relays: ['wss://not-in-pool.example'] });
    expect(res.ok).toBe(true);
  });

  it('falls back to the pool when relays option is omitted (backward compat)', async () => {
    const rs = await freshPool();
    rs.setRelays([{ url: 'wss://pool-only.example', enabled: true, read: true, write: true }]);
    const res = await rs.publishEvent({ id: 'abc' } as never);
    expect(res.ok).toBe(true);
    expect(hoisted.published.map(p => p.url)).toEqual(['wss://pool-only.example']);
  });

  it('falls back to the pool when relays is an empty array', async () => {
    const rs = await freshPool();
    rs.setRelays([{ url: 'wss://pool-only.example', enabled: true, read: true, write: true }]);
    const res = await rs.publishEvent({ id: 'abc' } as never, { relays: [] });
    expect(res.ok).toBe(true);
    expect(hoisted.published.map(p => p.url)).toEqual(['wss://pool-only.example']);
  });

  it('drops malformed URLs from an explicit relays list', async () => {
    const rs = await freshPool();
    const res = await rs.publishEvent({ id: 'abc' } as never, { relays: ['not-a-relay-url'] });
    expect(res.ok).toBe(false);
  });
});

describe('fetchEvents targeted relays (C2)', () => {
  it('fetches ONLY from the explicit relays list, ignoring the configured pool', async () => {
    const rs = await freshPool();
    rs.setRelays([{ url: 'wss://pool-a.example', enabled: true, read: true, write: true }]);
    hoisted.fetchReturns['wss://pool-a.example'] = [{ id: 'from-pool' }];
    hoisted.fetchReturns['wss://target-only.example'] = [{ id: 'from-target' }];
    const events = await rs.fetchEvents([{ kinds: [0] }] as never, { relays: ['wss://target-only.example'] });
    expect((events as Array<{ id: string }>).map(e => e.id)).toEqual(['from-target']);
  });
});

// ── M8: addStateListener fan-out multiplexer ──────────────────────────────
// The underlying RelayClient.onStateChanged is single-slot (FakeRelayClient
// above deliberately mirrors that) — addStateListener must fan a single
// underlying registration out to every locally-registered listener, and
// unsubscribe must remove only that one listener.

describe('addStateListener (M8)', () => {
  it('fans a single underlying state change out to multiple listeners', async () => {
    const rs = await freshPool();
    rs.setRelays([{ url: 'wss://mux.example', enabled: true, read: true, write: true }]);

    const seenA: string[] = [];
    const seenB: string[] = [];
    rs.addStateListener((s: string) => seenA.push(s));
    rs.addStateListener((s: string) => seenB.push(s));

    const client = rs.getRelayClient() as unknown as { emitState: (s: string) => void };
    client.emitState('connecting');
    client.emitState('connected');

    expect(seenA).toEqual(['connecting', 'connected']);
    expect(seenB).toEqual(['connecting', 'connected']);
  });

  it('unsubscribe removes only that listener', async () => {
    const rs = await freshPool();
    rs.setRelays([{ url: 'wss://mux.example', enabled: true, read: true, write: true }]);

    const seenA: string[] = [];
    const seenB: string[] = [];
    const unsubA = rs.addStateListener((s: string) => seenA.push(s));
    rs.addStateListener((s: string) => seenB.push(s));

    const client = rs.getRelayClient() as unknown as { emitState: (s: string) => void };
    client.emitState('connecting');
    unsubA();
    client.emitState('connected');

    expect(seenA).toEqual(['connecting']); // stopped after unsubscribe
    expect(seenB).toEqual(['connecting', 'connected']); // unaffected
  });

  it('re-binds to the new primary client when the relay set changes', async () => {
    const rs = await freshPool();
    rs.setRelays([{ url: 'wss://relay-a.example', enabled: true, read: true, write: true }]);

    const seen: string[] = [];
    rs.addStateListener((s: string) => seen.push(s));

    const clientA = rs.getRelayClient() as unknown as { emitState: (s: string) => void };
    clientA.emitState('connected');

    // Switch primary to a different relay — a NEW underlying client instance.
    rs.setRelays([{ url: 'wss://relay-b.example', enabled: true, read: true, write: true }]);
    const clientB = rs.getRelayClient() as unknown as { emitState: (s: string) => void };
    expect(clientB).not.toBe(clientA as unknown);
    clientB.emitState('connecting');

    expect(seen).toEqual(['connected', 'connecting']);
  });
});
