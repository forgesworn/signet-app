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
/** What the receiver did with a wrap: only a fresh store may bind a link. */
export type NearbyReceipt = 'stored' | 'duplicate' | 'rejected';

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
  /** `avoid`: this outgoing link's device failed to authenticate; skip it on rescans. */
  close(opts: { link: string; avoid?: boolean }): Promise<void>;
  /** Stop advertising; existing links carry on. */
  quiet?(): Promise<void>;
  stop(): Promise<void>;
  listen(handlers: {
    link(e: { link: string; direction: 'in' | 'out' }): void;
    frame(e: { link: string; data: string }): void;
    closed(e: { link: string }): void;
  }): Promise<() => void>;
  /** The app left or returned to the screen, where the page cannot tell. */
  lifecycle?(handler: (state: 'background' | 'foreground') => void): Promise<() => void>;
}

const toBase64 = (bytes: Uint8Array) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
function fromBase64(text: string): Uint8Array | null {
  try { const s = atob(text); return Uint8Array.from(s, c => c.charCodeAt(0)); } catch { return null; }
}
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_INCOMING = 2, MAX_OUTGOING = 1, MAX_EVENTS_PER_LINK = 64, MAX_EVENTS_PER_SESSION = 128, MAX_DIALS = 3;

interface LinkState {
  /** `peer`: the persona this link speaks for, once bound. */
  id: string; link: NearbyLink; outgoing: boolean; peer?: string;
  delivered: Set<string>; acks: Map<string, (stored: boolean) => void>;
  queue: Promise<void>; events: number;
}

/**
 * One handshake screen's Bluetooth session. Every phone advertises a token
 * derived from its session key; a phone that read its peer's session from the
 * screen connects to that token (or, as the advertiser, accepts only that
 * session). A link authenticates with the two session keys, carries reveals
 * for a session (`deliverSession`), and speaks for a persona only once bound:
 * when a reveal verified under the camera-read session names it
 * (`bindSession`), or when a message it carried opens as an SDK message signed
 * by that persona (`bind`).
 */
export class HandshakeNearby implements DirectCarrier {
  private links = new Map<string, LinkState>();
  private target?: { session: string; holdUntil: number; failed: boolean; dialling: boolean; dials: number };
  private expected?: string;
  private closed = false;
  private stopListening?: () => void;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  availability: NearbyAvailability | 'starting' = 'starting';

