/**
 * At-rest sealing for the `contactPictures` store (DB v27).
 *
 * Same guarantee as documents/credentials — the body (thumbnail bytes, source
 * URL, fetch time) is AES-256-GCM under a key derived from the unlock key, and
 * only `id` + `updatedAt` stay in clear. Different mechanism, borrowed from the
 * §11.1.10 sync decrypt cache: ONE PBKDF2 derivation per unlock with a fixed
 * salt, memoised, instead of one per row. The passphrase is the 256-bit random
 * unlock key, not a PIN, so a per-row salt buys nothing — and a per-row
 * 600k-iteration derivation would make showing a few hundred contact pictures
 * take minutes on a phone. The derived key is forgotten on lock and on purge.
 *
 * The row id is sealed inside the plaintext, so a row copied under another id
 * (another contact's picture) fails to open.
 */

import { deriveAesKey, aesEncrypt, aesDecrypt, SALT_LENGTH, IV_LENGTH } from './aes-crypto';
import { sniffImageFormat } from './image-header';

const PICTURE_SALT = new TextEncoder().encode('signet-contact-pictures-v1').slice(0, SALT_LENGTH);
const keyMemo = new Map<string, Promise<CryptoKey>>();

function keyFor(encryptionKey: string): Promise<CryptoKey> {
  let p = keyMemo.get(encryptionKey);
  if (!p) {
    p = deriveAesKey(encryptionKey, PICTURE_SALT);
    keyMemo.set(encryptionKey, p);
  }
  return p;
}

/** Drop the memoised key. Called on lock and by `purgeAllUserData`. */
export function forgetContactPictureKeys(): void {
  keyMemo.clear();
}

/** A stored thumbnail is a re-encoded JPEG, at most 256 px a side. */
export const CONTACT_PICTURE_MAX_STORED_BYTES = 512 * 1024;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const DIRECTORY_ID = /^(owner|bots|quarantine|dependant:[0-9a-f]{64})$/;

export function kind0PictureId(pubkey: string): string {
  return `kind0:${pubkey.toLowerCase()}`;
}

export function ownPictureId(directoryId: string, contactId: string): string {
  return `own:${directoryId}:${contactId}`;
}

/** True for the two id shapes this store holds. */
export function isContactPictureId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (id.startsWith('kind0:')) return HEX64.test(id.slice(6));
  if (id.startsWith('own:')) {
    const rest = id.slice(4);
    const cut = rest.lastIndexOf(':');
    return cut > 0 && DIRECTORY_ID.test(rest.slice(0, cut)) && HEX32.test(rest.slice(cut + 1));
  }
  return false;
}

export interface ContactPicture {
  /** `kind0:<pubkey>` (downloaded) or `own:<directoryId>:<contactId>` (the user's own). */
  id: string;
  /** Re-encoded JPEG thumbnail. Never the original bytes. */
  jpeg: Uint8Array;
  /** The kind-0 `picture` URL it was downloaded from (`kind0:` rows only). */
  sourceUrl?: string;
  /** Unix ms. */
  fetchedAt: number;
  /** Unix ms. */
  updatedAt: number;
}

export interface StoredContactPictureRow {
  id: string;
  updatedAt: number;
  encrypted: true;
  /** base64(iv[12] || ciphertext). */
  encryptedData: string;
}

const B64_CHUNK = 8192;
function toB64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += B64_CHUNK) s += String.fromCharCode(...u.subarray(i, i + B64_CHUNK));
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sealContactPicture(picture: ContactPicture, encryptionKey: string): Promise<StoredContactPictureRow> {
  if (!encryptionKey) throw new Error('Encryption key required to save a contact picture');
  if (!isContactPictureId(picture.id)) throw new Error('Invalid contact picture id');
  if (picture.jpeg.length === 0 || picture.jpeg.length > CONTACT_PICTURE_MAX_STORED_BYTES || sniffImageFormat(picture.jpeg) !== 'jpeg') {
    throw new Error('Invalid contact picture');
  }
  const body = JSON.stringify({
    id: picture.id,
    jpeg: toB64(picture.jpeg),
    ...(picture.sourceUrl ? { sourceUrl: picture.sourceUrl } : {}),
    fetchedAt: picture.fetchedAt,
  });
  const { iv, ciphertext } = await aesEncrypt(body, await keyFor(encryptionKey));
  const combined = new Uint8Array(IV_LENGTH + ciphertext.length);
  combined.set(iv);
  combined.set(ciphertext, IV_LENGTH);
  return { id: picture.id, updatedAt: picture.updatedAt, encrypted: true, encryptedData: toB64(combined) };
}

/** The picture, or null for a corrupt, foreign, relabelled or wrong-key row. Never throws. */
export async function openContactPicture(row: unknown, encryptionKey: string): Promise<ContactPicture | null> {
  try {
    const r = row as Partial<StoredContactPictureRow> | undefined;
    if (!r || r.encrypted !== true || typeof r.encryptedData !== 'string' || !isContactPictureId(r.id)) return null;
    const combined = fromB64(r.encryptedData);
    if (combined.length < IV_LENGTH + 16) return null;
    const plaintext = await aesDecrypt(combined.slice(0, IV_LENGTH), combined.slice(IV_LENGTH), await keyFor(encryptionKey));
    const body = JSON.parse(plaintext) as Record<string, unknown>;
    if (body.id !== r.id || typeof body.jpeg !== 'string') return null;
    const jpeg = fromB64(body.jpeg);
    if (jpeg.length === 0 || jpeg.length > CONTACT_PICTURE_MAX_STORED_BYTES || sniffImageFormat(jpeg) !== 'jpeg') return null;
    return {
      id: r.id,
      jpeg,
      ...(typeof body.sourceUrl === 'string' ? { sourceUrl: body.sourceUrl } : {}),
      fetchedAt: typeof body.fetchedAt === 'number' ? body.fetchedAt : 0,
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
    };
  } catch {
    return null;
  }
}
