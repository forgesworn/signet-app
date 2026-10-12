import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { getPublicKey } from 'nostr-tools/pure';
import { NearbyLink, NEARBY_MAX_FRAME, NEARBY_MAX_SEALED_FRAMES, NEARBY_SEAL_OVERHEAD, nearbyEventFrame, nearbyHello, nearbyLinkKey, nearbyOfferFrame, nearbyOfferId, nearbyToken, readNearbyEvent, readNearbyOffer, type NearbyProfile, type NearbyStep } from './handshake-nearby-wire';
import { createHandshakeSession, type HandshakeSession } from './handshake-reveal';

const nonce = (n: number) => new Uint8Array(16).fill(n);
const event = (over: Record<string, unknown> = {}) => ({
  id: '1'.repeat(64), pubkey: '2'.repeat(64), sig: '3'.repeat(128), kind: 1059, created_at: 1700000000,
  tags: [['p', '4'.repeat(64)]], content: 'opaque', ...over,
});
const sent = (steps: NearbyStep[]) => steps.flatMap(s => s.kind === 'send' ? [s.frame] : []);

/** Run two links against each other until neither has anything to send. */
function pair(adv: HandshakeSession, conn: HandshakeSession, expect: { adv?: string; conn?: string } = {}, nonces: [number, number] = [1, 2]) {
  const a = new NearbyLink('advertiser', nonce(nonces[0]), adv, expect.adv), c = new NearbyLink('connector', nonce(nonces[1]), conn, expect.conn ?? adv.publicKey);
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
  it('never puts the advertiser\'s session key on the air, and a stranger who saw only the token cannot link', () => {
    const adv = createHandshakeSession(), conn = createHandshakeSession();
    const hello = new NearbyLink('advertiser', nonce(1), adv).hello();
    expect(hello).toHaveLength(17);
    expect(Buffer.from(hello).toString('hex')).not.toContain(adv.publicKey);
    // Without the advertiser's key a connector can only guess one: AUTH fails.
    const { a, c } = pair(adv, conn, { conn: createHandshakeSession().publicKey });
    expect(a.trusted || c.trusted).toBe(false);
    expect(() => new NearbyLink('connector', nonce(2), conn)).toThrow();
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

describe('handshake profile is byte-identical to before profiles existed', () => {
  // Pinned from the code as it stood before the child-pair profile was added.
  const a = new Uint8Array(32).fill(1), b = new Uint8Array(32).fill(2);
  it('keeps the token and link key vectors', () => {
    expect(getPublicKey(a)).toBe('1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f');
    expect(getPublicKey(b)).toBe('4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766');
    expect(bytesToHex(nearbyToken(getPublicKey(a)))).toBe('4bd8b5f1c5a6b164');
    expect(bytesToHex(nearbyLinkKey(a, getPublicKey(b)))).toBe('ccea96b188b6adab1d53cad989fd8e4c9c1592367ed9cf4e53d4acb4320058a3');
    expect(bytesToHex(nearbyToken(getPublicKey(a), 'handshake'))).toBe('4bd8b5f1c5a6b164');
  });
  it('gives child-pair its own token and link key', () => {
    expect(nearbyToken(getPublicKey(a), 'child-pair')).not.toEqual(nearbyToken(getPublicKey(a)));
    expect(nearbyLinkKey(a, getPublicKey(b), 'child-pair')).not.toEqual(nearbyLinkKey(a, getPublicKey(b)));
    expect(nearbyLinkKey(a, getPublicKey(b), 'child-pair')).toEqual(nearbyLinkKey(b, getPublicKey(a), 'child-pair'));
  });
});

describe('child-pair profile', () => {
  const D = 'd'.repeat(64), P = '4'.repeat(64);
  const pairing = (over: Record<string, unknown> = {}) => ({
    id: '1'.repeat(64), pubkey: '2'.repeat(64), sig: '3'.repeat(128), kind: 30078, created_at: 1700000000,
    tags: [['d', D], ['p', P]], content: 'opaque', ...over,
  });
  const URI = 'signet-child:abc';
  function pairP(adv: HandshakeSession, conn: HandshakeSession, pa: NearbyProfile, pc: NearbyProfile) {
    const a = new NearbyLink('advertiser', nonce(1), adv, undefined, pa), c = new NearbyLink('connector', nonce(2), conn, adv.publicKey, pc);
    let toA = [c.hello()], toC = [a.hello()];
    while (toA.length || toC.length) {
      const nextA: Uint8Array[] = [], nextC: Uint8Array[] = [];
      for (const f of toA) for (const s of a.receive(f)) if (s.kind === 'send') nextC.push(s.frame);
      for (const f of toC) for (const s of c.receive(f)) if (s.kind === 'send') nextA.push(s.frame);
      toA = nextA; toC = nextC;
    }
    return { a, c };
  }
  const adv = createHandshakeSession(), conn = createHandshakeSession();

  it('accepts a kind-30078 event with exactly one d and one p tag, in either order', () => {
    expect(readNearbyEvent(nearbyEventFrame(pairing() as never)!, 'child-pair')).toEqual(pairing());
    const swapped = pairing({ tags: [['p', P], ['d', D]] });
    expect(readNearbyEvent(nearbyEventFrame(swapped as never)!, 'child-pair')).toEqual(swapped);
    expect(readNearbyEvent(nearbyEventFrame(pairing({ content: 'x'.repeat(20000) }) as never)!, 'child-pair')).not.toBeNull();
  });
  it('rejects a 1059 wrap, extra, missing or repeated tags, oversize content and bad shapes', () => {
    for (const bad of [pairing({ kind: 1059, tags: [['p', P]] }), pairing({ kind: 1059 }), pairing({ kind: 1 }),
      pairing({ tags: [['d', D], ['p', P], ['e', P]] }), pairing({ tags: [['d', D]] }), pairing({ tags: [['p', P]] }),
      pairing({ tags: [['d', D], ['d', D]] }), pairing({ tags: [['p', P], ['p', P]] }), pairing({ tags: [['d', 'D'.repeat(64)], ['p', P]] }),
      pairing({ tags: [['d', 'short'], ['p', P]] }), pairing({ tags: [['d', D, 'x'], ['p', P]] }), pairing({ tags: [['d', D], ['p', 'A'.repeat(64)]] }),
      pairing({ content: 'x'.repeat(20001) }), pairing({ id: 'X'.repeat(64) }), pairing({ sig: '3' }), pairing({ created_at: -1 })]) {
      expect(readNearbyEvent(nearbyEventFrame(bad as never)!, 'child-pair')).toBeNull();
    }
  });
  it('is the handshake profile that rejects a 30078 pairing event, and child-pair that rejects a 1059', () => {
    expect(readNearbyEvent(nearbyEventFrame(pairing() as never)!)).toBeNull();
    expect(readNearbyEvent(nearbyEventFrame(event() as never)!, 'child-pair')).toBeNull();
  });
  it('carries an offer and an event over a trusted link, with ACKs for each', () => {
    const { a, c } = pairP(adv, conn, 'child-pair', 'child-pair');
    expect(a.trusted && c.trusted).toBe(true);
    const frame = nearbyOfferFrame(URI)!, id = nearbyOfferId(frame);
    expect(c.receive(a.wire(frame)!)).toEqual([{ kind: 'offer', uri: URI, id }]);
    expect(a.receive(c.ack(id, true))).toEqual([{ kind: 'ack', id, stored: true }]);
    expect(a.receive(c.wire(nearbyEventFrame(pairing() as never)!)!)).toEqual([{ kind: 'event', event: pairing() }]);
    expect(c.receive(a.wire(nearbyEventFrame(pairing({ id: '5'.repeat(64) }) as never)!)!)).toEqual([{ kind: 'event', event: pairing({ id: '5'.repeat(64) }) }]);
    expect(c.receive(a.ack('1'.repeat(64), true))).toEqual([{ kind: 'ack', id: '1'.repeat(64), stored: true }]);
  });
  it('drops a link on a non-signet-child, oversize or malformed offer', () => {
    const raw = (text: string | Uint8Array) => Uint8Array.of(5, ...(typeof text === 'string' ? new TextEncoder().encode(text) : text));
    for (const bad of [raw('https://evil.example/x'), raw('signet-child:' + 'x'.repeat(8192)), raw(Uint8Array.of(0xff, 0xfe)), Uint8Array.of(5)]) {
      const { a, c } = pairP(adv, conn, 'child-pair', 'child-pair');
      const sealed = a.wire(bad);
      // An empty body still seals; every one of these opens and then fails the offer parser.
      expect(c.receive(sealed!)).toEqual([{ kind: 'drop' }]);
    }
    const ok = raw('signet-child:' + 'x'.repeat(8192 - 13));
    const p = pairP(adv, conn, 'child-pair', 'child-pair');
    expect(p.c.receive(p.a.wire(ok)!)).toMatchObject([{ kind: 'offer' }]);
    expect(nearbyOfferFrame('https://x')).toBeNull();
    expect(nearbyOfferFrame('signet-child:' + 'x'.repeat(8192))).toBeNull();
    expect(readNearbyOffer(raw('nope'))).toBeNull();
  });
  it('the handshake profile treats the offer byte as invalid and drops the link', () => {
    const frame = nearbyOfferFrame(URI)!;
    expect(pairP(adv, conn, 'handshake', 'handshake').c.receive(frame)).toEqual([{ kind: 'drop' }]);
  });
  it('never authenticates a handshake peer with a child-pair peer, either way round', () => {
    for (const [pa, pc] of [['handshake', 'child-pair'], ['child-pair', 'handshake']] as const) {
      const { a, c } = pairP(adv, conn, pa, pc);
      expect(a.trusted || c.trusted).toBe(false);
      expect(a.dropped || c.dropped).toBe(true);
    }
  });
});

describe('child-pair frames are sealed against a relaying middle (C1/M1)', () => {
  // The middle forwarded HELLO and AUTH byte for byte, so both ends are
  // trusted; from here on it sees and controls every frame on the air.
  const D = 'd'.repeat(64), P = '4'.repeat(64);
  const pairing = (over: Record<string, unknown> = {}) => ({
    id: '1'.repeat(64), pubkey: '2'.repeat(64), sig: '3'.repeat(128), kind: 30078, created_at: 1700000000,
    tags: [['d', D], ['p', P]], content: 'opaque', ...over,
  });
  const URI = 'signet-child:secret-offer-name=Sam';
  const adv = createHandshakeSession(), conn = createHandshakeSession();
  function relayed(nonces: [number, number] = [1, 2]) {
    const a = new NearbyLink('advertiser', nonce(nonces[0]), adv, conn.publicKey, 'child-pair');
    const c = new NearbyLink('connector', nonce(nonces[1]), conn, adv.publicKey, 'child-pair');
    let toA = [c.hello()], toC = [a.hello()];
    while (toA.length || toC.length) {
      const nextA: Uint8Array[] = [], nextC: Uint8Array[] = [];
      for (const f of toA) for (const s of a.receive(Uint8Array.from(f))) if (s.kind === 'send') nextC.push(s.frame);
      for (const f of toC) for (const s of c.receive(Uint8Array.from(f))) if (s.kind === 'send') nextA.push(s.frame);
      toA = nextA; toC = nextC;
    }
    expect(a.trusted && c.trusted).toBe(true);
    return { a, c };
  }
  const offer = () => nearbyOfferFrame(URI)!;
  const ev = (id = '1') => nearbyEventFrame(pairing({ id: id.repeat(64) }) as never)!;
  const DROP = [{ kind: 'drop' }];

  it('a faithful middle changes nothing, and never sees the offer or the event in clear', () => {
    const { a, c } = relayed();
    const o = a.wire(offer())!, e = c.wire(ev())!;
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
    expect(hex(o)).not.toContain(Buffer.from('signet-child:').toString('hex'));
    expect(hex(e)).not.toContain(Buffer.from('opaque').toString('hex'));
    expect(o.length).toBe(offer().length + NEARBY_SEAL_OVERHEAD);
    expect(c.receive(o)).toEqual([{ kind: 'offer', uri: URI, id: nearbyOfferId(offer()) }]);
    expect(a.receive(e)).toEqual([{ kind: 'event', event: pairing() }]);
  });

  it('cannot inject an unsealed OFFER or EVENT (the C1 request swap), and the link closes', () => {
    for (const forged of [offer(), ev('9'), nearbyOfferFrame('signet-child:attacker')!]) {
      const { a, c } = relayed();
      expect(a.receive(forged)).toEqual(DROP);
      expect(a.dropped).toBe(true);
      expect(c.receive(forged)).toEqual(DROP);
      // Nothing after the drop is heard, however valid.
      expect(a.receive(c.wire(ev())!)).toEqual([]);
    }
  });

  it('cannot forge a sealed frame from outside the link, nor carry one across links', () => {
    const other = relayed([7, 8]);
    const { a, c } = relayed();
    // Same sessions, other nonces: a frame from another link (or an earlier attempt) is refused.
    expect(c.receive(other.a.wire(offer())!)).toEqual(DROP);
    const { c: c2 } = relayed();
    const guess = Uint8Array.from(a.wire(offer())!);
    guess.fill(0x42, 1 + 8);
    expect(c2.receive(guess)).toEqual(DROP);
  });

  it('drops any modified frame: body, tag, counter, type byte or length', () => {
    const cases: Array<(f: Uint8Array) => Uint8Array> = [
      f => { const g = Uint8Array.from(f); g[g.length - 20] ^= 1; return g; }, // ciphertext
      f => { const g = Uint8Array.from(f); g[g.length - 1] ^= 1; return g; },  // tag
      f => { const g = Uint8Array.from(f); g[8] ^= 1; return g; },             // counter
      f => { const g = Uint8Array.from(f); g[0] = 3; return g; },              // OFFER relabelled EVENT
      f => { const g = Uint8Array.from(f); g[0] = 4; return g; },              // relabelled ACK
      f => { const g = Uint8Array.from(f); g[0] = 9; return g; },              // unknown type
      f => f.subarray(0, f.length - 1),                                        // truncated
      f => f.subarray(0, 1 + NEARBY_SEAL_OVERHEAD - 1),                        // below the overhead
      f => Uint8Array.from([...f, 0]),                                         // extended
    ];
    for (const tamper of cases) {
      const { a, c } = relayed();
      expect(c.receive(tamper(a.wire(offer())!))).toEqual(DROP);
      expect(c.dropped).toBe(true);
    }
  });

  it('drops a replayed, reordered or skipped frame', () => {
    const r1 = relayed();
    const f0 = r1.a.wire(ev('1'))!;
    expect(r1.c.receive(f0)).toMatchObject([{ kind: 'event' }]);
    expect(r1.c.receive(f0)).toEqual(DROP); // replay

    const r2 = relayed();
    const g0 = r2.a.wire(ev('1'))!, g1 = r2.a.wire(ev('5'))!;
    expect(r2.c.receive(g1)).toEqual(DROP); // reorder (or a dropped g0)
    expect(r2.c.receive(g0)).toEqual([]);

    const r3 = relayed();
    r3.a.wire(offer()); // the middle swallows the offer...
    expect(r3.c.receive(r3.a.wire(ev('5'))!)).toEqual(DROP); // ...and the next frame shows the gap
  });

  it('drops a frame reflected back to its sender (the other direction has its own key)', () => {
    const { a, c } = relayed();
    expect(a.receive(a.wire(offer())!)).toEqual(DROP);
    expect(c.receive(c.ack('1'.repeat(64), true))).toEqual(DROP);
    // Same counter in both directions: still not interchangeable.
    const r = relayed();
    const fromA = r.a.wire(ev('1'))!;
    r.c.wire(ev('5'));
    expect(r.a.receive(fromA)).toEqual(DROP);
  });

  it('a modified or forged ACK closes the link instead of confirming delivery', () => {
    const { a, c } = relayed();
    const id = nearbyOfferId(offer());
    expect(c.receive(a.wire(offer())!)).toMatchObject([{ kind: 'offer' }]);
    const ack = Uint8Array.from(c.ack(id, true));
    ack[20] ^= 1;
    expect(a.receive(ack)).toEqual(DROP);
  });

  it('stops at the counter limit rather than wrapping', () => {
    const { a, c } = relayed();
    for (let i = 0; i < NEARBY_MAX_SEALED_FRAMES; i++) {
      expect(c.receive(a.ack('1'.repeat(64), true))).toMatchObject([{ kind: 'ack' }]);
    }
    expect(a.wire(offer())).toBeNull();
    expect(() => a.ack('1'.repeat(64), true)).toThrow();
    // A receiver at its limit takes nothing more, whatever the frame says.
    expect(c.receive(Uint8Array.of(4, ...new Uint8Array(8 + 49 + 16)))).toEqual(DROP);
  });

  it('refuses to seal a frame that would not fit the native cap, or before trust', () => {
    const { a } = relayed();
    // A plaintext frame that fits the cap alone but not once sealed.
    const big = new Uint8Array(NEARBY_MAX_FRAME - NEARBY_SEAL_OVERHEAD + 1); big[0] = 3;
    expect(a.wire(big)).toBeNull();
    const fits = new Uint8Array(NEARBY_MAX_FRAME - NEARBY_SEAL_OVERHEAD); fits[0] = 3;
    expect(a.wire(fits)).toHaveLength(NEARBY_MAX_FRAME);
    const fresh = new NearbyLink('advertiser', nonce(1), adv, undefined, 'child-pair');
    expect(fresh.wire(offer())).toBeNull();
  });

  it('wipes the frame keys on close', () => {
    const { a } = relayed();
    const keys = a as unknown as { sendKey?: Uint8Array; recvKey?: Uint8Array; key?: Uint8Array };
    const send = keys.sendKey!, recv = keys.recvKey!, link = keys.key!;
    a.close();
    expect([send, recv, link].every(k => k.every(b => b === 0))).toBe(true);
    expect(a.wire(offer())).toBeNull();
  });

  it('leaves the handshake profile unsealed: wire() is the identity there', () => {
    const { a } = pair(adv, conn);
    const f = nearbyEventFrame(event() as never)!;
    expect(a.wire(f)).toBe(f);
  });
});
