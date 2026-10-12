import type { NostrEvent, NostrFilter } from 'signet-protocol';
import { nativeNfc, type HandshakeNfc, type HandshakeNfcHandle } from './handshake-nfc';
import { nativeNearby, takeNearbyEnablePrompt, type NearbyNative } from './handshake-nearby';
import { createHandshakeSession, type HandshakeSession } from './handshake-reveal';
import { ChildPairLink, type ChildPairLinkState } from './child-pair-nearby';
import { classifyTappedCode, writeChildPairCode } from './child-pair-nfc';
import { isNativeApp, SignetNative } from './native';

// The tap-and-Bluetooth leg of pairing a child's phone, as one object both
// phones use: a fresh session keypair per attempt, an NFC code that is re-armed
// before it expires, the first tapped child-pair code becoming the one peer
// this attempt will ever link with, and the Bluetooth link to it. It decides
// nothing about the pairing itself: the guardian and child ceremonies run over
// it exactly as over a relay (`tapPairingTransport`, `childTapDeps`).

export type TapRadioReason = 'unsupported' | 'off' | 'denied' | 'failed';
export type ChildPairTapPhase = 'idle' | 'arming' | 'waiting' | 'linking' | 'linked' | 'lost' | 'unavailable';

export interface ChildPairTapState {
  phase: ChildPairTapPhase;
  /** Can this phone pair by tap? `null` until probed. NFC off, no NFC/Bluetooth or a refused permission is `false`. */
  available: boolean | null;
  reason?: TapRadioReason;
  /** A different pairing phone was tapped after this attempt's peer was taken; it was ignored. */
  secondPhone: boolean;
  /** The tapped phone is on the Handshake screen. */
  wrongScreen: 'handshake' | null;
  /** Why the link last closed (`link-lost`, `unreachable`, `background`). */
  linkReason?: string;
}

export interface ChildPairTapOptions {
  /** The NFC tap; defaults to the APK's, none in a browser. */
  nfc?: HandshakeNfc | null;
  /** The Bluetooth pipe; defaults to the APK's. */
  native?: NearbyNative | null;
  nowMs?: () => number;
  /** Keep the screen on while an attempt is active; defaults to the Handshake's native call. */
  awake?: (active: boolean) => void;
}

export interface TapBeginOptions {
  /** The guardian's `signet-child:` URI: sent once the link is up. */
  offerUri?: string;
  /** Ask for the Bluetooth permission / adapter; defaults to once per app run, like the Handshake. */
  askToEnable?: boolean;
}

/** A code is re-armed this long before its 120 s life ends, while still waiting for a tap. */
export const REARM_BEFORE_EXPIRY_S = 30;
const SESSION_SECONDS = 120;
const OFFER_RETRIES = 4;
const OFFER_RETRY_MS = 1000;
/** How long a reply waits for the link's ACK before the relay carries it instead. */
export const LINK_ACK_TIMEOUT_MS = 5000;

const defaultAwake = (active: boolean) => {
  if (isNativeApp()) void SignetNative.handshakeAwake({ active }).catch(() => {});
};

export class ChildPairTap {
  private s: ChildPairTapState = { phase: 'idle', available: null, secondPhone: false, wrongScreen: null };
  private attemptNo = 0;
  private session: HandshakeSession | null = null;
  private peer: string | null = null;
  private link: ChildPairLink | null = null;
  private nfcHandle: HandshakeNfcHandle | null = null;
  private rearm: ReturnType<typeof setTimeout> | null = null;
  private offerUri: string | undefined;
  private offerAcked = false;
  private offerSending = false;
  private askToEnable = false;
  private awakeOn = false;
  private lastOffer: string | null = null;
  private readonly eventHandlers = new Set<(event: NostrEvent) => void>();
  private readonly offerHandlers = new Set<(uri: string) => void>();

  constructor(private readonly opts: () => ChildPairTapOptions = () => ({}), private readonly onChange: (s: ChildPairTapState) => void = () => {}) {}

  get state(): ChildPairTapState { return this.s; }
  /** Id of the running attempt (0 when none); `end(id)` ends only that attempt. */
  get attempt(): number { return this.session ? this.attemptNo : 0; }
  get linked(): boolean { return !!this.link?.linked; }

  private set(patch: Partial<ChildPairTapState>) {
    this.s = { ...this.s, ...patch };
    this.onChange(this.s);
  }
  private nowS() { return Math.floor((this.opts().nowMs ?? Date.now)() / 1000); }
  private nfc(): HandshakeNfc | null {
    const o = this.opts();
    return o.nfc === undefined ? nativeNfc() : o.nfc;
  }
  private native(): NearbyNative | null {
    const o = this.opts();
    return o.native === undefined ? nativeNearby() : o.native;
  }

