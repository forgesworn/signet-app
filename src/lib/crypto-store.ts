/**
 * Encrypt/decrypt secrets for IndexedDB storage using a user passphrase.
 * Uses PBKDF2 (600,000 iterations, SHA-256) to derive an AES-256-GCM key.
 * Iteration count follows OWASP 2023 recommendation for PBKDF2-SHA-256.
 * Last reviewed: 2026-03-16.
 *
 * Wire format: base64(salt[16] || iv[12] || ciphertext)
 */

import { deriveAesKey, aesEncrypt, aesDecrypt, SALT_LENGTH, IV_LENGTH } from './aes-crypto';

export async function encryptSecret(plaintext: string, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const key = await deriveAesKey(passphrase, salt);
  const { iv, ciphertext } = await aesEncrypt(plaintext, key);

  // Format: base64(salt || iv || ciphertext)
  const combined = new Uint8Array(SALT_LENGTH + IV_LENGTH + ciphertext.length);
  combined.set(salt);
  combined.set(iv, SALT_LENGTH);
  combined.set(ciphertext, SALT_LENGTH + IV_LENGTH);

  let binary = '';
  combined.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

export async function decryptSecret(encrypted: string, passphrase: string): Promise<string> {
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  if (combined.length < SALT_LENGTH + IV_LENGTH + 16) {
    throw new Error('Encrypted payload too short');
  }

  const salt = combined.slice(0, SALT_LENGTH);
  const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertext = combined.slice(SALT_LENGTH + IV_LENGTH);

  const key = await deriveAesKey(passphrase, salt);
  return aesDecrypt(iv, ciphertext, key);
}

/**
 * Check if a string looks like an encrypted value produced by encryptSecret.
 * Must be valid base64 and decode to at least salt + iv + 16 bytes (minimum AES-GCM ciphertext).
 */
export function isEncrypted(value: string): boolean {
  try {
    const decoded = atob(value);
    return decoded.length >= SALT_LENGTH + IV_LENGTH + 16;
  } catch {
    return false;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

/** Hex key for a salt, used only as a `Map` lookup key within one batch call. */
function saltKey(salt: Uint8Array): string {
  return Array.from(salt).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Encrypt many secrets under ONE PBKDF2 derivation instead of N.
 *
 * Same wire format as `encryptSecret` (`base64(salt[16] || iv[12] || ciphertext)`)
 * and a fresh random IV per item, so every row this produces is individually
 * decryptable by plain `decryptSecret` — only the SALT is shared across the
 * batch, which is what lets `decryptSecretsBatch` (or any future reader)
 * derive once and reuse. A caller that writes rows one at a time via
 * `encryptSecret` keeps using a fresh salt per row, same as before; batching
 * is opt-in per call, not a change to the on-disk layout.
 */
export async function encryptSecretsBatch(plaintexts: string[], passphrase: string): Promise<string[]> {
  if (plaintexts.length === 0) return [];
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const key = await deriveAesKey(passphrase, salt);
  const out: string[] = [];
  for (const plaintext of plaintexts) {
    const { iv, ciphertext } = await aesEncrypt(plaintext, key);
    const combined = new Uint8Array(SALT_LENGTH + IV_LENGTH + ciphertext.length);
    combined.set(salt);
    combined.set(iv, SALT_LENGTH);
    combined.set(ciphertext, SALT_LENGTH + IV_LENGTH);
    out.push(bytesToBase64(combined));
  }
  return out;
}

/**
 * Decrypt many `encryptSecret`/`encryptSecretsBatch` payloads, deriving each
 * DISTINCT salt's key only once regardless of how many rows carry it — a
 * batch written by `encryptSecretsBatch` shares one salt, so reading it back
 * costs one derivation, not N; a mixed store (some rows from
 * `encryptSecret`, each with its own salt) still only pays once per
 * genuinely distinct salt.
 *
 * Per-item, never per-batch: a row that fails (too short, wrong key, bad
 * base64, tampered tag) yields `null` at its index rather than aborting or
 * throwing, matching the existing per-row `catch { return null }` behaviour
 * every caller already relies on.
 */
export async function decryptSecretsBatch(encrypted: string[], passphrase: string): Promise<(string | null)[]> {
  const keyCache = new Map<string, Promise<CryptoKey>>();
  const results: (string | null)[] = new Array(encrypted.length).fill(null);
  for (let i = 0; i < encrypted.length; i += 1) {
    try {
      const combined = Uint8Array.from(atob(encrypted[i]), (c) => c.charCodeAt(0));
      if (combined.length < SALT_LENGTH + IV_LENGTH + 16) continue;
      const salt = combined.slice(0, SALT_LENGTH);
      const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
      const ciphertext = combined.slice(SALT_LENGTH + IV_LENGTH);
      const cacheKey = saltKey(salt);
      let keyPromise = keyCache.get(cacheKey);
      if (!keyPromise) {
        keyPromise = deriveAesKey(passphrase, salt);
        keyCache.set(cacheKey, keyPromise);
      }
      results[i] = await aesDecrypt(iv, ciphertext, await keyPromise);
    } catch {
      results[i] = null;
    }
  }
  return results;
}
