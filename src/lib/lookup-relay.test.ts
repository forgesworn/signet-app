import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchFromRelay } from './lookup-relay';
import { parseFollowList } from './nostr-follows';

// Minimal fake WebSocket: tests drive open/message/error by hand.
class FakeSocket {
  static instances: FakeSocket[] = [];
  url: string;
  sent: unknown[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(url: string) { this.url = url; FakeSocket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; }
  open() { this.onopen?.(); }
  deliver(msg: unknown) { this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) }); }
}

const HEX = 'a'.repeat(64);
const SIG = 'b'.repeat(128);
const sock = () => FakeSocket.instances[FakeSocket.instances.length - 1];
const subId = () => (sock().sent[0] as unknown[])[1] as string;

function ev(over: Record<string, unknown> = {}) {
  return { id: HEX, pubkey: HEX, created_at: 1, kind: 3, tags: [], content: '', sig: SIG, ...over };
}
const FILTERS = [{ kinds: [3], authors: [HEX], limit: 5 }];

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchFromRelay', () => {
  it('sends a REQ with the filters on open', async () => {
    const p = fetchFromRelay('wss://r.example', FILTERS, 1000);
    sock().open();
    expect(sock().sent[0]).toEqual(['REQ', subId(), ...FILTERS]);
    sock().deliver(['EOSE', subId()]);
    await p;
  });

  it('REGRESSION: returns a kind 3 with 130 p tags (the protocol client dropped >100 tags)', async () => {
    const tags = Array.from({ length: 130 }, (_, i) => ['p', i.toString(16).padStart(64, '0')]);
    const p = fetchFromRelay('wss://r.example', FILTERS, 1000);
    sock().open();
    sock().deliver(['EVENT', subId(), ev({ tags })]);
    sock().deliver(['EOSE', subId()]);
    const events = await p;
    expect(events).toHaveLength(1);
    expect(events![0].tags).toHaveLength(130);
    const list = parseFollowList(events![0]);
    expect(list.follows).toHaveLength(130);
    expect(list.total).toBe(130);
  });

  it('EOSE with nothing resolves an empty array', async () => {
    const p = fetchFromRelay('wss://r.example', FILTERS, 1000);
    sock().open();
    sock().deliver(['EOSE', subId()]);
    expect(await p).toEqual([]);
  });

  it('CLOSED (e.g. rate-limited) resolves the array collected so far, not null', async () => {
    const p = fetchFromRelay('wss://r.example', FILTERS, 1000);
    sock().open();
    sock().deliver(['CLOSED', subId(), 'rate-limited: slow down']);
    expect(await p).toEqual([]);
  });

  it('a socket error resolves null', async () => {
    const p = fetchFromRelay('wss://r.example', FILTERS, 1000);
    sock().onerror?.();
    expect(await p).toBeNull();
    expect(sock().closed).toBe(true);
  });

  it('a constructor that throws resolves null', async () => {
    vi.stubGlobal('WebSocket', class { constructor() { throw new Error('bad url'); } });
    expect(await fetchFromRelay('wss://r.example', FILTERS, 1000)).toBeNull();
  });

  it('no answer before the timeout resolves null (even after the socket opened)', async () => {
    const p = fetchFromRelay('wss://r.example', FILTERS, 1000);
    sock().open();
    sock().deliver(['EVENT', subId(), ev()]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBeNull();
    expect(sock().closed).toBe(true);
  });

  it('a close before EOSE resolves null', async () => {
    const p = fetchFromRelay('wss://r.example', FILTERS, 1000);
    sock().open();
    sock().onclose?.();
    expect(await p).toBeNull();
  });

  it('drops other-subscription, malformed, oversized and over-tagged events', async () => {
    const p = fetchFromRelay('wss://r.example', FILTERS, 1000);
    sock().open();
    const s = subId();
    sock().deliver(['EVENT', 'someone-elses-sub', ev({ id: '1'.repeat(64) })]);
    sock().deliver('not json {');
    sock().deliver(['NOTICE', 'hello']);
    sock().deliver(['AUTH', 'challenge']);
    sock().deliver(['EVENT', s, 'nope']);
    sock().deliver(['EVENT', s, ev({ id: '2'.repeat(64), kind: '3' })]);
    sock().deliver(['EVENT', s, ev({ id: '3'.repeat(64), content: 'x'.repeat(65_537) })]);
    sock().deliver(['EVENT', s, ev({ id: '4'.repeat(64), tags: Array.from({ length: 5001 }, () => ['p', HEX]) })]);
    sock().deliver(['EVENT', s, ev({ id: '5'.repeat(64), tags: [['p', 'x'.repeat(1025)]] })]);
    sock().deliver(['EVENT', s, ev({ id: '6'.repeat(64), tags: ['p'] })]);
    sock().deliver(['EVENT', s, ev({ id: '7'.repeat(64), tags: [['p', 5]] })]);
    sock().deliver('x'.repeat(1_048_577));
    sock().deliver(['EVENT', s, ev({ id: '8'.repeat(64), tags: Array.from({ length: 5000 }, () => ['p', HEX]) })]);
    sock().deliver(['EOSE', s]);
    const events = await p;
    expect(events!.map(e => e.id)).toEqual(['8'.repeat(64)]);
  });

  it('stops collecting at 10,000 events', async () => {
    const p = fetchFromRelay('wss://r.example', FILTERS, 1000);
    sock().open();
    const s = subId();
    for (let i = 0; i < 10_001; i++) sock().deliver(['EVENT', s, ev({ id: i.toString(16).padStart(64, '0') })]);
    expect(await p).toHaveLength(10_000);
    expect(sock().closed).toBe(true);
  });

  describe('closes the socket and clears the timer on every path', () => {
    it('EOSE: sends CLOSE then closes', async () => {
      const p = fetchFromRelay('wss://r.example', FILTERS, 1000);
      sock().open();
      sock().deliver(['EOSE', subId()]);
      await p;
      expect(sock().closed).toBe(true);
      expect(sock().sent[1]).toEqual(['CLOSE', subId()]);
      expect(vi.getTimerCount()).toBe(0);
    });
    it('CLOSED', async () => {
      const p = fetchFromRelay('wss://r.example', FILTERS, 1000);
      sock().open();
      sock().deliver(['CLOSED', subId(), 'x']);
      await p;
      expect(sock().closed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
    it('error', async () => {
      const p = fetchFromRelay('wss://r.example', FILTERS, 1000);
      sock().onerror?.();
      await p;
      expect(sock().closed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
    it('timeout without ever opening', async () => {
      const p = fetchFromRelay('wss://r.example', FILTERS, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await p).toBeNull();
      expect(sock().closed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
