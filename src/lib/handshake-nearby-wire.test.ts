import { describe, expect, it } from 'vitest';
import { NearbyLink, NEARBY_MAX_FRAME, nearbyEventFrame, nearbyHello, nearbyLinkKey, nearbyToken, readNearbyEvent, type NearbyStep } from './handshake-nearby-wire';

const SECRET = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const nonce = (n: number) => new Uint8Array(16).fill(n);
const event = (over: Record<string, unknown> = {}) => ({
  id: '1'.repeat(64), pubkey: '2'.repeat(64), sig: '3'.repeat(128), kind: 1059, created_at: 1700000000,
  tags: [['p', '4'.repeat(64)]], content: 'opaque', ...over,
});
const sent = (steps: NearbyStep[]) => steps.flatMap(s => s.kind === 'send' ? [s.frame] : []);

/** Run two links against each other until neither has anything to send. */
function pair(advertiserSecret: string, connectorSecret: string, nonces: [number, number] = [1, 2]) {
  const a = new NearbyLink('advertiser', nonce(nonces[0])), c = new NearbyLink('connector', nonce(nonces[1]));
  a.setSecret(advertiserSecret); c.setSecret(connectorSecret);
  const steps: Array<{ to: 'a' | 'c'; step: NearbyStep }> = [];
  let toA = [c.hello()], toC = [a.hello()];
  while (toA.length || toC.length) {
    const nextA: Uint8Array[] = [], nextC: Uint8Array[] = [];
    for (const f of toA) for (const s of a.receive(f)) { steps.push({ to: 'a', step: s }); if (s.kind === 'send') nextC.push(s.frame); }
    for (const f of toC) for (const s of c.receive(f)) { steps.push({ to: 'c', step: s }); if (s.kind === 'send') nextA.push(s.frame); }
    toA = nextA; toC = nextC;
  }
  return { a, c, steps };
}

describe('nearby token and key', () => {
  it('is deterministic, secret-bound and eight bytes', () => {
    expect(nearbyToken(SECRET)).toHaveLength(8);
    expect(nearbyToken(SECRET)).toEqual(nearbyToken(SECRET));
    expect(nearbyToken(SECRET)).not.toEqual(nearbyToken(OTHER));
    expect(nearbyToken(SECRET)).not.toEqual(nearbyLinkKey(SECRET).subarray(0, 8));
  });
  it('rejects a malformed secret', () => {
    expect(() => nearbyToken('A'.repeat(64))).toThrow();
    expect(() => nearbyLinkKey('ab')).toThrow();
  });
});

describe('NearbyLink authentication', () => {
  it('trusts both ends when both know the advertiser secret', () => {
    const { a, c } = pair(SECRET, SECRET);
    expect(a.trusted).toBe(true);
    expect(c.trusted).toBe(true);
  });
  it('drops a connector that did not read the advertiser QR', () => {
    const { a, c } = pair(SECRET, OTHER);
    expect(a.trusted).toBe(false);
    expect(a.dropped || c.dropped).toBe(true);
    expect(c.trusted).toBe(false);
  });
  it('drops anything but a HELLO first, and anything but AUTH second', () => {
    const a = new NearbyLink('advertiser', nonce(1)); a.setSecret(SECRET);
    expect(a.receive(new Uint8Array(17))).toEqual([{ kind: 'drop' }]);
    const b = new NearbyLink('advertiser', nonce(1)); b.setSecret(SECRET);
    expect(sent(b.receive(nearbyHello(nonce(2))))).toHaveLength(1);
    expect(b.receive(nearbyHello(nonce(3)))).toEqual([{ kind: 'drop' }]);
    const e = new NearbyLink('advertiser', nonce(1)); e.setSecret(SECRET);
    expect(e.receive(nearbyEventFrame(event() as never)!)).toEqual([{ kind: 'drop' }]);
  });
  it('drops a reflected HELLO and a reflected AUTH', () => {
    const a = new NearbyLink('advertiser', nonce(1)); a.setSecret(SECRET);
    expect(a.receive(a.hello())).toEqual([{ kind: 'drop' }]);
    const b = new NearbyLink('advertiser', nonce(1)); b.setSecret(SECRET);
    const [own] = sent(b.receive(nearbyHello(nonce(2))));
    expect(b.receive(own)).toEqual([{ kind: 'drop' }]);
  });
  it('accepts no events before trust and ignores frames after a drop', () => {
    const a = new NearbyLink('connector', nonce(1)); a.setSecret(SECRET);
    a.receive(nearbyHello(nonce(2)));
    expect(a.receive(nearbyEventFrame(event() as never)!)).toEqual([{ kind: 'drop' }]);
    expect(a.receive(nearbyHello(nonce(2)))).toEqual([]);
  });
});

