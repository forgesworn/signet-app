/**
 * One-off signing keys for Blossom uploads.
 *
 * A Blossom server sees the pubkey that signs every upload's kind-24242 auth.
 * Signing with an identity, persona, Professional or dependant key would hand
 * the operator a link between that key and the file, so no upload is signed by
 * one. Two kinds of uploader instead:
 *
 * - a per-blob key from an HMAC over this install's private uploader secret
 *   (`hmacUploaderBackend`), for the public picture/banner, the private
 *   avatar, the #242 contact-share avatar and the venue photo. Their content
 *   keys are handed to other people (contact QRs, Kinterest, the venue QR), so
 *   an uploader key derived from one would let any holder sign a DELETE. The
 *   secret never leaves this device, so only this install can rebuild the key
 *   (and so delete), and no two blobs share an uploader;
 * - a key DERIVED from the content key (`derivedUploaderBackend`), for the
 *   contact-picture backup only: that content key never leaves the user's own
 *   encrypted operation log, and deriving from it lets any of the user's
 *   devices sign a delete.
 *
 * Every backend `uploadToBlossom` / `deleteFromBlossom` accepts is minted here:
 * `UploaderBackend` is a branded type, so the compiler refuses a real key.
 *
 * Kept out of `blossom.ts` and `contact-picture-backup.ts` so `avatar.ts` and
 * the backup flow can both use it without importing each other.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { LocalSigningBackend } from './signing-backend';
import { getOrCreateUploaderSecret } from './db';

declare const uploaderBrand: unique symbol;
/**
 * A signer for a Blossom upload or delete. Only this module mints one, so a
 * real identity/persona/dependant backend cannot be passed to `uploadToBlossom`.
 */
export type UploaderBackend = LocalSigningBackend & { readonly [uploaderBrand]: true };

function mint(backend: LocalSigningBackend): UploaderBackend {
  return backend as UploaderBackend;
}

/** The private avatar's uploader (`uploadAvatar`). */
export const AVATAR_UPLOADER_DOMAIN = 'signet:avatar-uploader:v1';
/** The #242 contact-share avatar's uploader (stable per-slot `contactAvatarKey`). */
export const CONTACT_AVATAR_UPLOADER_DOMAIN = 'signet:contact-avatar-uploader:v1';
/** The contact-picture backup's uploader (derived from its content key). Unchanged: existing uploads may need a delete signed by it. */
export const CONTACT_PICTURE_UPLOADER_DOMAIN = 'signet:contact-picture-uploader:v1';
/** The venue-entry photo's uploader (`PhotoCapture`). */
export const VENUE_PHOTO_UPLOADER_DOMAIN = 'signet:venue-photo-uploader:v1';
/** The public picture/banner's uploader (`uploadPublicPicture`). */
export const PUBLIC_PICTURE_UPLOADER_DOMAIN = 'signet:public-picture-uploader:v1';

const HEX64 = /^[0-9a-f]{64}$/;

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
      if (secp256k1.utils.isValidSecretKey(sk)) return sk;
      sk.fill(0);
    }
    throw new Error('Could not derive an uploader key');
  } finally {
    keyBytes.fill(0);
  }
}

/** A signing backend over the key derived from the contact-picture content key. The caller `destroy()`s it. */
export function derivedUploaderBackend(contentKeyHex: string, domain: typeof CONTACT_PICTURE_UPLOADER_DOMAIN): UploaderBackend {
  const sk = deriveUploaderKey(contentKeyHex, domain);
  try {
    return mint(new LocalSigningBackend(bytesToHex(sk)));
  } finally {
    sk.fill(0);
  }
}

/**
 * sk = HMAC-SHA256(installUploaderSecret, utf8(domain) || sha256 of the blob's
 * exact bytes). In the (2^-128) case that is not a valid secp256k1 scalar the
 * message is retried with a counter byte appended. The caller zero-fills.
 */
export function deriveHmacUploaderKey(secret: Uint8Array, domain: string, blobSha256Hex: string): Uint8Array {
  if (!HEX64.test(blobSha256Hex)) throw new Error('Invalid blob hash');
  if (secret.length !== 32) throw new Error('Invalid uploader secret');
  const domainBytes = new TextEncoder().encode(domain);
  const hashBytes = hexToBytes(blobSha256Hex);
  try {
    for (let counter = 0; counter < 256; counter += 1) {
      const msg = new Uint8Array(domainBytes.length + hashBytes.length + (counter === 0 ? 0 : 1));
      msg.set(domainBytes, 0);
      msg.set(hashBytes, domainBytes.length);
      if (counter !== 0) msg[msg.length - 1] = counter;
      const sk = hmac(sha256, secret, msg);
      msg.fill(0);
      if (secp256k1.utils.isValidSecretKey(sk)) return sk;
      sk.fill(0);
    }
    throw new Error('Could not derive an uploader key');
  } finally {
    hashBytes.fill(0);
  }
}

/**
 * The uploader for the blob whose sha256 is `blobSha256Hex` under `domain`,
 * rebuilt from this install's secret. This is both the upload signer (via
 * `hmacUploaderBackendForBlob`) and the DELETE signer: given the `(domain,
 * hash)` of an earlier upload, it yields the same key, so this install can
 * delete what it uploaded and nobody else can. The caller `destroy()`s it.
 */
export async function hmacUploaderBackend(
  domain: string,
  blobSha256Hex: string,
  encryptionKey: string,
): Promise<UploaderBackend> {
  const secret = await getOrCreateUploaderSecret(encryptionKey);
  try {
    const sk = deriveHmacUploaderKey(secret, domain, blobSha256Hex);
    try {
      return mint(new LocalSigningBackend(bytesToHex(sk)));
    } finally {
      sk.fill(0);
    }
  } finally {
    secret.fill(0);
  }
}

/** `hmacUploaderBackend` for the exact bytes about to be uploaded. */
export async function hmacUploaderBackendForBlob(
  domain: string,
  blob: Blob,
  encryptionKey: string,
): Promise<UploaderBackend> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hash = bytesToHex(sha256(bytes));
  return hmacUploaderBackend(domain, hash, encryptionKey);
}
