import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { nip44 } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';

// Bluetooth is an untrusted carrier, like a relay. This module authenticates
// the LINK with the two handshake session keys (handshake-reveal.ts). The
// connector dialled the session its camera read and sends its own session key
// in HELLO; the advertiser sends only a nonce, so its key is never broadcast
// over the air. The link key is the ECDH of the two, which needs a session
// secret and the other's key: a stranger who saw only the advertised token
// (a hash) cannot compute it, and a phone that read its peer's screen refuses
// any other session, so even someone holding photographs of both screens
// cannot join. Everything a link carries is verified by the receiver exactly
// as a relay event would be.

const TEXT = new TextEncoder();
/** What a link carries. Each profile has its own domain-separation labels and
 * its own event validator, so a pairing screen and a handshake screen never
 * share an advert, never authenticate each other and never accept each
 * other's frames. */
export type NearbyProfile = 'handshake' | 'child-pair';
const TOKEN_TAGS: Record<NearbyProfile, Uint8Array> = {
  'handshake': TEXT.encode('signet:handshake:nearby:token:v1'),
  'child-pair': TEXT.encode('signet:child-pair:nearby:token:v1'),
};
const KEY_TAGS: Record<NearbyProfile, Uint8Array> = {
  'handshake': TEXT.encode('signet:handshake:nearby:link:v1'),
  'child-pair': TEXT.encode('signet:child-pair:nearby:link:v1'),
};
const AUTH_TAG = TEXT.encode('auth');
/** child-pair only: every frame after AUTH is sealed (ChaCha20-Poly1305) under
 * a per-direction key from the link key, so a relaying middle that forwarded
 * HELLO and AUTH can neither read, alter, inject, replay nor reorder anything. */
const FRAME_AAD_TAG = TEXT.encode('signet:child-pair:nearby:frame:v1');
const FRAME_KEY_INFO: Record<NearbyRole, Uint8Array> = {
  advertiser: TEXT.encode('signet:child-pair:nearby:frame:v1:adv'),
  connector: TEXT.encode('signet:child-pair:nearby:frame:v1:conn'),
};
const SEAL_COUNTER_BYTES = 8, SEAL_TAG_BYTES = 16;
/** A sealed frame's bytes beyond its plaintext body. */
export const NEARBY_SEAL_OVERHEAD = SEAL_COUNTER_BYTES + SEAL_TAG_BYTES;
/** Sealed frames per direction per link. The native pipe carries at most 512
 * frames a link and a link at most 64 events, so a counter never comes close;
 * reaching this refuses to send and drops on receive, never wraps. */
export const NEARBY_MAX_SEALED_FRAMES = 1024;
const ACK_TAG = TEXT.encode('ack');
const HEX64 = /^[0-9a-f]{64}$/;
export type NearbyRole = 'advertiser' | 'connector';

export const NEARBY_TOKEN_BYTES = 8;
export const NEARBY_NONCE_BYTES = 16;
/** SDK wraps are capped at 32000 characters of content; the event JSON adds
 * well under 1 KiB. Native refuses longer frames before JS sees them. */
export const NEARBY_MAX_FRAME = 48 * 1024;
/** Before authentication only HELLO (17 bytes) and AUTH (33 bytes) exist. */
export const NEARBY_MAX_PREAUTH_FRAME = 64;
/** child-pair only: a pairing event's content, and the offer URI's bytes and prefix. */
export const CHILD_PAIR_MAX_CONTENT = 20000;
export const CHILD_PAIR_MAX_OFFER = 8192;
export const CHILD_PAIR_OFFER_PREFIX = 'signet-child:';
const CHILD_PAIR_KIND = 30078;

const HELLO = 1, AUTH = 2, EVENT = 3, ACK = 4, OFFER = 5;
const ADVERTISER_HELLO_SIZE = 1 + NEARBY_NONCE_BYTES, CONNECTOR_HELLO_SIZE = ADVERTISER_HELLO_SIZE + 32, AUTH_SIZE = 33, ACK_SIZE = 1 + 32 + 1 + 16;


