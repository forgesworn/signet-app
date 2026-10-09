import type { NostrEvent } from 'signet-protocol';
import { NearbyLink, NEARBY_NONCE_BYTES, nearbyEventFrame, nearbyToken, type NearbyStep } from './handshake-nearby-wire';
import { isNativeApp, SignetNative } from './native';

/** How the contact outbox may reach one counterparty right now. `pending`
 * holds a handshake row back from the relays while a nearby link is being
 * made, for a bounded time, so a working link leaves no relay footprint. */
export type NearbyRoute = 'linked' | 'pending' | 'none';
export interface DirectCarrier {
  route(counterparty: string): NearbyRoute;
  /** True only when the peer's authenticated receipt says it stored the event. */
  deliver(counterparty: string, event: NostrEvent): Promise<boolean>;
}
export type NearbyAvailability = 'ready' | 'unsupported' | 'denied' | 'off' | 'failed';

/** The native byte pipe (Android 12+, LE L2CAP CoC). It parses nothing:
 * frames are length-prefixed and capped, small until `trust`. */
export interface NearbyNative {
  status(): Promise<{ supported: boolean; enabled: boolean; permitted: boolean }>;
  permission(): Promise<{ granted: boolean }>;
  enable(): Promise<{ enabled: boolean }>;
  advertise(opts: { token: string }): Promise<{ psm: number }>;
  connect(opts: { token: string; timeoutMs: number }): Promise<{ link: string }>;
  send(opts: { link: string; data: string }): Promise<void>;
  trust(opts: { link: string }): Promise<void>;
  close(opts: { link: string }): Promise<void>;
  stop(): Promise<void>;
  listen(handlers: {
    link(e: { link: string; direction: 'in' | 'out' }): void;
    frame(e: { link: string; data: string }): void;
    closed(e: { link: string }): void;
  }): Promise<() => void>;
}

const toBase64 = (bytes: Uint8Array) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
function fromBase64(text: string): Uint8Array | null {
  try { const s = atob(text); return Uint8Array.from(s, c => c.charCodeAt(0)); } catch { return null; }
}
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_LINKS = 2, MAX_EVENTS_PER_LINK = 64;

interface LinkState {
  id: string; link: NearbyLink; outgoing: boolean; peer?: string;
  delivered: Set<string>; acks: Map<string, (stored: boolean) => void>;
  queue: Promise<void>; events: number;
}

/**
 * One handshake screen's Bluetooth session. Every phone advertises a token
 * derived from its own QR secret; the phone that sends the first SDK message
 * (the requester, or the one-way scanner) connects to the token of the QR it
 * read. A link is used only after it authenticates under that QR's secret, and
 * for a counterparty only once it is bound: an outgoing link at once (camera-
 * read secret), an incoming one when a message it carried opens as an SDK
 * message signed by that counterparty (`bind`).
 */
export class HandshakeNearby implements DirectCarrier {
  private links = new Map<string, LinkState>();
  private target?: { pubkey: string; secret: string; holdUntil: number; failed: boolean; dialled: boolean };
  private closed = false;
  private stopListening?: () => void;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  availability: NearbyAvailability | 'starting' = 'starting';

