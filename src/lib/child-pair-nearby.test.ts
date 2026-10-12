import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChildPairLink, type ChildPairLinkState } from './child-pair-nearby';
import { HandshakeNearby, resetScanThrottleForTests, type NearbyNative } from './handshake-nearby';
import { createHandshakeSession } from './handshake-reveal';

type Handlers = Parameters<NearbyNative['listen']>[0];
/** Two phones' native pipes joined by an in-memory radio; frames cross
 * asynchronously and in order, like an L2CAP stream. */
function radio(middle?: (bytes: Uint8Array) => Uint8Array[]) {
  const adverts = new Map<string, Phone>();
  let next = 0;
  class Phone implements NearbyNative {
    handlers?: Handlers; links = new Map<string, { peer: Phone; id: string }>(); stopped = false;
    statusValue = { supported: true, enabled: true, permitted: true };
    status = vi.fn(async () => this.statusValue);
    quiet = vi.fn(async () => {});
    permission = vi.fn(async () => ({ granted: true }));
    enable = vi.fn(async () => ({ enabled: true }));
    async advertise({ token }: { token: string }) { adverts.set(token, this); return { psm: 0x80 }; }
    async connect({ token }: { token: string }) {
      const peer = adverts.get(token);
      if (!peer || peer.stopped) throw new Error('not found');
      const mine = `L${++next}`, theirs = `L${++next}`;
      this.links.set(mine, { peer, id: theirs }); peer.links.set(theirs, { peer: this, id: mine });
      this.handlers!.link({ link: mine, direction: 'out' }); peer.handlers!.link({ link: theirs, direction: 'in' });
      return { link: mine };
    }
    async send({ link, data }: { link: string; data: string }) {
      const route = this.links.get(link);
      if (!route) throw new Error('closed');
      // A frame-rewriting middle: what it returns is what arrives (nothing, a changed frame, extras).
      const out = middle ? middle(Uint8Array.from(atob(data), ch => ch.charCodeAt(0))).map(b => btoa(String.fromCharCode(...b))) : [data];
      for (const d of out) setTimeout(() => route.peer.handlers?.frame({ link: route.id, data: d }), 0);
    }
    async trust() {}
    async close({ link }: { link: string }) {
      const route = this.links.get(link);
      this.links.delete(link);
      if (route) { route.peer.links.delete(route.id); setTimeout(() => route.peer.handlers?.closed({ link: route.id }), 0); }
    }
    async stop() { this.stopped = true; for (const link of [...this.links.keys()]) await this.close({ link }); }
    async listen(handlers: Handlers) { this.handlers = handlers; return () => { this.handlers = undefined; }; }
  }
  return { phone: () => new Phone() };
}

const waitFor = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)); }
};
const URI = 'signet-child:abc123';
const pairing = (n: string) => ({
  id: n.repeat(64), pubkey: '2'.repeat(64), sig: '3'.repeat(128), kind: 30078, created_at: 1700000000,
  tags: [['d', 'd'.repeat(64)], ['p', '4'.repeat(64)]], content: 'sealed',
});

function end(secretSession: ReturnType<typeof createHandshakeSession>, peer: string, native: NearbyNative) {
  const events: unknown[] = [], offers: string[] = [], states: Array<[ChildPairLinkState, string | undefined]> = [];
  const link = new ChildPairLink({ session: secretSession, peerSession: peer, native,
    onEvent: e => { events.push(e); }, onOffer: u => { offers.push(u); }, onState: (s, r) => { states.push([s, r]); } });
  return { link, events, offers, states };
}

beforeEach(() => resetScanThrottleForTests());