const roleByte = (role: NearbyRole) => role === 'advertiser' ? 0x41 : 0x43;
const other = (role: NearbyRole): NearbyRole => role === 'advertiser' ? 'connector' : 'advertiser';

function tagged(tag: Uint8Array, bytes: Uint8Array): Uint8Array {
  const input = new Uint8Array(tag.length + bytes.length);
  try {
    input.set(tag); input.set(bytes, tag.length);
    return sha256(input);
  } finally { input.fill(0); }
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** What the phone advertises: a hash of its session public key, which is on
 * its screen, so it names no one and does not give the key itself away. */
export function nearbyToken(session: string, profile: NearbyProfile = 'handshake'): Uint8Array {
  if (!HEX64.test(session)) throw new Error('Invalid handshake session');
  return tagged(TOKEN_TAGS[profile], hexToBytes(session)).subarray(0, NEARBY_TOKEN_BYTES);
}
/** Link key: the ECDH of the two session keys, the same at both ends. */
export function nearbyLinkKey(ownSecret: Uint8Array, peerSession: string, profile: NearbyProfile = 'handshake'): Uint8Array {
  if (!HEX64.test(peerSession)) throw new Error('Invalid handshake session');
  const shared = nip44.v2.utils.getConversationKey(ownSecret, peerSession);
  try { return tagged(KEY_TAGS[profile], shared); } finally { shared.fill(0); }
}
/** A connector's HELLO carries its session key; an advertiser's does not. */
export function nearbyHello(nonce: Uint8Array, session?: string): Uint8Array {
  if (nonce.length !== NEARBY_NONCE_BYTES || (session !== undefined && !HEX64.test(session))) throw new Error('Invalid hello');
  return session === undefined ? concat(Uint8Array.of(HELLO), nonce) : concat(Uint8Array.of(HELLO), nonce, hexToBytes(session));
}
function authMac(key: Uint8Array, sender: NearbyRole, advertiserNonce: Uint8Array, connectorNonce: Uint8Array): Uint8Array {
  return hmac(sha256, key, concat(AUTH_TAG, Uint8Array.of(roleByte(sender)), advertiserNonce, connectorNonce));
}
function ackMac(key: Uint8Array, sender: NearbyRole, advertiserNonce: Uint8Array, connectorNonce: Uint8Array, id: Uint8Array, stored: boolean): Uint8Array {
  return hmac(sha256, key, concat(ACK_TAG, Uint8Array.of(roleByte(sender)), advertiserNonce, connectorNonce, id, Uint8Array.of(stored ? 1 : 0))).subarray(0, 16);
}

export function nearbyEventFrame(event: NostrEvent): Uint8Array | null {
  const body = TEXT.encode(JSON.stringify(event));
  return body.length + 1 > NEARBY_MAX_FRAME ? null : concat(Uint8Array.of(EVENT), body);
}
/** Shape only. The contact service verifies the signature, the mailbox tag
 * and everything inside before anything is stored. */
export function readNearbyEvent(frame: Uint8Array, profile: NearbyProfile = 'handshake'): NostrEvent | null {
  if (frame.length < 2 || frame.length > NEARBY_MAX_FRAME || frame[0] !== EVENT) return null;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(1))); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const e = value as Record<string, unknown>;
  if (typeof e.id !== 'string' || !HEX64.test(e.id) || typeof e.pubkey !== 'string' || !HEX64.test(e.pubkey)
    || typeof e.sig !== 'string' || !/^[0-9a-f]{128}$/.test(e.sig) || typeof e.content !== 'string'
    || !Number.isSafeInteger(e.created_at) || (e.created_at as number) < 0 || !Array.isArray(e.tags)) return null;
  const base = { id: e.id, pubkey: e.pubkey, sig: e.sig, content: e.content, created_at: e.created_at as number };
  const tags = e.tags as unknown[];
  const pair = (t: unknown, name: string): string | null =>
    Array.isArray(t) && t.length === 2 && t[0] === name && typeof t[1] === 'string' && HEX64.test(t[1]) ? t[1] : null;
  if (profile === 'child-pair') {
    // A pairing request or reply: kind 30078, exactly one d and one p tag.
    if (e.kind !== CHILD_PAIR_KIND || tags.length !== 2 || e.content.length > CHILD_PAIR_MAX_CONTENT) return null;
    const d = pair(tags[0], 'd') ?? pair(tags[1], 'd'), p = pair(tags[0], 'p') ?? pair(tags[1], 'p');
    if (d === null || p === null) return null;
    return { ...base, kind: CHILD_PAIR_KIND, tags: pair(tags[0], 'd') !== null ? [['d', d], ['p', p]] : [['p', p], ['d', d]] };
  }
  if (e.kind !== 1059 || tags.length !== 1) return null;
  const p = pair(tags[0], 'p');
  return p === null ? null : { ...base, kind: 1059, tags: [['p', p]] };
}

