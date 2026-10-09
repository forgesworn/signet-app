import { describe, expect, it } from 'vitest';
import { NearbyLink, NEARBY_MAX_FRAME, nearbyEventFrame, nearbyHello, nearbyLinkKey, nearbyToken, readNearbyEvent, type NearbyStep } from './handshake-nearby-wire';
import { createHandshakeSession, type HandshakeSession } from './handshake-reveal';

const nonce = (n: number) => new Uint8Array(16).fill(n);
const event = (over: Record<string, unknown> = {}) => ({
  id: '1'.repeat(64), pubkey: '2'.repeat(64), sig: '3'.repeat(128), kind: 1059, created_at: 1700000000,
  tags: [['p', '4'.repeat(64)]], content: 'opaque', ...over,
});
const sent = (steps: NearbyStep[]) => steps.flatMap(s => s.kind === 'send' ? [s.frame] : []);

/** Run two links against each other until neither has anything to send. */
function pair(adv: HandshakeSession, conn: HandshakeSession, expect: { adv?: string; conn?: string } = {}, nonces: [number, number] = [1, 2]) {
  const a = new NearbyLink('advertiser', nonce(nonces[0]), adv, expect.adv), c = new NearbyLink('connector', nonce(nonces[1]), conn, expect.conn);
  let toA = [c.hello()], toC = [a.hello()];
  while (toA.length || toC.length) {
    const nextA: Uint8Array[] = [], nextC: Uint8Array[] = [];
    for (const f of toA) for (const s of a.receive(f)) if (s.kind === 'send') nextC.push(s.frame);
    for (const f of toC) for (const s of c.receive(f)) if (s.kind === 'send') nextA.push(s.frame);
    toA = nextA; toC = nextC;
  }
  return { a, c };
}

describe('nearby token and link key', () => {
  it('derives the token from the session key on the screen', () => {
    const s = createHandshakeSession(), t = createHandshakeSession();
    expect(nearbyToken(s.publicKey)).toHaveLength(8);
    expect(nearbyToken(s.publicKey)).toEqual(nearbyToken(s.publicKey));
    expect(nearbyToken(s.publicKey)).not.toEqual(nearbyToken(t.publicKey));
    expect(() => nearbyToken('A'.repeat(64))).toThrow();
  });
  it('agrees at both ends and nowhere else', () => {
    const a = createHandshakeSession(), b = createHandshakeSession(), x = createHandshakeSession();
    expect(nearbyLinkKey(a.secret, b.publicKey)).toEqual(nearbyLinkKey(b.secret, a.publicKey));
    expect(nearbyLinkKey(x.secret, b.publicKey)).not.toEqual(nearbyLinkKey(a.secret, b.publicKey));
    expect(() => nearbyLinkKey(a.secret, 'ab')).toThrow();
  });
});