  constructor(private native: NearbyNative, private opts: {
    ownSecret: string;
    /** Store one received wrap; true when it is (now or already) stored. */
    onEvent(event: NostrEvent): Promise<boolean>;
    onChange(): void;
    nowMs?(): number; random?(n: number): Uint8Array;
    holdMs?: number; ackMs?: number; connectMs?: number;
  }) {}
  private now() { return this.opts.nowMs?.() ?? Date.now(); }
  private random(n: number) { return this.opts.random?.(n) ?? crypto.getRandomValues(new Uint8Array(n)); }
  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.closed) fn(); }, ms);
    this.timers.add(t);
  }
  private changed() { if (!this.closed) this.opts.onChange(); }

  /** Permission and adapter prompts happen here, once per screen. */
  async open(askToEnable: boolean): Promise<NearbyAvailability> {
    const settle = (value: NearbyAvailability) => { this.availability = value; this.changed(); return value; };
    try {
      this.stopListening = await this.native.listen({
        link: e => this.onLink(e), frame: e => this.onFrame(e), closed: e => this.onClosed(e.link),
      });
      if (this.closed) { this.stopListening(); return 'failed'; }
      let status = await this.native.status();
      if (!status.supported) return settle('unsupported');
      if (!status.permitted && !(await this.native.permission()).granted) return settle('denied');
      if (!status.enabled) {
        if (!askToEnable || !(await this.native.enable()).enabled) return settle('off');
        status = await this.native.status();
        if (!status.enabled) return settle('off');
      }
      if (this.closed) return 'failed';
      await this.native.advertise({ token: toBase64(nearbyToken(this.opts.ownSecret)) });
      if (this.closed) return 'failed';
      settle('ready');
      this.dial();
      return 'ready';
    } catch { return settle('failed'); }
    finally { if (this.availability !== 'ready' && this.target) this.target.failed = true; }
  }

  /** Connect to the phone whose QR this one read. One attempt per screen;
   * a scan made while the permission prompt is up connects once it is ready. */
  connect(peer: { pubkey: string; secret: string }) {
    if (this.closed || this.target || !HEX64.test(peer.pubkey) || !HEX64.test(peer.secret)
      || (this.availability !== 'ready' && this.availability !== 'starting')) return;
    const hold = this.opts.holdMs ?? 5000;
    this.target = { ...peer, holdUntil: this.now() + hold, failed: false as boolean, dialled: false as boolean };
    this.later(hold, () => this.changed());
    this.dial();
  }
  private dial() {
    const target = this.target;
    if (!target || target.dialled || target.failed || this.availability !== 'ready' || this.closed) return;
    target.dialled = true;
    this.native.connect({ token: toBase64(nearbyToken(target.secret)), timeoutMs: this.opts.connectMs ?? 30000 })
      .catch(() => { target.failed = true; this.changed(); });
  }

  /** The SDK opened `eventId` as a message signed by `peer`: the link that
   * carried it now speaks for that peer. */
  bind(eventId: string, peer: string) {
    for (const state of this.links.values()) {
      if (state.link.trusted && !state.peer && state.delivered.has(eventId)) { state.peer = peer; this.changed(); }
    }
  }

  route(counterparty: string): NearbyRoute {
    if (this.closed) return 'none';
    for (const state of this.links.values()) if (state.peer === counterparty && state.link.trusted) return 'linked';
    const t = this.target;
    return t && t.pubkey === counterparty && !t.failed && this.now() < t.holdUntil ? 'pending' : 'none';
  }

  get linked(): boolean { return [...this.links.values()].some(s => s.peer && s.link.trusted); }

  async deliver(counterparty: string, event: NostrEvent): Promise<boolean> {
    const state = [...this.links.values()].find(s => s.peer === counterparty && s.link.trusted);
    const frame = state && nearbyEventFrame(event);
    if (!state || !frame || state.acks.has(event.id)) return false;
    const receipt = new Promise<boolean>(resolve => {
      state.acks.set(event.id, resolve);
      this.later(this.opts.ackMs ?? 6000, () => { if (state.acks.get(event.id) === resolve) { state.acks.delete(event.id); resolve(false); } });
    });
    try { await this.native.send({ link: state.id, data: toBase64(frame) }); }
    catch { state.acks.get(event.id)?.(false); state.acks.delete(event.id); return false; }
    return receipt;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const state of this.links.values()) this.forget(state);
    this.links.clear();
    this.stopListening?.();
    await this.native.stop().catch(() => {});
  }

  private forget(state: LinkState) {
    state.link.close();
    for (const resolve of state.acks.values()) resolve(false);
    state.acks.clear();
  }
  private send(state: LinkState, frame: Uint8Array) {
    void this.native.send({ link: state.id, data: toBase64(frame) }).catch(() => this.drop(state));
  }
  private drop(state: LinkState) {
    if (!this.links.has(state.id)) return;
    this.links.delete(state.id);
    this.forget(state);
    if (state.outgoing && !state.peer && this.target) this.target.failed = true;
    void this.native.close({ link: state.id }).catch(() => {});
    this.changed();
  }
  private onLink(e: { link: string; direction: 'in' | 'out' }) {
    const outgoing = e.direction === 'out';
    const secret = outgoing ? this.target?.secret : this.opts.ownSecret;
    if (this.closed || typeof e.link !== 'string' || this.links.has(e.link) || this.links.size >= MAX_LINKS || !secret) {
      void this.native.close({ link: e.link }).catch(() => {});
      return;
    }
    const state: LinkState = { id: e.link, link: new NearbyLink(outgoing ? 'connector' : 'advertiser', this.random(NEARBY_NONCE_BYTES)),
      outgoing, delivered: new Set(), acks: new Map(), queue: Promise.resolve(), events: 0 };
    this.links.set(e.link, state);
    state.link.setSecret(secret);
    this.send(state, state.link.hello());
  }
  private onFrame(e: { link: string; data: string }) {
    const state = this.links.get(e.link);
    const bytes = typeof e.data === 'string' ? fromBase64(e.data) : null;
    if (!state) { void this.native.close({ link: e.link }).catch(() => {}); return; }
    if (!bytes) { this.drop(state); return; }
    for (const step of state.link.receive(bytes)) this.step(state, step);
  }
  private step(state: LinkState, step: NearbyStep) {
    if (step.kind === 'send') this.send(state, step.frame);
    else if (step.kind === 'drop') this.drop(state);
    else if (step.kind === 'trusted') {
      void this.native.trust({ link: state.id }).catch(() => this.drop(state));
      // The camera read this secret: an outgoing link speaks for that QR's owner.
      if (state.outgoing && this.target) state.peer = this.target.pubkey;
      this.changed();
    } else if (step.kind === 'ack') {
      const resolve = state.acks.get(step.id);
      state.acks.delete(step.id);
      resolve?.(step.stored);
    } else if (step.kind === 'event') {
      if (++state.events > MAX_EVENTS_PER_LINK) { this.drop(state); return; }
      const event = step.event;
      state.queue = state.queue.then(async () => {
        let stored = false;
        try { stored = await this.opts.onEvent(event); } catch { stored = false; }
        if (!this.links.has(state.id)) return;
        if (stored) state.delivered.add(event.id);
        this.send(state, state.link.ack(event.id, stored));
      });
    }
  }
  private onClosed(link: string) {
    const state = this.links.get(link);
    if (state) this.drop(state);
  }
}