  /** Availability only: no prompts, no radios started. Bluetooth being off or not yet permitted is
   * not a reason to lead with QR (arming asks); NFC being off or absent is. */
  async probe(): Promise<ChildPairTapState> {
    if (this.session) return this.s;
    const unavailable = (reason: TapRadioReason) => { this.set({ available: false, reason }); return this.s; };
    const nfc = this.nfc();
    if (!nfc) return unavailable('unsupported');
    try {
      const status = await nfc.status();
      if (!status.supported) return unavailable('unsupported');
      if (!status.enabled) return unavailable('off');
      const native = this.native();
      if (!native) return unavailable('unsupported');
      if (!(await native.status()).supported) return unavailable('unsupported');
    } catch { return unavailable('failed'); }
    if (this.session) return this.s;
    this.set({ available: true, reason: undefined });
    return this.s;
  }

  /** Start an attempt: fresh session key, keep the screen on, arm NFC. False (with `state.reason`) when the radios cannot be used. */
  async begin(options: TapBeginOptions = {}): Promise<boolean> {
    this.end();
    const attempt = ++this.attemptNo;
    this.askToEnable = options.askToEnable ?? takeNearbyEnablePrompt();
    this.offerUri = options.offerUri;
    this.offerAcked = false;
    this.lastOffer = null;
    this.set({ phase: 'arming', secondPhone: false, wrongScreen: null, linkReason: undefined });
    const session = createHandshakeSession();
    this.session = session;
    this.setAwake(true);
    const failed = (reason: TapRadioReason) => {
      if (this.attemptNo === attempt) { this.teardown(); this.set({ available: false, reason, phase: 'unavailable' }); }
      return false;
    };
    const nfc = this.nfc();
    if (!nfc) return failed('unsupported');
    try {
      const status = await nfc.status();
      if (this.attemptNo !== attempt) return false;
      if (!status.supported) return failed('unsupported');
      if (!status.enabled) return failed('off');
      const native = this.native();
      if (!native) return failed('unsupported');
      const radio = await native.status();
      if (this.attemptNo !== attempt) return false;
      if (!radio.supported) return failed('unsupported');
      if (!radio.permitted && !(await native.permission()).granted) return failed('denied');
      if (this.attemptNo !== attempt) return false;
      if (!radio.enabled && (!this.askToEnable || !(await native.enable()).enabled)) return failed('off');
      if (this.attemptNo !== attempt) return false;
      await this.arm(attempt);
    } catch { return failed('failed'); }
    if (this.attemptNo !== attempt || !this.session) return false;
    this.set({ available: true, reason: undefined, phase: this.peer ? this.s.phase : 'waiting' });
    return true;
  }

  private async arm(attempt: number): Promise<void> {
    const nfc = this.nfc(), session = this.session;
    if (!nfc || !session) return;
    const code = writeChildPairCode(session, this.nowS());
    const handle = await nfc.start(code, raw => this.tapped(attempt, raw));
    if (this.attemptNo !== attempt || !this.session) { handle.stop(); return; }
    const previous = this.nfcHandle;
    this.nfcHandle = handle;
    previous?.stop();
    this.scheduleRearm(attempt);
  }

  private scheduleRearm(attempt: number) {
    if (this.rearm) clearTimeout(this.rearm);
    this.rearm = setTimeout(() => {
      this.rearm = null;
      // Once a peer is taken the code is never offered afresh; it only needs to outlive the tap.
      if (this.attemptNo !== attempt || !this.session || this.peer) return;
      void this.arm(attempt).catch(() => {});
    }, (SESSION_SECONDS - REARM_BEFORE_EXPIRY_S) * 1000);
  }

  private tapped(attempt: number, raw: string) {
    const session = this.session;
    if (this.attemptNo !== attempt || !session) return;
    const code = classifyTappedCode(raw, this.nowS());
    if (code.kind === 'handshake') { this.set({ wrongScreen: 'handshake' }); return; }
    if (code.kind !== 'child-pair') return;
    if (code.sessionPubkey === session.publicKey) return;
    if (this.peer) {
      if (code.sessionPubkey !== this.peer) this.set({ secondPhone: true });
      return;
    }
    this.peer = code.sessionPubkey;
    if (this.rearm) { clearTimeout(this.rearm); this.rearm = null; }
    this.set({ phase: 'linking', wrongScreen: null, secondPhone: false });
    const link = this.link = new ChildPairLink({
      session, peerSession: code.sessionPubkey, native: this.native() ?? undefined,
      onEvent: event => { for (const handler of [...this.eventHandlers]) handler(event); },
      onOffer: uri => {
        this.lastOffer = uri;
        for (const handler of [...this.offerHandlers]) handler(uri);
      },
      onState: (state, reason) => { if (this.link === link) this.linkState(attempt, state, reason); },
    });
    void link.open(this.askToEnable).catch(() => {});
  }