  constructor(private native: NearbyNative, private opts: {
    /** This screen's session: its key is advertised, its secret keys the links. */
    session: { secret: Uint8Array; publicKey: string };
    /** Store one received wrap: `stored` now, a verified `duplicate` of one
     * already stored, or `rejected`. */
    onEvent(event: NostrEvent): Promise<NearbyReceipt>;
    onChange(): void;
    nowMs?(): number; random?(n: number): Uint8Array;
    holdMs?: number; ackMs?: number; connectMs?: number; authMs?: number; redialMs?: number;
    /** Shared across the carriers of one handshake screen, so returning to
     * the foreground does not refill the event allowance. */
    budget?: { events: number };
  }) {}
  private ownBudget = { events: 0 };
  private get budget() { return this.opts.budget ?? this.ownBudget; }
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
      await this.native.advertise({ token: toBase64(nearbyToken(this.opts.session.publicKey)) });
      if (this.closed) return 'failed';
      settle('ready');
      if (this.quietWanted) this.quieten();
      this.dial();
      return 'ready';
    } catch { return settle('failed'); }
    finally { if (this.availability !== 'ready' && this.target) this.target.failed = true; }
  }

  /** Connect to the session this phone read from its peer's screen. One
   * target per screen; a scan made while the permission prompt is up connects
   * once it is ready. `quiet`: this phone needs no incoming link. */
  connect(peer: { session: string }, opts: { quiet?: boolean } = {}) {
    if (this.closed || this.target || !HEX64.test(peer.session)
      || (this.availability !== 'ready' && this.availability !== 'starting')) return;
    this.expect(peer.session);
    const hold = this.opts.holdMs ?? 5000;
    this.target = { session: peer.session, holdUntil: this.now() + hold, failed: false as boolean, dialling: false as boolean, dials: 0 };
    this.later(hold, () => this.changed());
    if (opts.quiet) { this.quietWanted = true; this.quieten(); }
    this.dial();
  }
  private quietWanted = false;
  private quieten() { if (this.availability === 'ready' && !this.closed) void this.native.quiet?.().catch(() => {}); }
  /** Up to three dials: a copied advert or a dropped connection costs one,
   * and the native scan skips a device whose link failed to authenticate. */
  private dial() {
    const target = this.target;
    if (!target || target.dialling || target.failed || this.availability !== 'ready' || this.closed) return;
    if ([...this.links.values()].some(s => s.outgoing)) return;
    if (target.dials >= MAX_DIALS) { target.failed = true; this.changed(); return; }
    target.dials++;
    target.dialling = true;
    this.native.connect({ token: toBase64(nearbyToken(target.session)), timeoutMs: this.opts.connectMs ?? 30000 })
      .then(() => { target.dialling = false; })
      .catch(() => { target.dialling = false; this.redial(); });
  }
  private redial() {
    const target = this.target;
    if (!target || this.closed || target.failed) return;
    if (target.dials >= MAX_DIALS) { target.failed = true; this.changed(); return; }
    this.later(this.opts.redialMs ?? 300, () => this.dial());
  }

  /** This phone read its peer's session from the screen: a link from any
   * other session is dropped, now and later. */
  expect(session: string) {
    if (this.closed || !HEX64.test(session) || this.expected === session) return;
    this.expected = session;
    for (const state of [...this.links.values()]) if (!state.link.expect(session)) this.drop(state);
  }
  /** The link for `session` speaks for `persona`: a reveal verified under the
   * session this phone's camera read named it. */
  bindSession(session: string, persona: string) {
    const all = [...this.links.values()];
    if (all.some(s => s.peer === persona)) return;
    const state = all.find(s => s.link.trusted && !s.peer && s.link.peerSession === session);
    if (state) { state.peer = persona; this.changed(); }
  }
  /** True when a trusted link reaches this session. */
  reaches(session: string): boolean {
    return [...this.links.values()].some(s => s.link.trusted && s.link.peerSession === session);
  }

  /** The SDK opened `eventId` as a message signed by `peer`: the link that
   * carried it now speaks for that peer. */
  bind(eventId: string, peer: string) {
    const all = [...this.links.values()];
    // One link per peer: a later link cannot take over rows already routed.
    if (all.some(s => s.peer === peer)) return;
    const state = all.find(s => s.link.trusted && !s.peer && s.delivered.has(eventId));
    if (state) { state.peer = peer; this.changed(); }
  }

  route(counterparty: string): NearbyRoute {
    if (this.closed) return 'none';
    for (const state of this.links.values()) if (state.peer === counterparty && state.link.trusted) return 'linked';
    // One peer per screen, whose persona is not known until its reveal: hold
    // while a dial to its session is still being made.
    const t = this.target;
    return t && !t.failed && this.now() < t.holdUntil && !this.reaches(t.session) ? 'pending' : 'none';
  }

  get linked(): boolean { return [...this.links.values()].some(s => s.link.trusted); }

  async deliver(counterparty: string, event: NostrEvent): Promise<boolean> {
    return this.sendEvent([...this.links.values()].find(s => s.peer === counterparty && s.link.trusted), event);
  }
  /** A reveal for the peer's session, before anyone knows whose it is. */
  async deliverSession(session: string, event: NostrEvent): Promise<boolean> {
    return this.sendEvent([...this.links.values()].find(s => s.link.trusted && s.link.peerSession === session), event);
  }
  private async sendEvent(state: LinkState | undefined, event: NostrEvent): Promise<boolean> {
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
  /** `avoid` only for our own judgement that the far end failed to
   * authenticate (bad frame, bad MAC, silent past the deadline), never for a
   * remote close: a busy or restarting real peer must not be skipped. */
  private drop(state: LinkState, avoid = false) {
    if (!this.links.has(state.id)) return;
    this.links.delete(state.id);
    this.forget(state);
    if (state.outgoing && !state.link.trusted) this.redial();
    void this.native.close({ link: state.id, ...(avoid && state.outgoing && !state.link.trusted ? { avoid: true } : {}) }).catch(() => {});
    this.changed();
  }
  private onLink(e: { link: string; direction: 'in' | 'out' }) {
    const outgoing = e.direction === 'out';
    const expected = outgoing ? this.target?.session : this.expected;
    const same = [...this.links.values()].filter(s => s.outgoing === outgoing).length;
    if (this.closed || typeof e.link !== 'string' || this.links.has(e.link) || same >= (outgoing ? MAX_OUTGOING : MAX_INCOMING) || (outgoing && !expected)) {
      void this.native.close({ link: e.link }).catch(() => {});
      return;
    }
    const state: LinkState = { id: e.link, link: new NearbyLink(outgoing ? 'connector' : 'advertiser', this.random(NEARBY_NONCE_BYTES),
      this.opts.session, expected), outgoing, delivered: new Set(), acks: new Map(), queue: Promise.resolve(), events: 0 };
    this.links.set(e.link, state);
    this.send(state, state.link.hello());
    // An idle or failing connection gives its slot back.
    this.later(this.opts.authMs ?? 6000, () => { if (this.links.get(e.link) === state && !state.link.trusted) this.drop(state, true); });
  }
  private onFrame(e: { link: string; data: string }) {
    const state = this.links.get(e.link);
    const bytes = typeof e.data === 'string' ? fromBase64(e.data) : null;
    if (!state) { void this.native.close({ link: e.link }).catch(() => {}); return; }
    if (!bytes) { this.drop(state, true); return; }
    for (const step of state.link.receive(bytes)) this.step(state, step);
  }
  private step(state: LinkState, step: NearbyStep) {
    if (step.kind === 'send') this.send(state, step.frame);
    else if (step.kind === 'drop') this.drop(state, true);
    else if (step.kind === 'trusted') {
      void this.native.trust({ link: state.id }).catch(() => this.drop(state));
      // A phone with its own outgoing link needs no advert.
      if (state.outgoing) this.quieten();
      this.changed();
    } else if (step.kind === 'ack') {
      const resolve = state.acks.get(step.id);
      state.acks.delete(step.id);
      resolve?.(step.stored);
    } else if (step.kind === 'event') {
      if (++state.events > MAX_EVENTS_PER_LINK || ++this.budget.events > MAX_EVENTS_PER_SESSION) { this.drop(state); return; }
      const event = step.event;
      state.queue = state.queue.then(async () => {
        let receipt: NearbyReceipt = 'rejected';
        try { receipt = await this.opts.onEvent(event); } catch { receipt = 'rejected'; }
        if (!this.links.has(state.id)) return;
        // Only a fresh store binds; a duplicate is acknowledged but proves nothing.
        if (receipt === 'stored') state.delivered.add(event.id);
        this.send(state, state.link.ack(event.id, receipt !== 'rejected'));
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
    quiet: () => SignetNative.nearbyQuiet(),
    stop: () => SignetNative.nearbyStop(),
    async listen(handlers) {
      const subs = await Promise.all([
        SignetNative.addListener('nearbyLink', handlers.link),
        SignetNative.addListener('nearbyFrame', handlers.frame),
        SignetNative.addListener('nearbyClosed', handlers.closed),
      ]);
      return () => { for (const sub of subs) void sub.remove(); };
    },
    async lifecycle(handler) {
      const sub = await SignetNative.addListener('nearbyLifecycle', e => handler(e.state === 'background' ? 'background' : 'foreground'));
      return () => { void sub.remove(); };
    },
  };
}
