import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';
import { ContactIdentityDecryptBudget } from '@forgesworn/signet-contacts';
import { ContactInviteService } from './contact-invite-service';
import { contactExchangeKey } from './contact-exchange-key';
import { HandshakeNearby, type NearbyNative, type NearbyReceipt } from './handshake-nearby';
import { NearbyLink, nearbyHello } from './handshake-nearby-wire';
import { purgeAllUserData } from './db';
import { openContactMailboxWrap } from '@forgesworn/signet-contacts/adapters/invite-nostr-tools';
import { recordContactArrival } from './contact-invite-store';
const publish = vi.hoisted(() => vi.fn(async () => false));
vi.mock('./sync-relays', () => ({ publishToRelays: publish }));
// These tests are about the carrier and the exchange, not the at-rest vault:
// derive the vault key with one SHA-256 instead of 600,000 PBKDF2 rounds.
// AES-GCM stays real, and the key is still bound to the passphrase and salt.
vi.mock('./aes-crypto', async importOriginal => {
  const real = await importOriginal<typeof import('./aes-crypto')>();
  const { sha256 } = await import('@noble/hashes/sha2.js');
  return { ...real, deriveAesKey: async (passphrase: string, salt: Uint8Array) => {
    const material = new Uint8Array([...new TextEncoder().encode(passphrase), ...salt]);
    return real.importAesKeyRaw(sha256(material));
  } };
});
const KEY = 'nearby handshake test', now = 1700000000;

type Handlers = Parameters<NearbyNative['listen']>[0];
/** Two phones' native pipes joined by an in-memory radio. Frames cross
 * asynchronously, in order, like an L2CAP stream. */
function radio() {
  const adverts = new Map<string, Phone>();
  let next = 0;
  class Phone implements NearbyNative {
    handlers?: Handlers; links = new Map<string, { peer: Phone; id: string }>(); trusted = new Set<string>();
    sent: Uint8Array[] = []; stopped = false;
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
      this.sent.push(Uint8Array.from(atob(data), c => c.charCodeAt(0)));
      setTimeout(() => route.peer.handlers?.frame({ link: route.id, data }), 0);
    }
    async trust({ link }: { link: string }) { this.trusted.add(link); }
    async close({ link }: { link: string }) {
      const route = this.links.get(link);
      this.links.delete(link);
      if (route) { route.peer.links.delete(route.id); setTimeout(() => route.peer.handlers?.closed({ link: route.id }), 0); }
    }
    async stop() { this.stopped = true; for (const link of [...this.links.keys()]) await this.close({ link }); }
    async listen(handlers: Handlers) { this.handlers = handlers; return () => { this.handlers = undefined; }; }
  }
  return { phone: () => new Phone(), adverts };
}

function party(secret: string, directoryId: string, holder: { carrier?: HandshakeNearby }) {
  const sk = hexToBytes(secret), pubkey = getPublicKey(sk);
  const completed = vi.fn(async () => 'c'.repeat(32));
  const service = new ContactInviteService({ directoryId, encryptionKey: KEY, budget: new ContactIdentityDecryptBudget(),
    signer: async key => {
      if (key !== pubkey) throw new Error('Wrong identity');
      return { publicKey: pubkey, signEvent: async event => finalizeEvent(event, sk),
        decrypt: async (sender, ct) => nip44.v2.decrypt(ct, nip44.v2.utils.getConversationKey(sk, sender)) };
    }, isCurrent: () => true, onChanged: () => {}, mayConnect: () => true, onCompleted: completed,
    direct: { route: peer => holder.carrier?.route(peer) ?? 'none', deliver: (peer, event) => holder.carrier?.deliver(peer, event) ?? Promise.resolve(false) } });
  return { service, pubkey, directoryId, completed, holder };
}
beforeEach(async () => { await purgeAllUserData(); publish.mockReset().mockResolvedValue(false); });