describe('NearbyLink frames after trust', () => {
  it('carries an event and an authenticated receipt', () => {
    const { a, c } = pair(SECRET, SECRET);
    expect(a.receive(nearbyEventFrame(event() as never)!)).toEqual([{ kind: 'event', event: event() }]);
    const receipt = a.ack('1'.repeat(64), true);
    expect(c.receive(receipt)).toEqual([{ kind: 'ack', id: '1'.repeat(64), stored: true }]);
    expect(a.receive(c.ack('5'.repeat(64), false))).toEqual([{ kind: 'ack', id: '5'.repeat(64), stored: false }]);
  });
  it('drops a forged, flipped or reflected receipt', () => {
    const { a, c } = pair(SECRET, SECRET);
    const receipt = a.ack('1'.repeat(64), false);
    const flipped = Uint8Array.from(receipt); flipped[33] = 1;
    expect(c.receive(flipped)).toEqual([{ kind: 'drop' }]);
    const p = pair(SECRET, SECRET);
    expect(p.a.receive(p.a.ack('1'.repeat(64), true))).toEqual([{ kind: 'drop' }]);
    const q = pair(SECRET, SECRET), r = pair(SECRET, SECRET), s = pair(SECRET, SECRET, [7, 8]);
    // Same secret and nonces verify; a receipt from a session with other nonces does not.
    expect(q.c.receive(r.a.ack('1'.repeat(64), true))).toEqual([{ kind: 'ack', id: '1'.repeat(64), stored: true }]);
    expect(q.c.receive(s.a.ack('1'.repeat(64), true))).toEqual([{ kind: 'drop' }]);
  });
  it('drops an unknown frame type or a malformed event', () => {
    const { a } = pair(SECRET, SECRET);
    expect(a.receive(Uint8Array.of(9, 1, 2))).toEqual([{ kind: 'drop' }]);
    const b = pair(SECRET, SECRET).a;
    expect(b.receive(nearbyEventFrame(event({ kind: 1 }) as never)!)).toEqual([{ kind: 'drop' }]);
  });
});

describe('nearby event frames', () => {
  it('round-trips only a kind-1059 wrap with one p tag', () => {
    expect(readNearbyEvent(nearbyEventFrame(event() as never)!)).toEqual(event());
    for (const bad of [event({ tags: [] }), event({ tags: [['p', 'x']] }), event({ tags: [['e', '4'.repeat(64)]] }),
      event({ id: 'X'.repeat(64) }), event({ sig: '3' }), event({ created_at: -1 }), event({ content: 5 })]) {
      expect(readNearbyEvent(nearbyEventFrame(bad as never)!)).toBeNull();
    }
    expect(readNearbyEvent(Uint8Array.of(3, 0xff, 0xfe))).toBeNull();
    expect(readNearbyEvent(new TextEncoder().encode('\u0003[]'))).toBeNull();
  });
  it('drops unknown fields and refuses an oversized wrap', () => {
    expect(readNearbyEvent(nearbyEventFrame({ ...event(), extra: 'x' } as never)!)).toEqual(event());
    expect(nearbyEventFrame(event({ content: 'x'.repeat(NEARBY_MAX_FRAME) }) as never)).toBeNull();
  });
});