let active: HandshakeNearby | null = null;
/** At most one handshake screen is open; the contact service routes through it. */
export function setActiveHandshakeNearby(carrier: HandshakeNearby) { active = carrier; }
export function clearActiveHandshakeNearby(carrier: HandshakeNearby) { if (active === carrier) active = null; }
export const handshakeDirect: DirectCarrier = {
  route: counterparty => active?.route(counterparty) ?? 'none',
  deliver: (counterparty, event) => active ? active.deliver(counterparty, event) : Promise.resolve(false),
};

/** Asked at most once per app run: a refusal is not repeated on every screen. */
let enableAsked = false;
export function takeNearbyEnablePrompt(): boolean { const ask = !enableAsked; enableAsked = true; return ask; }

export function nativeNearby(): NearbyNative | null {
  if (!isNativeApp()) return null;
  return {
    status: () => SignetNative.nearbyStatus(),
    permission: () => SignetNative.nearbyPermission(),
    enable: () => SignetNative.nearbyEnable(),
    advertise: opts => SignetNative.nearbyAdvertise(opts),
    connect: opts => SignetNative.nearbyConnect(opts),
    send: opts => SignetNative.nearbySend(opts),
    trust: opts => SignetNative.nearbyTrust(opts),
    close: opts => SignetNative.nearbyClose(opts),
    stop: () => SignetNative.nearbyStop(),
    async listen(handlers) {
      const subs = await Promise.all([
        SignetNative.addListener('nearbyLink', handlers.link),
        SignetNative.addListener('nearbyFrame', handlers.frame),
        SignetNative.addListener('nearbyClosed', handlers.closed),
      ]);
      return () => { for (const sub of subs) void sub.remove(); };
    },
  };
}
