import type { NostrEvent } from 'signet-protocol';
import { HandshakeNearby, nativeNearby, type NearbyNative } from './handshake-nearby';
import { sessionDialler } from './handshake-reveal';

// The Bluetooth leg of pairing a child's phone: the same carrier as the
// Handshake (authenticated by the two session keys swapped in the NFC tap),
// under the 'child-pair' profile. It moves the guardian's `signet-child:` offer
// one way and kind-30078 pairing events both ways. It decides nothing: the
// pairing code verifies every event exactly as it would one off a relay.

export type ChildPairLinkState = 'starting' | 'connecting' | 'linked' | 'closed' | 'unavailable';
export interface ChildPairLinkOptions {
  /** Fresh per attempt: never the rail key, so the advertised token is unlinkable. */
  session: { secret: Uint8Array; publicKey: string };
  /** The peer's 64-hex session pubkey, learned from the NFC tap. No other session may link. */
  peerSession: string;
  native?: NearbyNative;
  /** A validated kind-30078 pairing event from the peer. */
  onEvent: (event: NostrEvent) => void;
  /** A validated `signet-child:` URI from the peer. */
  onOffer: (uri: string) => void;
  onState: (state: ChildPairLinkState, reason?: string) => void;
}

/** The phone that is not the lower session waits this long for the other's dial before dialling itself (as the Handshake does). */
const LATE_DIAL_MS = 3000;

export class ChildPairLink {
  private carrier?: HandshakeNearby;
  private native?: NearbyNative | null;
  private state: ChildPairLinkState | undefined;
  private closed = false;
  private askToEnable = false;
  private stopLifecycle?: () => void;
  private lateDial?: ReturnType<typeof setTimeout>;
  /** Shared across carriers, so returning to the foreground does not refill the allowance. */
  private readonly budget = { events: 0 };
  /** Bumped per carrier so a stale `open()` result is ignored. */
  private generation = 0;

  constructor(private opts: ChildPairLinkOptions) {}

  get linked(): boolean { return !this.closed && !!this.carrier?.reaches(this.opts.peerSession); }

  private set(state: ChildPairLinkState, reason?: string) {
    if (this.closed && state !== 'closed') return;
    if (this.state === state && reason === undefined) return;
    this.state = state;
    this.opts.onState(state, reason);
  }

  async open(askToEnable: boolean): Promise<void> {
    if (this.closed) return;
    this.askToEnable = askToEnable;
    this.native = this.opts.native ?? nativeNearby();
    if (!this.native) { this.set('unavailable', 'unsupported'); return; }
    // The native lifecycle is authoritative: the always-on bunker keeps the WebView looking visible.
    void this.native.lifecycle?.(s => {
      if (this.closed) return;
      if (s === 'background') { this.stopCarrier(); this.set('closed', 'background'); }
      else if (!this.carrier) void this.start();
    }).then(stop => { if (this.closed) stop?.(); else this.stopLifecycle = stop; }).catch(() => {});
    await this.start();
  }

  private async start(): Promise<void> {
    const native = this.native;
    if (this.closed || !native) return;
    const generation = ++this.generation;
    this.set('starting');
    const carrier = this.carrier = new HandshakeNearby(native, {
      profile: 'child-pair',
      session: this.opts.session,
      budget: this.budget,
      onEvent: async event => { this.opts.onEvent(event); return 'stored'; },
      onOffer: uri => this.opts.onOffer(uri),
      onChange: () => this.changed(carrier),
    });
    const peer = this.opts.peerSession;
    // Accept only the tapped session, from the first frame.
    carrier.expect(peer);
    const availability = await carrier.open(this.askToEnable);
    if (this.closed || generation !== this.generation || this.carrier !== carrier) return;
    if (availability !== 'ready') { this.stopCarrier(); this.set('unavailable', availability); return; }
    this.set('connecting');
    // The lower session dials at once; the other waits for that link and dials if it never comes.
    if (sessionDialler(this.opts.session.publicKey, peer)) carrier.connect({ session: peer });
    else this.lateDial = setTimeout(() => { if (!this.closed && this.carrier === carrier && !carrier.reaches(peer)) carrier.connect({ session: peer }); }, LATE_DIAL_MS);
    this.changed(carrier);
  }

  private changed(carrier: HandshakeNearby) {
    if (this.closed || this.carrier !== carrier) return;
    if (carrier.reaches(this.opts.peerSession)) this.set('linked');
    else if (this.state === 'linked') this.set('closed', 'link-lost');
    else if (carrier.dialsExhausted) this.set('closed', 'unreachable');
  }

  private stopCarrier() {
    if (this.lateDial) { clearTimeout(this.lateDial); this.lateDial = undefined; }
    this.generation++;
    const carrier = this.carrier;
    this.carrier = undefined;
    void carrier?.close();
  }

  /** True once the peer ACKs: received and passed validation. */
  sendOffer(uri: string): Promise<boolean> {
    return this.carrier && !this.closed ? this.carrier.sendOffer(this.opts.peerSession, uri) : Promise.resolve(false);
  }
  sendEvent(event: NostrEvent): Promise<boolean> {
    return this.carrier && !this.closed ? this.carrier.deliverSession(this.opts.peerSession, event) : Promise.resolve(false);
  }

  close(): void {
    if (this.closed) return;
    this.stopCarrier();
    this.closed = true;
    this.stopLifecycle?.();
    this.stopLifecycle = undefined;
    this.opts.onState('closed');
  }
}
