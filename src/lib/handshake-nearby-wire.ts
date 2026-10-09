import { hmac } from '@noble/hashes/hmac.js';
import { nip44 } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';

// Bluetooth is an untrusted carrier, like a relay. This module authenticates
// the LINK with the two handshake session keys (handshake-reveal.ts): each end
// sends its session public key in HELLO, and the link key is their ECDH, which
// only the two session secret holders can compute. A phone that has read its
// peer's session from the screen refuses any other session, so even someone
// holding photographs of both screens cannot join. Everything a link carries
// is verified by the receiver exactly as a relay event would be.

const TEXT = new TextEncoder();
const TOKEN_TAG = TEXT.encode('signet:handshake:nearby:token:v1');
const KEY_TAG = TEXT.encode('signet:handshake:nearby:link:v1');
const AUTH_TAG = TEXT.encode('auth');
const ACK_TAG = TEXT.encode('ack');
const HEX64 = /^[0-9a-f]{64}$/;

export const NEARBY_TOKEN_BYTES = 8;
export const NEARBY_NONCE_BYTES = 16;
/** SDK wraps are capped at 32000 characters of content; the event JSON adds
 * well under 1 KiB. Native refuses longer frames before JS sees them. */
export const NEARBY_MAX_FRAME = 48 * 1024;
/** Before authentication only HELLO (17 bytes) and AUTH (33 bytes) exist. */
export const NEARBY_MAX_PREAUTH_FRAME = 64;

const HELLO = 1, AUTH = 2, EVENT = 3, ACK = 4;
const HELLO_SIZE = 1 + NEARBY_NONCE_BYTES + 32, AUTH_SIZE = 33, ACK_SIZE = 1 + 32 + 1 + 16;

export type NearbyRole = 'advertiser' | 'connector';
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

/** What the phone advertises: derived from its session public key, which is
 * on its screen, so it names no one and only a reader of that QR knows it. */
export function nearbyToken(session: string): Uint8Array {
  if (!HEX64.test(session)) throw new Error('Invalid handshake session');
  return tagged(TOKEN_TAG, hexToBytes(session)).subarray(0, NEARBY_TOKEN_BYTES);
}
/** Link key: the ECDH of the two session keys, the same at both ends. */
export function nearbyLinkKey(ownSecret: Uint8Array, peerSession: string): Uint8Array {
  if (!HEX64.test(peerSession)) throw new Error('Invalid handshake session');
  const shared = nip44.v2.utils.getConversationKey(ownSecret, peerSession);
  try { return tagged(KEY_TAG, shared); } finally { shared.fill(0); }
}
export function nearbyHello(nonce: Uint8Array, session: string): Uint8Array {
  if (nonce.length !== NEARBY_NONCE_BYTES || !HEX64.test(session)) throw new Error('Invalid hello');
  return concat(Uint8Array.of(HELLO), nonce, hexToBytes(session));
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
export function readNearbyEvent(frame: Uint8Array): NostrEvent | null {
  if (frame.length < 2 || frame.length > NEARBY_MAX_FRAME || frame[0] !== EVENT) return null;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(1))); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const e = value as Record<string, unknown>;
  if (e.kind !== 1059 || typeof e.id !== 'string' || !HEX64.test(e.id) || typeof e.pubkey !== 'string' || !HEX64.test(e.pubkey)
    || typeof e.sig !== 'string' || !/^[0-9a-f]{128}$/.test(e.sig) || typeof e.content !== 'string'
    || !Number.isSafeInteger(e.created_at) || (e.created_at as number) < 0 || !Array.isArray(e.tags) || e.tags.length !== 1
    || !Array.isArray(e.tags[0]) || e.tags[0].length !== 2 || e.tags[0][0] !== 'p' || typeof e.tags[0][1] !== 'string'
    || !HEX64.test(e.tags[0][1])) return null;
  return { id: e.id, pubkey: e.pubkey, sig: e.sig, kind: 1059, content: e.content, created_at: e.created_at as number,
    tags: [['p', e.tags[0][1]]] };
}