describe('NearbyLink authentication', () => {
  it('trusts both ends of the two sessions that read each other', () => {
    const adv = createHandshakeSession(), conn = createHandshakeSession();
    const { a, c } = pair(adv, conn, { adv: conn.publicKey, conn: adv.publicKey });
    expect(a.trusted && c.trusted).toBe(true);
    expect(a.peerSession).toBe(conn.publicKey);
    expect(c.peerSession).toBe(adv.publicKey);
  });
  it('refuses any other session once the camera read the peer, even with both public keys in hand', () => {
    const adv = createHandshakeSession(), conn = createHandshakeSession(), stranger = createHandshakeSession();
    // The stranger photographed both screens: it knows both public keys, but
    // it can only speak as a session whose secret it holds.
    const { a } = pair(adv, stranger, { adv: conn.publicKey, conn: adv.publicKey });
    expect(a.trusted).toBe(false);
    expect(a.dropped).toBe(true);
  });
  it('takes any session while the advertiser has read nothing (the one-way case)', () => {
    const adv = createHandshakeSession(), conn = createHandshakeSession();
    expect(pair(adv, conn, { conn: adv.publicKey }).a.trusted).toBe(true);
  });
  it('drops a connector that reached the wrong advertiser', () => {
    const adv = createHandshakeSession(), conn = createHandshakeSession(), other = createHandshakeSession();
    const { c } = pair(adv, conn, { conn: other.publicKey });
    expect(c.trusted).toBe(false);
    expect(c.dropped).toBe(true);
  });
  it('drops a link when a later camera read names another session', () => {
    const adv = createHandshakeSession(), conn = createHandshakeSession(), other = createHandshakeSession();
    const { a } = pair(adv, conn, { conn: adv.publicKey });
    expect(a.trusted).toBe(true);
    expect(a.expect(other.publicKey)).toBe(false);
    expect(a.dropped).toBe(true);
  });
  it('drops anything but a HELLO first, and anything but AUTH second', () => {
    const s = createHandshakeSession(), peer = createHandshakeSession();
    const a = new NearbyLink('advertiser', nonce(1), s);
    expect(a.receive(new Uint8Array(49))).toEqual([{ kind: 'drop' }]);
    const b = new NearbyLink('advertiser', nonce(1), s);
    expect(sent(b.receive(nearbyHello(nonce(2), peer.publicKey)))).toHaveLength(1);
    expect(b.receive(nearbyHello(nonce(3), peer.publicKey))).toEqual([{ kind: 'drop' }]);
    const e = new NearbyLink('advertiser', nonce(1), s);
    expect(e.receive(nearbyEventFrame(event() as never)!)).toEqual([{ kind: 'drop' }]);
  });
  it('drops a reflected HELLO (its own session, or its own nonce) and a reflected AUTH', () => {
    const s = createHandshakeSession(), peer = createHandshakeSession();
    const a = new NearbyLink('advertiser', nonce(1), s);
    expect(a.receive(a.hello())).toEqual([{ kind: 'drop' }]);
    const n = new NearbyLink('advertiser', nonce(1), s);
    expect(n.receive(nearbyHello(nonce(1), peer.publicKey))).toEqual([{ kind: 'drop' }]);
    const b = new NearbyLink('advertiser', nonce(1), s);
    const [own] = sent(b.receive(nearbyHello(nonce(2), peer.publicKey)));
    expect(b.receive(own)).toEqual([{ kind: 'drop' }]);
  });
});

describe('NearbyLink frames after trust', () => {
  const adv = createHandshakeSession(), conn = createHandshakeSession();
  it('carries an event and an authenticated receipt', () => {
    const { a, c } = pair(adv, conn);
    expect(a.receive(nearbyEventFrame(event() as never)!)).toEqual([{ kind: 'event', event: event() }]);
    expect(c.receive(a.ack('1'.repeat(64), true))).toEqual([{ kind: 'ack', id: '1'.repeat(64), stored: true }]);
    expect(a.receive(c.ack('5'.repeat(64), false))).toEqual([{ kind: 'ack', id: '5'.repeat(64), stored: false }]);
  });
  it('drops a forged, flipped, reflected or other-session receipt', () => {
    const { a, c } = pair(adv, conn);
    const flipped = Uint8Array.from(a.ack('1'.repeat(64), false)); flipped[33] = 1;
    expect(c.receive(flipped)).toEqual([{ kind: 'drop' }]);
    const p = pair(adv, conn);
    expect(p.a.receive(p.a.ack('1'.repeat(64), true))).toEqual([{ kind: 'drop' }]);
    const q = pair(adv, conn), other = pair(adv, conn, {}, [7, 8]);
    expect(q.c.receive(other.a.ack('1'.repeat(64), true))).toEqual([{ kind: 'drop' }]);
  });
  it('drops an unknown frame type or a malformed event', () => {
    expect(pair(adv, conn).a.receive(Uint8Array.of(9, 1, 2))).toEqual([{ kind: 'drop' }]);
    expect(pair(adv, conn).a.receive(nearbyEventFrame(event({ kind: 1 }) as never)!)).toEqual([{ kind: 'drop' }]);
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