/** child-pair only: the guardian's `signet-child:` URI as UTF-8, or null when
 * it is not one or is too long. */
export function nearbyOfferFrame(uri: string): Uint8Array | null {
  if (typeof uri !== 'string' || !uri.startsWith(CHILD_PAIR_OFFER_PREFIX)) return null;
  const body = TEXT.encode(uri);
  return body.length > CHILD_PAIR_MAX_OFFER ? null : concat(Uint8Array.of(OFFER), body);
}
export function readNearbyOffer(frame: Uint8Array): string | null {
  if (frame.length < 2 || frame.length > 1 + CHILD_PAIR_MAX_OFFER || frame[0] !== OFFER) return null;
  let uri: string;
  try { uri = new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(1)); } catch { return null; }
  return uri.startsWith(CHILD_PAIR_OFFER_PREFIX) ? uri : null;
}
/** What an ACK names for a frame that has no event id: the SHA-256 of the frame. */
export function nearbyOfferId(frame: Uint8Array): string { return bytesToHex(sha256(frame)); }

export type NearbyStep =
  | { kind: 'send'; frame: Uint8Array }
  | { kind: 'trusted' }
  | { kind: 'event'; event: NostrEvent }
  | { kind: 'offer'; uri: string; id: string }
  | { kind: 'ack'; id: string; stored: boolean }
  | { kind: 'drop' };

function sealNonce(counter: Uint8Array): Uint8Array { return concat(new Uint8Array(4), counter); }
function sealAad(type: number, counter: Uint8Array): Uint8Array { return concat(FRAME_AAD_TAG, Uint8Array.of(type), counter); }
function counterBytes(n: number): Uint8Array {
  const out = new Uint8Array(SEAL_COUNTER_BYTES);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
  return out;
}

/**
 * One link's state. Frames before authentication have fixed sizes and are
 * compared, never parsed. The first frame each way is HELLO (a nonce and the
 * sender's session key), the second AUTH; anything else, a session other than
 * the one expected, or a MAC that fails, drops the link. After both AUTHs only
 * EVENT and authenticated ACK frames are accepted (and OFFER under child-pair).
 *
 * Under 'child-pair' every frame after AUTH is sealed:
 * `type || counter (8 bytes BE) || ChaCha20-Poly1305(body)`, with the key for
 * the sender's direction (HKDF-SHA256 of the link key, salt = the two HELLO
 * nonces), nonce = 4 zero bytes || counter, AAD = tag || type || counter. Each
 * direction counts from 0 and the receiver takes exactly the next counter, so
 * a forged, altered, replayed, reordered or reflected frame drops the link.
 * The 'handshake' profile's frames are unchanged: its wraps are sealed end to end.
 */