describe('ChildPairLink', () => {
  it('links the two tapped sessions and carries an offer one way and events both ways, each ACKed', async () => {
    const air = radio(), gNative = air.phone(), cNative = air.phone();
    const gs = createHandshakeSession(), cs = createHandshakeSession();
    const g = end(gs, cs.publicKey, gNative), c = end(cs, gs.publicKey, cNative);
    expect(g.link.linked).toBe(false);
    expect(await g.link.sendOffer(URI)).toBe(false);
    await Promise.all([g.link.open(false), c.link.open(false)]);
    await waitFor(() => g.link.linked && c.link.linked);
    expect(g.states.map(s => s[0])).toEqual(expect.arrayContaining(['starting', 'connecting', 'linked']));
    expect(await g.link.sendOffer(URI)).toBe(true);
    expect(c.offers).toEqual([URI]);
    expect(await c.link.sendEvent(pairing('1'))).toBe(true);
    expect(g.events).toEqual([pairing('1')]);
    expect(await g.link.sendEvent(pairing('5'))).toBe(true);
    expect(c.events).toEqual([pairing('5')]);
    // Not a store receipt: a resent event is simply received and acknowledged again.
    expect(await c.link.sendEvent(pairing('1'))).toBe(true);
    g.link.close(); c.link.close();
    expect(g.states.at(-1)).toEqual(['closed', undefined]);
    expect(g.link.linked).toBe(false);
    expect(await g.link.sendOffer(URI)).toBe(false);
  });

  it('a relaying middle cannot read, swap, inject or replay a post-AUTH frame; any tampering closes the link', async () => {
    const OFFER = 5, EVENT = 3;
    const plainEvent = (ev: object) => Uint8Array.of(EVENT, ...new TextEncoder().encode(JSON.stringify(ev)));
    const attacks: Array<{ name: string; rewrite: (b: Uint8Array) => Uint8Array[] }> = [
      { name: 'flip a bit in the offer', rewrite: b => b[0] === OFFER ? [Uint8Array.from(b, (x, i) => i === b.length - 3 ? x ^ 1 : x)] : [b] },
      { name: 'swap the offer for a plaintext one', rewrite: b => b[0] === OFFER ? [Uint8Array.of(OFFER, ...new TextEncoder().encode('signet-child:attacker'))] : [b] },
      { name: 'replay the offer', rewrite: b => b[0] === OFFER ? [b, b] : [b] },
      { name: 'swap the child request for an injected one', rewrite: b => b[0] === EVENT ? [plainEvent(pairing('9'))] : [b] },
      { name: 'swallow the offer, pass the rest', rewrite: b => b[0] === OFFER ? [] : [b] },
    ];
    for (const attack of attacks) {
      resetScanThrottleForTests();
      const seen: Uint8Array[] = [];
      const air = radio(b => { seen.push(b); return attack.rewrite(b); });
      const gs = createHandshakeSession(), cs = createHandshakeSession();
      const g = end(gs, cs.publicKey, air.phone()), c = end(cs, gs.publicKey, air.phone());
      await Promise.all([g.link.open(false), c.link.open(false)]);
      await waitFor(() => g.link.linked && c.link.linked);
      const offering = g.link.sendOffer(URI);
      if (attack.name.startsWith('swallow')) {
        // The child's next frame is fine; the guardian's ACK for it shows the gap.
        await c.link.sendEvent(pairing('1'));
        expect(await offering).toBe(false);
      } else if (!attack.name.startsWith('swap the child')) {
        await offering;
        await c.link.sendEvent(pairing('1')).catch(() => false);
      } else {
        expect(await offering).toBe(true);
        expect(await c.link.sendEvent(pairing('1'))).toBe(false);
      }
      await new Promise(r => setTimeout(r, 30));
      // Nothing the middle made up or changed was ever delivered...
      expect(c.offers.filter(u => u !== URI), attack.name).toEqual([]);
      expect(c.offers.length, attack.name).toBeLessThanOrEqual(1);
      expect(g.events.filter(e => (e as { id: string }).id !== '1'.repeat(64)), attack.name).toEqual([]);
      // ...the link it touched is gone...
      expect(g.link.linked && c.link.linked, attack.name).toBe(false);
      // ...and the offer never crossed in clear.
      const clear = new TextEncoder().encode('abc123');
      expect(seen.some(b => Buffer.from(b).includes(Buffer.from(clear))), attack.name).toBe(false);
      g.link.close(); c.link.close();
    }
  });

  it('refuses an offer that is not a signet-child: URI without sending anything', async () => {
    const air = radio(), gs = createHandshakeSession(), cs = createHandshakeSession();
    const g = end(gs, cs.publicKey, air.phone()), c = end(cs, gs.publicKey, air.phone());
    await Promise.all([g.link.open(false), c.link.open(false)]);
    await waitFor(() => g.link.linked && c.link.linked);
    expect(await g.link.sendOffer('https://evil.example')).toBe(false);
    expect(c.offers).toEqual([]);
    g.link.close(); c.link.close();
  });

  it('accepts only the tapped session', async () => {
    const air = radio(), gs = createHandshakeSession(), cs = createHandshakeSession(), stranger = createHandshakeSession();
    // The guardian tapped someone else; the child dials the guardian's real session.
    const g = end(gs, stranger.publicKey, air.phone()), c = end(cs, gs.publicKey, air.phone());
    await Promise.all([g.link.open(false), c.link.open(false)]);
    await new Promise(r => setTimeout(r, 400));
    expect(g.link.linked).toBe(false);
    expect(c.link.linked).toBe(false);
    expect(g.offers).toEqual([]);
    g.link.close(); c.link.close();
  });

  it('never links with a handshake-profile carrier', async () => {
    const air = radio(), gNative = air.phone(), hNative = air.phone();
    const gs = createHandshakeSession(), hs = createHandshakeSession();
    const g = end(gs, hs.publicKey, gNative);
    const h = new HandshakeNearby(hNative, { session: hs, onEvent: async () => 'stored', onChange: () => {}, redialMs: 5 });
    await Promise.all([g.link.open(false), h.open(false)]);
    h.connect({ session: gs.publicKey });
    await new Promise(r => setTimeout(r, 400));
    expect(g.link.linked).toBe(false);
    expect(h.linked).toBe(false);
    g.link.close(); await h.close();
  });

  it('reports unavailable with the reason when Bluetooth cannot be used', async () => {
    const gs = createHandshakeSession(), cs = createHandshakeSession();
    for (const [patch, reason] of [[{ supported: false }, 'unsupported'], [{ enabled: false }, 'off']] as const) {
      const native = radio().phone();
      native.statusValue = { ...native.statusValue, ...patch };
      const g = end(gs, cs.publicKey, native);
      await g.link.open(false);
      expect(g.states.at(-1)).toEqual(['unavailable', reason]);
      g.link.close();
    }
    const denied = radio().phone();
    denied.statusValue = { supported: true, enabled: true, permitted: false };
    denied.permission.mockResolvedValue({ granted: false });
    const d = end(gs, cs.publicKey, denied);
    await d.link.open(false);
    expect(d.states.at(-1)).toEqual(['unavailable', 'denied']);
    d.link.close();
  });
});