describe('handshake over a nearby link, with no internet', () => {
  it('completes a mutual handshake with no relay publish at all', async () => {
    const air = radio();
    const p = party('01'.repeat(32), 'owner', {}), q = party('02'.repeat(32), `dependant:${'b'.repeat(64)}`, {});
    const [a, b] = p.pubkey < q.pubkey ? [p, q] : [q, p];
    const ai = await a.service.create(a.pubkey, 'Handshake', ['wss://relay.example'], 'single-use', now, now + 120);
    const bi = await b.service.create(b.pubkey, 'Handshake', ['wss://relay.example'], 'single-use', now, now + 120);
    const na = air.phone(), nb = air.phone();
    a.holder.carrier = new HandshakeNearby(na, { ownSecret: ai.invite.secret, onChange: () => {}, ackMs: 2000,
      onEvent: event => a.service.receiveDirect(event, { identity: a.pubkey, inviteId: ai.id, now: now + 3 }) });
    b.holder.carrier = new HandshakeNearby(nb, { ownSecret: bi.invite.secret, onChange: () => {}, ackMs: 2000,
      onEvent: event => b.service.receiveDirect(event, { identity: b.pubkey, inviteId: bi.id, now: now + 3 }) });
    expect(await a.holder.carrier.open(true)).toBe('ready');
    expect(await b.holder.carrier.open(true)).toBe('ready');

    // The lower key read the higher key's QR and connects to its advert.
    a.holder.carrier.connect({ pubkey: b.pubkey, secret: bi.invite.secret });
    await vi.waitFor(() => expect(a.holder.carrier!.route(b.pubkey)).toBe('linked'));
    expect(na.trusted.size).toBe(1);
    await vi.waitFor(() => expect(nb.trusted.size).toBe(1));
    // The advertiser cannot speak for anyone until an SDK message binds the link.
    expect(b.holder.carrier.route(a.pubkey)).toBe('none');

    const exchangeId = (await a.service.request(a.pubkey, bi.invite, now + 1, undefined, undefined, true))!;
    await a.service.flush(now + 2);
    expect((await a.service.read()).outbox[0].acknowledgedAt).toBe(now + 2);
    const arrival = (await b.service.read()).arrivals.find(x => x.inviteId === bi.id)!;
    expect(arrival).toBeDefined();

    await b.service.openInbox(now + 3, false, b.pubkey, new Set([arrival.id]));
    const opened = (await b.service.read()).arrivals.find(x => x.id === arrival.id)!;
    expect(opened.request?.from).toBe(a.pubkey);
    b.holder.carrier.bind(arrival.id, opened.request!.from);
    expect(b.holder.carrier.route(a.pubkey)).toBe('linked');
    await b.service.acceptHandshake(arrival.id, bi.invite, { invite: ai.invite }, now + 4);
    await b.service.flush(now + 5);
    expect((await b.service.read()).outbox.every(o => o.acknowledgedAt === now + 5)).toBe(true);

    await a.service.openInbox(now + 6, true);
    await a.service.openInbox(now + 6, false, a.pubkey);
    await a.service.flush(now + 7);
    const ae = (await a.service.read()).exchanges[0];
    expect(ae.handshake?.opticalAcceptanceAt).toBe(now + 6);
    expect(ae.phase).toBe('complete');

    await b.service.openInbox(now + 8, true);
    expect((await b.service.read()).exchanges[0].phase).toBe('complete');
    await a.service.confirmHandshake(exchangeId, now + 9, { own: ai.invite, scanned: { invite: bi.invite }, readAt: now + 1 });
    await b.service.confirmHandshake(exchangeId, now + 9, { own: bi.invite, scanned: { invite: ai.invite }, readAt: now + 1 });
    expect((await a.service.read()).exchanges[0].handshake?.strength).toBe('mutual');
    expect((await b.service.read()).exchanges[0].handshake?.strength).toBe('mutual');
    expect(a.completed).toHaveBeenCalledTimes(1); expect(b.completed).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    expect(contactExchangeKey((await b.service.read()).exchanges[0].request)).toBe(exchangeId);
    await a.holder.carrier.close(); await b.holder.carrier.close();
    expect(na.stopped && nb.stopped).toBe(true);
  }, 30000);

  it('holds a handshake row from the relays while linking, then falls back when no link comes', async () => {
    let clock = 0;
    const air = radio();
    const p = party('01'.repeat(32), 'owner', {}), q = party('02'.repeat(32), `dependant:${'c'.repeat(64)}`, {});
    const [a, b] = p.pubkey < q.pubkey ? [p, q] : [q, p];
    const ai = await a.service.create(a.pubkey, 'Handshake', ['wss://relay.example'], 'single-use', now, now + 120);
    const bi = await b.service.create(b.pubkey, 'Handshake', ['wss://relay.example'], 'single-use', now, now + 120);
    // The peer never advertises (a browser, or Bluetooth refused).
    const changes = vi.fn();
    a.holder.carrier = new HandshakeNearby(air.phone(), { ownSecret: ai.invite.secret, onChange: changes, nowMs: () => clock,
      holdMs: 5000, onEvent: async () => 'rejected' as const });
    await a.holder.carrier.open(true);
    a.holder.carrier.connect({ pubkey: b.pubkey, secret: bi.invite.secret });
    await a.service.request(a.pubkey, bi.invite, now + 1, undefined, undefined, true);
    // Every dial fails at once here (three attempts), so the row is not held.
    await vi.waitFor(() => expect(a.holder.carrier!.route(b.pubkey)).toBe('none'));
    publish.mockResolvedValue(true);
    await a.service.flush(now + 2);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('holds while the connect is still running and releases after the hold', async () => {
    let clock = 0;
    const native = radio().phone();
    native.connect = vi.fn(() => new Promise<never>(() => {}));
    const p = party('01'.repeat(32), 'owner', {}), q = party('02'.repeat(32), `dependant:${'c'.repeat(64)}`, {});
    const [a, b] = p.pubkey < q.pubkey ? [p, q] : [q, p];
    await a.service.create(a.pubkey, 'Handshake', ['wss://relay.example'], 'single-use', now, now + 120);
    const bi = await b.service.create(b.pubkey, 'Handshake', ['wss://relay.example'], 'single-use', now, now + 120);
    a.holder.carrier = new HandshakeNearby(native, { ownSecret: 'c'.repeat(64), onChange: () => {}, nowMs: () => clock, holdMs: 5000, onEvent: async () => 'rejected' as const });
    await a.holder.carrier.open(true);
    a.holder.carrier.connect({ pubkey: b.pubkey, secret: bi.invite.secret });
    expect(a.holder.carrier.route(b.pubkey)).toBe('pending');
    await a.service.request(a.pubkey, bi.invite, now + 1, undefined, undefined, true);
    publish.mockResolvedValue(true);
    await a.service.flush(now + 2);
    expect(publish).not.toHaveBeenCalled();
    clock = 5000;
    expect(a.holder.carrier.route(b.pubkey)).toBe('none');
    await a.service.flush(now + 3);
    expect(publish).toHaveBeenCalledTimes(1);
    await a.holder.carrier.close();
  });
});

describe('HandshakeNearby link admission', () => {
  it('drops a link from a phone that did not read this QR, and stores nothing from it', async () => {
    const native = radio().phone();
    const onEvent = vi.fn(async () => 'stored' as const);
    const carrier = new HandshakeNearby(native, { ownSecret: 'a'.repeat(64), onChange: () => {}, onEvent });
    await carrier.open(true);
    native.links.set('X', { peer: native, id: 'unused' });
    native.handlers!.link({ link: 'X', direction: 'in' });
    // A stranger that knows only the advertised token, not the QR secret.
    const stranger = new NearbyLink('connector', new Uint8Array(16).fill(9));
    stranger.setSecret('b'.repeat(64));
    const toFrame = (bytes: Uint8Array) => ({ link: 'X', data: btoa(String.fromCharCode(...bytes)) });
    native.handlers!.frame(toFrame(stranger.hello()));
    const ownHello = native.sent[0];
    const auth = stranger.receive(ownHello).flatMap(s => s.kind === 'send' ? [s.frame] : []);
    native.handlers!.frame(toFrame(auth[0]));
    expect(native.links.has('X')).toBe(false);
    expect(native.trusted.size).toBe(0);
    expect(onEvent).not.toHaveBeenCalled();
    await carrier.close();
  });

  it('refuses more than two links and frames for an unknown link', async () => {
    const native = radio().phone();
    const carrier = new HandshakeNearby(native, { ownSecret: 'a'.repeat(64), onChange: () => {}, onEvent: async () => 'stored' as const });
    await carrier.open(true);
    const close = vi.spyOn(native, 'close');
    for (const link of ['A', 'B', 'C']) { native.links.set(link, { peer: native, id: link }); native.handlers!.link({ link, direction: 'in' }); }
    expect(close).toHaveBeenCalledWith({ link: 'C' });
    native.handlers!.frame({ link: 'Z', data: btoa(String.fromCharCode(...nearbyHello(new Uint8Array(16)))) });
    expect(close).toHaveBeenCalledWith({ link: 'Z' });
    await carrier.close();
  });

  it('reports unsupported, refused and switched-off radios without advertising', async () => {
    for (const [status, permission, enable, expected] of [
      [{ supported: false, enabled: true, permitted: true }, true, true, 'unsupported'],
      [{ supported: true, enabled: true, permitted: false }, false, true, 'denied'],
      [{ supported: true, enabled: false, permitted: true }, true, false, 'off'],
    ] as const) {
      const native = radio().phone();
      native.statusValue = { ...status };
      native.permission.mockResolvedValue({ granted: permission });
      native.enable.mockResolvedValue({ enabled: enable });
      const advertise = vi.spyOn(native, 'advertise');
      const carrier = new HandshakeNearby(native, { ownSecret: 'a'.repeat(64), onChange: () => {}, onEvent: async () => 'stored' as const });
      expect(await carrier.open(true)).toBe(expected);
      expect(advertise).not.toHaveBeenCalled();
      expect(carrier.route('b'.repeat(64))).toBe('none');
    }
    const native = radio().phone();
    native.statusValue = { supported: true, enabled: false, permitted: true };
    const carrier = new HandshakeNearby(native, { ownSecret: 'a'.repeat(64), onChange: () => {}, onEvent: async () => 'stored' as const });
    expect(await carrier.open(false)).toBe('off');
    expect(native.enable).not.toHaveBeenCalled();
  });

  it('treats a missing receipt as not delivered', async () => {
    const air = radio();
    const na = air.phone(), nb = air.phone();
    const a = new HandshakeNearby(na, { ownSecret: 'a'.repeat(64), onChange: () => {}, ackMs: 50, onEvent: async () => 'stored' as const });
    // The peer never answers events: its handler never resolves.
    const b = new HandshakeNearby(nb, { ownSecret: 'b'.repeat(64), onChange: () => {}, onEvent: () => new Promise<NearbyReceipt>(() => {}) });
    await a.open(true); await b.open(true);
    a.connect({ pubkey: '2'.repeat(64), secret: 'b'.repeat(64) });
    await vi.waitFor(() => expect(a.route('2'.repeat(64))).toBe('linked'));
    const event = { id: '1'.repeat(64), pubkey: '2'.repeat(64), sig: '3'.repeat(128), kind: 1059, created_at: 1,
      tags: [['p', '4'.repeat(64)]], content: 'x' };
    expect(await a.deliver('2'.repeat(64), event)).toBe(false);
    expect(await a.deliver('9'.repeat(64), event)).toBe(false);
    await a.close(); await b.close();
  });
});

describe('ContactInviteService.receiveDirect', () => {
  it('stores only wraps addressed to this handshake, once, and nothing after it expires', async () => {
    const p = party('01'.repeat(32), 'owner', {}), q = party('02'.repeat(32), `dependant:${'b'.repeat(64)}`, {});
    const standing = await q.service.create(q.pubkey, 'Standing', ['wss://relay.example'], 'standing', now);
    const hs = await q.service.create(q.pubkey, 'Handshake', ['wss://relay.example'], 'single-use', now, now + 120);
    await p.service.request(p.pubkey, standing.invite, now + 1);
    await p.service.request(p.pubkey, hs.invite, now + 1, undefined, undefined, true);
    const [toStanding, toHandshake] = (await p.service.read()).outbox.map(o => o.event);
    const scope = { identity: q.pubkey, inviteId: hs.id, now: now + 2 };
    expect(await q.service.receiveDirect(toStanding, scope)).toBe('rejected');
    expect(await q.service.receiveDirect(toHandshake, { ...scope, identity: p.pubkey })).toBe('rejected');
    expect(await q.service.receiveDirect(toHandshake, { ...scope, now: now + 120 })).toBe('rejected');
    expect(await q.service.receiveDirect({ ...toHandshake, content: toHandshake.content.slice(1) }, scope)).toBe('rejected');
    expect(await q.service.receiveDirect(toHandshake, scope)).toBe('stored');
    expect(await q.service.receiveDirect(toHandshake, scope)).toBe('duplicate');
    // Review M1: the stored event's id with anything else is not a duplicate.
    expect(await q.service.receiveDirect({ ...toHandshake, sig: '0'.repeat(128) }, scope)).toBe('rejected');
    expect(await q.service.receiveDirect({ ...toHandshake, content: 'x', sig: '0'.repeat(128) }, scope)).toBe('rejected');
    expect((await q.service.read()).arrivals.filter(a => a.id === toHandshake.id)).toHaveLength(1);
    expect((await q.service.read()).arrivals.some(a => a.inviteId === standing.id)).toBe(false);
  });
});

describe('HandshakeNearby review fixes', () => {
  const B = 'f'.repeat(64), PEER = 'e'.repeat(64);
  const wrap = (c: string) => ({ id: c.repeat(64), pubkey: '2'.repeat(64), sig: '3'.repeat(128), kind: 1059, created_at: 1,
    tags: [['p', '4'.repeat(64)]], content: 'x' });
  async function joined(count: number) {
    const air = radio();
    const nb = air.phone();
    const stored = new Set<string>();
    const b = new HandshakeNearby(nb, { ownSecret: 'b'.repeat(64), onChange: () => {},
      onEvent: async e => stored.has(e.id) ? 'duplicate' : (stored.add(e.id), 'stored') });
    await b.open(true);
    const connectors: Array<{ n: ReturnType<typeof air.phone>; c: HandshakeNearby; got: ReturnType<typeof vi.fn> }> = [];
    for (let i = 0; i < count; i++) {
      const n = air.phone(), got = vi.fn(async () => 'stored' as const);
      const c = new HandshakeNearby(n, { ownSecret: String(i + 1).repeat(64), onChange: () => {}, onEvent: got });
      await c.open(true);
      connectors.push({ n, c, got });
    }
    return { nb, b, connectors, connect: async (i: number) => {
      connectors[i].c.connect({ pubkey: B, secret: 'b'.repeat(64) });
      await vi.waitFor(() => expect(connectors[i].c.route(B)).toBe('linked'));
    } };
  }

  it('binds only the link that freshly stored the event, and only one link per peer (M1)', async () => {
    const { b, connectors, connect } = await joined(2);
    await connect(0); await connect(1);
    const [first, second] = connectors;
    expect(first.n.quiet).toHaveBeenCalledTimes(1);
    expect(await first.c.deliver(B, wrap('a'))).toBe(true);
    // The same id again from another link: acknowledged, but it proves nothing.
    expect(await second.c.deliver(B, wrap('a'))).toBe(true);
    b.bind('a'.repeat(64), PEER);
    expect(b.route(PEER)).toBe('linked');
    await b.deliver(PEER, wrap('c'));
    expect(first.got).toHaveBeenCalledTimes(1);
    expect(second.got).not.toHaveBeenCalled();
    // A later fresh store on the other link cannot take the peer over.
    expect(await second.c.deliver(B, wrap('d'))).toBe(true);
    b.bind('d'.repeat(64), PEER);
    await b.deliver(PEER, wrap('5'));
    expect(first.got).toHaveBeenCalledTimes(2);
    expect(second.got).not.toHaveBeenCalled();
    await Promise.all([b.close(), first.c.close(), second.c.close()]);
  });

  it('gives back the slot of a connection that never authenticates (M2)', async () => {
    const native = radio().phone();
    const carrier = new HandshakeNearby(native, { ownSecret: 'a'.repeat(64), onChange: () => {}, authMs: 30, onEvent: async () => 'stored' as const });
    await carrier.open(true);
    const close = vi.spyOn(native, 'close');
    native.links.set('idle', { peer: native, id: 'idle' });
    native.handlers!.link({ link: 'idle', direction: 'in' });
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith({ link: 'idle' }));
    await carrier.close();
  });

  it('dials up to three times before giving up, so one copied advert cannot end Bluetooth (M2)', async () => {
    const native = radio().phone();
    native.connect = vi.fn(async () => { throw new Error('connect'); });
    const carrier = new HandshakeNearby(native, { ownSecret: 'a'.repeat(64), onChange: () => {}, redialMs: 1, holdMs: 60000, onEvent: async () => 'stored' as const });
    await carrier.open(true);
    carrier.connect({ pubkey: B, secret: 'b'.repeat(64) });
    expect(carrier.route(B)).toBe('pending');
    await vi.waitFor(() => expect(carrier.route(B)).toBe('none'));
    expect(native.connect).toHaveBeenCalledTimes(3);
    await carrier.close();
  });

  it('caps the events one session will store, across replaced links (L6)', async () => {
    const { b, connectors, connect } = await joined(3);
    let accepted = 0;
    for (const [i, c] of connectors.entries()) {
      await connect(i);
      for (let k = 0; k < 64 && accepted < 129; k++) {
        const id = (i * 64 + k).toString(16).padStart(64, '0');
        if (await c.c.deliver(B, { ...wrap('a'), id })) accepted++; else break;
      }
      await c.c.close();
      await vi.waitFor(() => expect(c.c.route(B)).toBe('none'));
    }
    expect(accepted).toBe(128);
    await b.close();
  }, 20000);
});

describe('HandshakeNearby re-check fixes', () => {
  const B = 'f'.repeat(64);
  const frame = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  // Frames sent towards a peer with no listener simply vanish.
  const sink = radio().phone();
  it('asks the shell to skip a device only when it failed to authenticate, not when it hung up (N1)', async () => {
    const native = radio().phone();
    let n = 0;
    native.connect = vi.fn(async () => { const link = `out${++n}`; native.links.set(link, { peer: sink, id: link }); native.handlers!.link({ link, direction: 'out' }); return { link }; });
    const close = vi.spyOn(native, 'close');
    const carrier = new HandshakeNearby(native, { ownSecret: 'a'.repeat(64), onChange: () => {}, redialMs: 1, holdMs: 60000, onEvent: async () => 'stored' as const });
    await carrier.open(true);
    carrier.connect({ pubkey: B, secret: 'b'.repeat(64) });
    await vi.waitFor(() => expect(native.connect).toHaveBeenCalledTimes(1));
    // The far end hangs up (busy, restarting): no skip.
    native.handlers!.closed({ link: 'out1' });
    await vi.waitFor(() => expect(native.connect).toHaveBeenCalledTimes(2));
    expect(close).not.toHaveBeenCalledWith(expect.objectContaining({ avoid: true }));
    // The far end sends a bad first frame: skip that device on rescans.
    native.handlers!.frame({ link: 'out2', data: frame(new Uint8Array(17)) });
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith({ link: 'out2', avoid: true }));
    await carrier.close();
  });

  it('keeps separate incoming and outgoing slots, and the requester stops advertising as it dials (N2)', async () => {
    const native = radio().phone();
    native.connect = vi.fn(async () => { native.links.set('out', { peer: sink, id: 'out' }); native.handlers!.link({ link: 'out', direction: 'out' }); return { link: 'out' }; });
    const close = vi.spyOn(native, 'close');
    const carrier = new HandshakeNearby(native, { ownSecret: 'a'.repeat(64), onChange: () => {}, onEvent: async () => 'stored' as const });
    await carrier.open(true);
    for (const link of ['in1', 'in2', 'in3']) { native.links.set(link, { peer: sink, id: link }); native.handlers!.link({ link, direction: 'in' }); }
    expect(close).toHaveBeenCalledWith({ link: 'in3' });
    carrier.connect({ pubkey: B, secret: 'b'.repeat(64) }, { quiet: true });
    expect(native.quiet).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(native.connect).toHaveBeenCalledTimes(1));
    expect(close).not.toHaveBeenCalledWith({ link: 'out' });
    await carrier.close();
  });

  it('shares one event allowance across the carriers of a screen (L6)', async () => {
    const native = radio().phone();
    const budget = { events: 127 };
    const onEvent = vi.fn(async () => 'stored' as const);
    const carrier = new HandshakeNearby(native, { ownSecret: 'a'.repeat(64), onChange: () => {}, onEvent, budget });
    await carrier.open(true);
    native.links.set('in', { peer: native, id: 'in' });
    native.handlers!.link({ link: 'in', direction: 'in' });
    const peer = new NearbyLink('connector', new Uint8Array(16).fill(9));
    peer.setSecret('a'.repeat(64));
    native.handlers!.frame({ link: 'in', data: frame(peer.hello()) });
    const auth = peer.receive(native.sent[0]).flatMap(s => s.kind === 'send' ? [s.frame] : []);
    native.handlers!.frame({ link: 'in', data: frame(auth[0]) });
    await vi.waitFor(() => expect(native.trusted.size).toBe(1));
    const event = (id: string) => ({ id: id.repeat(64), pubkey: '2'.repeat(64), sig: '3'.repeat(128), kind: 1059, created_at: 1, tags: [['p', '4'.repeat(64)]], content: 'x' });
    native.handlers!.frame({ link: 'in', data: frame(new Uint8Array([3, ...new TextEncoder().encode(JSON.stringify(event('a')))])) });
    native.handlers!.frame({ link: 'in', data: frame(new Uint8Array([3, ...new TextEncoder().encode(JSON.stringify(event('b')))])) });
    await vi.waitFor(() => expect(native.links.has('in')).toBe(false));
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(budget.events).toBe(129);
    await carrier.close();
  });
});

describe('receiveDirect and the relay path racing (N3)', () => {
  it('answers duplicate when the relay recorded the wrap while it was decrypting', async () => {
    const p = party('01'.repeat(32), 'owner', {}), q = party('02'.repeat(32), `dependant:${'b'.repeat(64)}`, {});
    const hs = await q.service.create(q.pubkey, 'Handshake', ['wss://relay.example'], 'single-use', now, now + 120);
    await p.service.request(p.pubkey, hs.invite, now + 1, undefined, undefined, true);
    const wrap = (await p.service.read()).outbox[0].event;
    const stale = await q.service.read();
    const packet = openContactMailboxWrap(wrap, hs.invite.secret)!;
    await recordContactArrival(q.directoryId, KEY, { id: wrap.id, inviteId: hs.id, identityPubkey: q.pubkey, packet, receivedAt: now + 2, channel: 'invite' });
    vi.spyOn(q.service, 'read').mockResolvedValueOnce(stale);
    expect(await q.service.receiveDirect(wrap, { identity: q.pubkey, inviteId: hs.id, now: now + 2 })).toBe('duplicate');
  });
});