export class NearbyLink {
  private ownNonce: Uint8Array;
  private peerNonce?: Uint8Array;
  private key?: Uint8Array;
  private sendKey?: Uint8Array;
  private recvKey?: Uint8Array;
  private sendCounter = 0;
  private recvCounter = 0;
  private expected?: string;
  private state: 'hello' | 'auth' | 'trusted' | 'dropped' = 'hello';
  /** The peer's session key: the one a connector dialled, or the one in a
   * connector's HELLO. */
  peerSession?: string;
  constructor(readonly role: NearbyRole, nonce: Uint8Array, private session: { secret: Uint8Array; publicKey: string }, expected?: string, readonly profile: NearbyProfile = 'handshake') {
    if (nonce.length !== NEARBY_NONCE_BYTES) throw new Error('Invalid nonce');
    if (role === 'connector' && (expected === undefined || !HEX64.test(expected))) throw new Error('A connector dials a known session');
    this.ownNonce = Uint8Array.from(nonce);
    this.expected = expected;
  }
  get trusted() { return this.state === 'trusted'; }
  get dropped() { return this.state === 'dropped'; }
  /** True when frames after AUTH are sealed (the child-pair profile). */
  get seals() { return this.profile === 'child-pair'; }
  /** The first frame this side sends, at once. */
  hello(): Uint8Array { return nearbyHello(this.ownNonce, this.role === 'connector' ? this.session.publicKey : undefined); }
  /** The session this phone read from its peer's screen: no other may join.
   * True when the link may continue. */
  expect(peerSession: string): boolean {
    this.expected = peerSession;
    if (this.peerSession !== undefined && this.peerSession !== peerSession) { this.drop(); return false; }
    return this.state !== 'dropped';
  }
  private nonces(): [Uint8Array, Uint8Array] {
    return this.role === 'advertiser' ? [this.ownNonce, this.peerNonce!] : [this.peerNonce!, this.ownNonce];
  }
  private authFrame(): NearbyStep {
    const [a, c] = this.nonces();
    return { kind: 'send', frame: concat(Uint8Array.of(AUTH), authMac(this.key!, this.role, a, c)) };
  }
  private wipe() {
    this.key?.fill(0); this.sendKey?.fill(0); this.recvKey?.fill(0);
    this.key = this.sendKey = this.recvKey = undefined;
  }
  private drop(): NearbyStep[] { this.state = 'dropped'; this.wipe(); return [{ kind: 'drop' }]; }
  /** child-pair: the two per-direction frame keys, once AUTH has passed. */
  private deriveFrameKeys() {
    const [a, c] = this.nonces();
    const salt = concat(a, c);
    this.sendKey = hkdf(sha256, this.key!, salt, FRAME_KEY_INFO[this.role], 32);
    this.recvKey = hkdf(sha256, this.key!, salt, FRAME_KEY_INFO[other(this.role)], 32);
    salt.fill(0);
  }
  /** Ready to put on the wire: a plaintext frame (type byte + body) as-is
   * under 'handshake', sealed under 'child-pair'. Null when the link is not
   * trusted, the sealed frame would not fit or the counter is spent. Call it
   * only immediately before sending: under child-pair it takes a counter. */
  wire(frame: Uint8Array): Uint8Array | null {
    if (this.state !== 'trusted' || frame.length < 1) return null;
    if (!this.seals) return frame;
    const type = frame[0];
    if ((type !== EVENT && type !== OFFER && type !== ACK) || !this.sendKey) return null;
    if (frame.length + NEARBY_SEAL_OVERHEAD > NEARBY_MAX_FRAME || this.sendCounter >= NEARBY_MAX_SEALED_FRAMES) return null;
    const counter = counterBytes(this.sendCounter);
    const sealed = chacha20poly1305(this.sendKey, sealNonce(counter), sealAad(type, counter)).encrypt(frame.subarray(1));
    this.sendCounter++;
    return concat(Uint8Array.of(type), counter, sealed);
  }
  /** child-pair: the plaintext frame inside a sealed one, or null (drop). */
  private open(frame: Uint8Array): Uint8Array | null {
    if (!this.recvKey || frame.length < 1 + NEARBY_SEAL_OVERHEAD || frame.length > NEARBY_MAX_FRAME) return null;
    const type = frame[0];
    if (type !== EVENT && type !== OFFER && type !== ACK) return null;
    if (this.recvCounter >= NEARBY_MAX_SEALED_FRAMES) return null;
    const counter = frame.subarray(1, 1 + SEAL_COUNTER_BYTES);
    if (!equal(counter, counterBytes(this.recvCounter))) return null;
    let body: Uint8Array;
    try { body = chacha20poly1305(this.recvKey, sealNonce(counter), sealAad(type, counter)).decrypt(frame.subarray(1 + SEAL_COUNTER_BYTES)); }
    catch { return null; }
    this.recvCounter++;
    return concat(Uint8Array.of(type), body);
  }
  receive(frame: Uint8Array): NearbyStep[] {
    if (this.state === 'dropped') return [];
    if (this.state === 'hello') {
      // The advertiser hears the connector's session; the connector already has the advertiser's.
      const size = this.role === 'advertiser' ? CONNECTOR_HELLO_SIZE : ADVERTISER_HELLO_SIZE;
      if (frame.length !== size || frame[0] !== HELLO) return this.drop();
      this.peerNonce = frame.slice(1, 1 + NEARBY_NONCE_BYTES);
      const peer = this.role === 'advertiser' ? bytesToHex(frame.subarray(1 + NEARBY_NONCE_BYTES)) : this.expected!;
      if (equal(this.peerNonce, this.ownNonce) || peer === this.session.publicKey
        || (this.expected !== undefined && peer !== this.expected)) return this.drop();
      this.peerSession = peer;
      try { this.key = nearbyLinkKey(this.session.secret, peer, this.profile); } catch { return this.drop(); }
      this.state = 'auth';
      return [this.authFrame()];
    }
    if (this.state === 'auth') {
      if (!this.key || frame.length !== AUTH_SIZE || frame[0] !== AUTH) return this.drop();
      const [a, c] = this.nonces();
      if (!equal(frame.subarray(1), authMac(this.key, other(this.role), a, c))) return this.drop();
      if (this.seals) this.deriveFrameKeys();
      this.state = 'trusted';
      return [{ kind: 'trusted' }];
    }
    if (this.seals) {
      const plain = this.open(frame);
      if (!plain) return this.drop();
      frame = plain;
    }
    if (frame[0] === EVENT) {
      const event = readNearbyEvent(frame, this.profile);
      return event ? [{ kind: 'event', event }] : this.drop();
    }
    if (frame[0] === OFFER && this.profile === 'child-pair') {
      const uri = readNearbyOffer(frame);
      return uri ? [{ kind: 'offer', uri, id: nearbyOfferId(frame) }] : this.drop();
    }
    if (frame[0] === ACK && frame.length === ACK_SIZE) {
      const id = frame.subarray(1, 33), stored = frame[33];
      const [a, c] = this.nonces();
      if ((stored !== 0 && stored !== 1) || !equal(frame.subarray(34), ackMac(this.key!, other(this.role), a, c, id, stored === 1))) return this.drop();
      return [{ kind: 'ack', id: bytesToHex(id), stored: stored === 1 }];
    }
    return this.drop();
  }
  /** The receipt for `eventId`, ready for the wire (sealed under child-pair). */
  ack(eventId: string, stored: boolean): Uint8Array {
    if (this.state !== 'trusted' || !HEX64.test(eventId)) throw new Error('Link is not ready');
    const id = hexToBytes(eventId);
    const [a, c] = this.nonces();
    const frame = concat(Uint8Array.of(ACK), id, Uint8Array.of(stored ? 1 : 0), ackMac(this.key!, this.role, a, c, id, stored));
    const out = this.wire(frame);
    if (!out) throw new Error('Link is not ready');
    return out;
  }
  close() { this.state = 'dropped'; this.wipe(); }
}
