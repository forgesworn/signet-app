/**
 * One-off signing keys for Blossom uploads.
 *
 * A Blossom server sees the pubkey that signs every upload's kind-24242 auth.
 * Signing with an identity, persona, Professional or dependant key would hand
 * the operator a link between that key and the file, so no upload is signed by
 * one. Two kinds of uploader instead:
 *
 * - a FRESH random key per upload, for public pictures and banners (nothing
 *   needs to be recomputed later);
 * - a key DERIVED from the content key, for encrypted blobs: anyone holding
 *   the content key can re-sign a later delete, and nobody else can name the
 *   uploader. Each use has its own domain string so the same content key could
 *   never produce the same uploader in two contexts.
 *
 * Kept out of `blossom.ts` and `contact-picture-backup.ts` so `avatar.ts` and
 * the backup flow can both use it without importing each other.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { generateSecretKey } from 'nostr-tools/pure';
import { LocalSigningBackend } from './signing-backend';

/** The private avatar's uploader (`uploadAvatar`; content key minted per upload). */
export const AVATAR_UPLOADER_DOMAIN = 'signet:avatar-uploader:v1';
/** The #242 contact-share avatar's uploader (stable per-slot `contactAvatarKey`). */
export const CONTACT_AVATAR_UPLOADER_DOMAIN = 'signet:contact-avatar-uploader:v1';
/** The contact-picture backup's uploader. Unchanged: existing uploads may need a delete signed by it. */
export const CONTACT_PICTURE_UPLOADER_DOMAIN = 'signet:contact-picture-uploader:v1';
/** The venue-entry photo's uploader (`PhotoCapture`; content key minted per upload). */
export const VENUE_PHOTO_UPLOADER_DOMAIN = 'signet:venue-photo-uploader:v1';

const HEX64 = /^[0-9a-f]{64}$/;
/** secp256k1 group order. */
const CURVE_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

function isValidScalar(sk: Uint8Array): boolean {
  const n = BigInt('0x' + bytesToHex(sk));
  return n > 0n && n < CURVE_N;
}

/**
 * sk = sha256(utf8(domain) || keyBytes). In the (2^-128) case that is not a
 * valid secp256k1 scalar, the hash is retried with a counter byte (1, 2, ...)
 * appended to the input. The caller zero-fills.
 */
export function deriveUploaderKey(contentKeyHex: string, domain: string): Uint8Array {
  if (!HEX64.test(contentKeyHex)) throw new Error('Invalid picture key');
  const domainBytes = new TextEncoder().encode(domain);
  const keyBytes = hexToBytes(contentKeyHex);
  try {
    for (let counter = 0; counter < 256; counter += 1) {
      const input = new Uint8Array(domainBytes.length + keyBytes.length + (counter === 0 ? 0 : 1));
      input.set(domainBytes, 0);
      input.set(keyBytes, domainBytes.length);
      if (counter !== 0) input[input.length - 1] = counter;
      const sk = sha256(input);
      input.fill(0);
      if (isValidScalar(sk)) return sk;
      sk.fill(0);
    }
    throw new Error('Could not derive an uploader key');
  } finally {
    keyBytes.fill(0);
  }
}

/** A signing backend over the derived uploader key. The caller `destroy()`s it. */
export function derivedUploaderBackend(contentKeyHex: string, domain: string): LocalSigningBackend {
  const sk = deriveUploaderKey(contentKeyHex, domain);
  try {
    return new LocalSigningBackend(bytesToHex(sk));
  } finally {
    sk.fill(0);
  }
}

/** A signing backend over a fresh random key, used for one upload. The caller `destroy()`s it. */
export function randomUploaderBackend(): LocalSigningBackend {
  const sk = generateSecretKey();
  try {
    return new LocalSigningBackend(bytesToHex(sk));
  } finally {
    sk.fill(0);
  }
}