  private linkState(attempt: number, state: ChildPairLinkState, reason?: string) {
    if (this.attemptNo !== attempt || !this.session) return;
    switch (state) {
      case 'starting': case 'connecting': this.set({ phase: 'linking' }); break;
      case 'linked':
        this.set({ phase: 'linked', linkReason: undefined });
        void this.sendOfferNow(attempt);
        break;
      case 'unavailable': {
        const r: TapRadioReason = reason === 'unsupported' || reason === 'off' || reason === 'denied' ? reason : 'failed';
        this.set({ available: false, reason: r, phase: 'unavailable' });
        break;
      }
      case 'closed': this.set({ phase: 'lost', linkReason: reason }); break;
    }
  }

  private async sendOfferNow(attempt: number) {
    const uri = this.offerUri;
    if (!uri || this.offerAcked || this.offerSending) return;
    this.offerSending = true;
    try {
      for (let i = 0; i < OFFER_RETRIES; i++) {
        if (this.attemptNo !== attempt || !this.link?.linked) return;
        if (await this.link.sendOffer(uri)) { this.offerAcked = true; return; }
        await new Promise(r => setTimeout(r, OFFER_RETRY_MS));
      }
    } finally { this.offerSending = false; }
  }

  /** True once the peer ACKs. False when there is no live link. */
  sendOffer(uri: string): Promise<boolean> { return this.link ? this.link.sendOffer(uri) : Promise.resolve(false); }
  sendEvent(event: NostrEvent): Promise<boolean> { return this.link ? this.link.sendEvent(event) : Promise.resolve(false); }

  /** Pairing events from the peer's link. */
  onEvent(handler: (event: NostrEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => { this.eventHandlers.delete(handler); };
  }
  /** The peer's offer URI; one that already arrived is replayed. */
  onOffer(handler: (uri: string) => void): () => void {
    this.offerHandlers.add(handler);
    if (this.lastOffer !== null) handler(this.lastOffer);
    return () => { this.offerHandlers.delete(handler); };
  }

  private setAwake(active: boolean) {
    if (this.awakeOn === active) return;
    this.awakeOn = active;
    (this.opts().awake ?? defaultAwake)(active);
  }

  private teardown() {
    if (this.rearm) { clearTimeout(this.rearm); this.rearm = null; }
    this.link?.close();
    this.link = null;
    this.nfcHandle?.stop();
    this.nfcHandle = null;
    this.setAwake(false);
    // The session secret is the only proof this phone is the one that was tapped.
    this.session?.secret.fill(0);
    this.session = null;
    this.peer = null;
    this.offerUri = undefined;
    this.lastOffer = null;
  }

  /** Close the link, stop NFC and release the screen. Safe to call twice. With `attempt`, ends only that attempt. */
  end(attempt?: number): void {
    if (attempt !== undefined && attempt !== this.attempt) return;
    if (!this.session) return;
    this.attemptNo++;
    this.teardown();
    this.set({ phase: 'idle', secondPhone: false, wrongScreen: null, linkReason: undefined });
  }
}

/** Does `event` satisfy a relay filter's kinds / authors / ids / #tag lists? Used for local filtering of link events. */
export function eventMatchesFilter(event: NostrEvent, filter: NostrFilter): boolean {
  const f = filter as Record<string, unknown>;
  const listed = (key: string) => (Array.isArray(f[key]) ? (f[key] as unknown[]) : null);
  const kinds = listed('kinds');
  if (kinds && !kinds.includes(event.kind)) return false;
  const authors = listed('authors');
  if (authors && !authors.includes(event.pubkey)) return false;
  const ids = listed('ids');
  if (ids && !ids.includes(event.id)) return false;
  for (const key of Object.keys(f)) {
    if (!key.startsWith('#')) continue;
    const wanted = listed(key);
    if (!wanted) continue;
    const name = key.slice(1);
    if (!event.tags.some(t => t[0] === name && wanted.includes(t[1]))) return false;
  }
  // `since`/`until` are deliberately not applied: they exist to bound a relay's history, and a direct
  // link has none. Freshness is checked by the pairing code itself (created_at, 240 s, 600 s TTL).
  return true;
}

type PublishResult = { ok: boolean; message: string };
const timeoutAfter = <T>(ms: number, value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms));

/** The guardian's `PairingTransport` over the link: events come only off the link (no relay request
 * subscription), and a publish goes over the link when it ACKs within the timeout, otherwise on the relay. */
export function tapPairingTransport(
  tap: Pick<ChildPairTap, 'onEvent' | 'sendEvent'>,
  relay: { publish(event: NostrEvent, relays: string[]): Promise<PublishResult> },
  ackTimeoutMs = LINK_ACK_TIMEOUT_MS,
) {
  return {
    async publish(event: NostrEvent, relays: string[]): Promise<PublishResult> {
      const acked = await Promise.race([tap.sendEvent(event).catch(() => false), timeoutAfter(ackTimeoutMs, false)]);
      return acked ? { ok: true, message: 'link' } : relay.publish(event, relays);
    },
    subscribe(filters: NostrFilter[], _relays: string[], onEvent: (event: NostrEvent) => void): () => void {
      return tap.onEvent(event => { if (filters.some(f => eventMatchesFilter(event, f))) onEvent(event); });
    },
  };
}
