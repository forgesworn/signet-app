import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';

// Bluetooth is an untrusted carrier, like a relay. This module authenticates
// the LINK (both ends know the secret in the QR the camera read) so a nearby
// stranger cannot push data at us or forge delivery receipts. Everything a
// link carries is an unchanged SDK v1 gift wrap that the contact service
// opens and verifies exactly as it does a relay event.

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
const HELLO_SIZE = 1 + NEARBY_NONCE_BYTES, AUTH_SIZE = 33, ACK_SIZE = 1 + 32 + 1 + 16;

export type NearbyRole = 'advertiser' | 'connector';
const roleByte = (role: NearbyRole) => role === 'advertiser' ? 0x41 : 0x43;
const other = (role: NearbyRole): NearbyRole => role === 'advertiser' ? 'connector' : 'advertiser';

function secretBytes(secret: string): Uint8Array {
  if (!HEX64.test(secret)) throw new Error('Invalid handshake secret');
  return hexToBytes(secret);
}
function tagged(tag: Uint8Array, secret: string): Uint8Array {
  const bytes = secretBytes(secret);
  const input = new Uint8Array(tag.length + bytes.length);
  try {
    input.set(tag); input.set(bytes, tag.length);
    return sha256(input);
  } finally { bytes.fill(0); input.fill(0); }
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

/** What the phone advertises: derived from its own QR secret, so it names no
 * one and only a reader of that QR can recognise it. */
export function nearbyToken(secret: string): Uint8Array {
  return tagged(TOKEN_TAG, secret).subarray(0, NEARBY_TOKEN_BYTES);
}
/** Link key: the ADVERTISER's QR secret. The advertiser owns it; the
 * connector read it with its camera. */
export function nearbyLinkKey(advertiserSecret: string): Uint8Array {
  return tagged(KEY_TAG, advertiserSecret);
}
export function nearbyHello(nonce: Uint8Array): Uint8Array {
  if (nonce.length !== NEARBY_NONCE_BYTES) throw new Error('Invalid nonce');
  return concat(Uint8Array.of(HELLO), nonce);
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
 * compared, never parsed. The first frame each way is HELLO, the second AUTH;
 * anything else, or a MAC that fails, drops the link. After both AUTHs only
 * EVENT and authenticated ACK frames are accepted.
 */
export class NearbyLink {
  private ownNonce: Uint8Array;
  private peerNonce?: Uint8Array;
  private key?: Uint8Array;
  private state: 'hello' | 'auth' | 'trusted' | 'dropped' = 'hello';
  constructor(readonly role: NearbyRole, nonce: Uint8Array) {
    if (nonce.length !== NEARBY_NONCE_BYTES) throw new Error('Invalid nonce');
    this.ownNonce = Uint8Array.from(nonce);
  }
  get trusted() { return this.state === 'trusted'; }
  get dropped() { return this.state === 'dropped'; }
  /** The first frame this side sends, at once. */
  hello(): Uint8Array { return nearbyHello(this.ownNonce); }
  /** The advertiser's QR secret: the advertiser's own, or the one the connector read. */
  setSecret(advertiserSecret: string): NearbyStep[] {
    if (this.key || this.state === 'dropped') return [];
    this.key = nearbyLinkKey(advertiserSecret);
    return this.peerNonce ? [this.authFrame()] : [];
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
      this.peerNonce = frame.slice(1);
      if (equal(this.peerNonce, this.ownNonce)) return this.drop();
      this.state = 'auth';
      return this.key ? [this.authFrame()] : [];
    }
    if (this.state === 'auth') {
      // A connector always knows the key; an advertiser always knows its own.
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