export type NearbyStep =
  | { kind: 'send'; frame: Uint8Array }
  | { kind: 'trusted' }
  | { kind: 'event'; event: NostrEvent }
  | { kind: 'ack'; id: string; stored: boolean }
  | { kind: 'drop' };

/**
 * One link's state. Frames before authentication have fixed sizes and are
 * compared, never parsed. The first frame each way is HELLO (a nonce and the
 * sender's session key), the second AUTH; anything else, a session other than
 * the one expected, or a MAC that fails, drops the link. After both AUTHs only
 * EVENT and authenticated ACK frames are accepted.
 */
export class NearbyLink {
  private ownNonce: Uint8Array;
  private peerNonce?: Uint8Array;
  private key?: Uint8Array;
  private expected?: string;
  private state: 'hello' | 'auth' | 'trusted' | 'dropped' = 'hello';
  /** The peer's session key, from its HELLO. */
  peerSession?: string;
  constructor(readonly role: NearbyRole, nonce: Uint8Array, private session: { secret: Uint8Array; publicKey: string }, expected?: string) {
    if (nonce.length !== NEARBY_NONCE_BYTES) throw new Error('Invalid nonce');
    this.ownNonce = Uint8Array.from(nonce);
    this.expected = expected;
  }
  get trusted() { return this.state === 'trusted'; }
  get dropped() { return this.state === 'dropped'; }
  /** The first frame this side sends, at once. */
  hello(): Uint8Array { return nearbyHello(this.ownNonce, this.session.publicKey); }
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
  private drop(): NearbyStep[] { this.state = 'dropped'; this.key?.fill(0); return [{ kind: 'drop' }]; }
  receive(frame: Uint8Array): NearbyStep[] {
    if (this.state === 'dropped') return [];
    if (this.state === 'hello') {
      if (frame.length !== HELLO_SIZE || frame[0] !== HELLO) return this.drop();
      this.peerNonce = frame.slice(1, 1 + NEARBY_NONCE_BYTES);
      const peer = bytesToHex(frame.subarray(1 + NEARBY_NONCE_BYTES));
      if (equal(this.peerNonce, this.ownNonce) || peer === this.session.publicKey
        || (this.expected !== undefined && peer !== this.expected)) return this.drop();
      this.peerSession = peer;
      try { this.key = nearbyLinkKey(this.session.secret, peer); } catch { return this.drop(); }
      this.state = 'auth';
      return [this.authFrame()];
    }
    if (this.state === 'auth') {
      if (!this.key || frame.length !== AUTH_SIZE || frame[0] !== AUTH) return this.drop();
      const [a, c] = this.nonces();
      if (!equal(frame.subarray(1), authMac(this.key, other(this.role), a, c))) return this.drop();
      this.state = 'trusted';
      return [{ kind: 'trusted' }];
    }
    if (frame[0] === EVENT) {
      const event = readNearbyEvent(frame);
      return event ? [{ kind: 'event', event }] : this.drop();
    }
    if (frame[0] === ACK && frame.length === ACK_SIZE) {
      const id = frame.subarray(1, 33), stored = frame[33];
      const [a, c] = this.nonces();
      if ((stored !== 0 && stored !== 1) || !equal(frame.subarray(34), ackMac(this.key!, other(this.role), a, c, id, stored === 1))) return this.drop();
      return [{ kind: 'ack', id: bytesToHex(id), stored: stored === 1 }];
    }
    return this.drop();
  }
  ack(eventId: string, stored: boolean): Uint8Array {
    if (this.state !== 'trusted' || !HEX64.test(eventId)) throw new Error('Link is not ready');
    const id = hexToBytes(eventId);
    const [a, c] = this.nonces();
    return concat(Uint8Array.of(ACK), id, Uint8Array.of(stored ? 1 : 0), ackMac(this.key!, this.role, a, c, id, stored));
  }
  close() { this.state = 'dropped'; this.key?.fill(0); }
}
