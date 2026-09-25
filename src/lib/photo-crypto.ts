/**
 * Photo encryption for Blossom uploads.
 *
 * Encrypts JPEG photos with AES-256-GCM before uploading to Blossom.
 * The key is stored locally and included in venue entry events so
 * stewards can decrypt at scan time. Blossom never sees plaintext.
 *
 * Blob format: [IV: 12 bytes] [ciphertext: variable] [auth tag: 16 bytes]
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

const IV_BYTES = 12;
const KEY_BITS = 256;
const HEX64 = /^[0-9a-f]{64}$/i;

/** Generate a fresh 64-char hex AES-256 key; zeroizes the byte buffer. */
function randomAesKeyHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = bytesToHex(bytes);
  bytes.fill(0);
  return hex;
}

/** Stable contact-share key generator (alias of the internal AES-key gen). */
export function generateContactAvatarKey(): string {
  return randomAesKeyHex();
}

/**
 * Encrypt photo bytes with a CALLER-SUPPLIED AES-256-GCM key (64-char hex).
 * Same wire format as `encryptPhoto` (`iv || ciphertext || authTag`). Used by
 * the contact-share avatar path, which must reuse one stable key across uploads.
 */
export async function encryptPhotoWithKey(
  plaintext: Uint8Array,
  keyHex: string,
): Promise<Uint8Array> {
  if (!HEX64.test(keyHex)) throw new Error('Invalid photo key — must be 64-char hex');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const keyBytes = hexToBytes(keyHex);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'raw',
      keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer,
      { name: 'AES-GCM', length: KEY_BITS },
      false,
      ['encrypt'],
    );
  } finally {
    keyBytes.fill(0);
  }
  const data = plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength) as ArrayBuffer;
  const ciphertextWithTag = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const ctBytes = new Uint8Array(ciphertextWithTag as ArrayBuffer);
  const encrypted = new Uint8Array(IV_BYTES + ctBytes.byteLength);
  encrypted.set(iv, 0);
  encrypted.set(ctBytes, IV_BYTES);
  return encrypted;
}

/**
 * Encrypt a photo with AES-256-GCM.
 *
 * @param plaintext - Raw JPEG bytes
 * @returns encryptedBlob (iv || ciphertext || authTag) and keyHex (64-char hex)
 */
export async function encryptPhoto(
  plaintext: Uint8Array,
): Promise<{ encryptedBlob: Uint8Array; keyHex: string }> {
  const keyHex = randomAesKeyHex();
  const encryptedBlob = await encryptPhotoWithKey(plaintext, keyHex);
  return { encryptedBlob, keyHex };
}

/**
 * Decrypt an encrypted photo blob produced by `encryptPhoto`. Reverses the
 * `[IV: 12 bytes] [ciphertext + auth tag]` wire format. Throws on a wrong
 * key, tampered ciphertext, or malformed input — same failure mode as the
 * underlying SubtleCrypto.decrypt call.
 *
 * @param encryptedBlob - The (iv || ciphertext || authTag) layout.
 * @param keyHex        - 64-char hex AES-256 key (matches `encryptPhoto`).
 * @returns Plaintext bytes.
 */
export async function decryptPhoto(
  encryptedBlob: Uint8Array,
  keyHex: string,
): Promise<Uint8Array> {
  if (!HEX64.test(keyHex)) throw new Error('Invalid photo key — must be 64-char hex');
  if (encryptedBlob.byteLength < IV_BYTES + 16) {
    throw new Error('Encrypted blob too short — missing IV or auth tag');
  }
  const iv = encryptedBlob.slice(0, IV_BYTES);
  const ct = encryptedBlob.slice(IV_BYTES);

  const keyBytes = hexToBytes(keyHex);
  let key: CryptoKey;
  try {
    // Import as an extractable=false key so it can't be re-exported.
    key = await crypto.subtle.importKey(
      'raw',
      keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer,
      { name: 'AES-GCM', length: KEY_BITS },
      false,
      ['decrypt'],
    );
  } finally {
    keyBytes.fill(0);
  }

  // SubtleCrypto requires plain ArrayBuffer-backed views.
  const ivBuf = Uint8Array.from(iv);
  const ctBuf = Uint8Array.from(ct);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBuf },
    key,
    ctBuf,
  );
  return new Uint8Array(plaintext);
}
