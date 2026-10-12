import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { decodeBase45, encodeBase45 } from './handshake-optical';
import { CHILD_PAIR_NFC_PREFIX, nativeNfc, type HandshakeNfcHandle } from './handshake-nfc';

/**
 * The NFC tap on a child-pairing screen. The wire is the Handshake's (same AID,
 * same APDUs, same 250-byte cap); only the prefix differs, so a pairing phone
 * and a Handshake phone that touch can tell the other's code is not for them.
 * The code is a fresh session public key and an expiry (at most 120 s ahead),
 * laid out as the Handshake's session body with zero relays: pairing does not
 * use them. It names no one and carries no secret.
 */
const HEX64 = /^[0-9a-f]{64}$/;
const SESSION_SECONDS = 120;
const BODY_BYTES = 38; // version 2, 32-byte key, uint32 expiry, relay count (0)

/** The code this phone offers: `SCP1:` + Base45 body. Throws on a malformed key or a clock that cannot encode. */
export function writeChildPairCode(session: { publicKey: string }, nowS: number): string {
  if (!HEX64.test(session.publicKey)) throw new Error('Invalid pairing session');
  const expiresAt = Math.floor(nowS) + SESSION_SECONDS;
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0 || expiresAt > 0xffffffff) throw new Error('Invalid pairing clock');
  const bytes = new Uint8Array(BODY_BYTES);
  bytes[0] = 2; bytes.set(hexToBytes(session.publicKey), 1);
  new DataView(bytes.buffer).setUint32(33, expiresAt); // bytes[37] stays 0: no relays
  return CHILD_PAIR_NFC_PREFIX + encodeBase45(bytes);
}

export type TappedCode =
  | { kind: 'child-pair'; sessionPubkey: string; expiresAt: number }
  | { kind: 'handshake' }
  | { kind: 'invalid' };

/** What the other phone's tapped code is. An expired, over-long-lived or malformed pairing code is `invalid`. */
export function classifyTappedCode(raw: string, nowS: number): TappedCode {
  if (typeof raw !== 'string') return { kind: 'invalid' };
  if (raw.startsWith('SGH2:')) return { kind: 'handshake' };
  if (!raw.startsWith(CHILD_PAIR_NFC_PREFIX)) return { kind: 'invalid' };
  const bytes = decodeBase45(raw.slice(CHILD_PAIR_NFC_PREFIX.length));
  if (!bytes || bytes.length !== BODY_BYTES || bytes[0] !== 2 || bytes[37] !== 0) return { kind: 'invalid' };
  const expiresAt = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(33);
  if (expiresAt <= nowS || expiresAt > nowS + SESSION_SECONDS) return { kind: 'invalid' };
  return { kind: 'child-pair', sessionPubkey: bytesToHex(bytes.subarray(1, 33)), expiresAt };
}

/**
 * Offer `code` and read the other phone's over the shared NFC wire. `onPeer`
 * gets the raw peer code unchanged (classify it with `classifyTappedCode`).
 * Null when there is no native NFC (a browser).
 */
export async function startChildPairNfc(code: string, onPeer: (raw: string) => void): Promise<HandshakeNfcHandle | null> {
  const nfc = nativeNfc();
  return nfc ? nfc.start(code, onPeer) : null;
}
