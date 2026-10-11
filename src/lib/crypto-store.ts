/**
 * Encrypt/decrypt secrets for IndexedDB storage using a user passphrase.
 * Uses PBKDF2 (600,000 iterations, SHA-256) to derive an AES-256-GCM key.
 * Iteration count follows OWASP 2023 recommendation for PBKDF2-SHA-256.
 * Last reviewed: 2026-03-16.
 *
 * Wire format: base64(salt[16] || iv[12] || ciphertext)
 */

import { deriveAesKey, aesEncrypt, aesDecrypt, SALT_LENGTH, IV_LENGTH } from './aes-crypto';

/**
 * Keys derived for reading stored rows, kept until the app locks.
 *
 * Every read used to re-run the full PBKDF2 derivation, and background pollers
 * read the same rows every few seconds, so the phone spent most of its idle
 * CPU there. A row's salt never changes, so its key is derived once per unlock.
 * Only for the 256-bit random unlock key: a passphrase shorter than
 * MIN_REMEMBERED_PASSPHRASE (a PIN) is never remembered. The keys are
 * non-extractable CryptoKeys, and the unlock key that yields them is already
 * held while unlocked, so remembering them exposes nothing new. Switched on
 * for one unlock key by rememberDerivedKeysFor() at unlock, and off again by
 * forgetDerivedKeys() on lock, so a read still running at lock cannot refill it.
 */
const remembered = new Map<string, Promise<CryptoKey>>();
const REMEMBER_MAX = 512;
const MIN_REMEMBERED_PASSPHRASE = 32;
let rememberedFor: string | undefined;
/** At unlock: remember the keys derived from this unlock key until lock. */
export function rememberDerivedKeysFor(unlockKey: string): void {
  if (unlockKey.length < MIN_REMEMBERED_PASSPHRASE || rememberedFor === unlockKey) return;
  remembered.clear();
  spares = [];
  rememberedFor = unlockKey;
}
function rememberedKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  // Only the unlock key switched on at unlock; anything else (or after lock) derives afresh.
  if (rememberedFor === undefined || passphrase !== rememberedFor) return deriveAesKey(passphrase, salt);
  const id = saltKey(salt);
  const hit = remembered.get(id);
  if (hit) { remembered.delete(id); remembered.set(id, hit); return hit; }
  const key = deriveAesKey(passphrase, salt);
  remembered.set(id, key);
  key.catch(() => { if (remembered.get(id) === key) remembered.delete(id); });
  while (remembered.size > REMEMBER_MAX) remembered.delete(remembered.keys().next().value!);
  return key;
}
/** On lock: forget every remembered key, and which unlock key they came from. */
export function forgetDerivedKeys(): void {
  remembered.clear();
  spares = [];
  rememberedFor = undefined;
}

/**
 * Keys for fresh salts, derived ahead of the write that will use them.
 *
 * A vault row rewritten while unlocked paid a full PBKDF2 derivation inside
 * every write, about a quarter of a second on a phone, and an in-person
 * handshake writes a dozen times while both people wait. The format is
 * unchanged: each write still takes a fresh random salt, used once, and the
 * key PBKDF2 derives from it. Only the derivation runs earlier, in the
 * background. Same gate and lifetime as the remembered keys: only for the
 * unlock key switched on at unlock, emptied on lock or a new unlock key, and a
 * derivation that finishes after that lands nowhere.
 */
interface SpareKey { passphrase: string; salt: Uint8Array; key: Promise<CryptoKey> }
const SPARE_KEYS = 4;
let spares: SpareKey[] = [];
function spareKey(passphrase: string): SpareKey {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const key = deriveAesKey(passphrase, salt);
  key.catch(() => {});
  return { passphrase, salt, key };
}
function refillSpareKeys(passphrase: string): void {
  while (rememberedFor === passphrase && spares.length < SPARE_KEYS) spares.push(spareKey(passphrase));
}
/** A fresh salt and its key for one write under the remembered unlock key;
 * undefined for any other passphrase. The key is also remembered for its salt. */
async function takeSpareKey(passphrase: string): Promise<{ salt: Uint8Array; key: CryptoKey } | undefined> {
  if (rememberedFor === undefined || passphrase !== rememberedFor) return undefined;
  // Taken once: a salt is never handed to a second write.
  const taken = spares.shift();
  const spare = taken && taken.passphrase === passphrase ? taken : spareKey(passphrase);
  refillSpareKeys(passphrase);
  let key: CryptoKey;
  try { key = await spare.key; } catch { return undefined; }
  if (rememberedFor === passphrase) {
    remembered.set(saltKey(spare.salt), spare.key);
    while (remembered.size > REMEMBER_MAX) remembered.delete(remembered.keys().next().value!);
  }
  return { salt: spare.salt, key };
}

/** Whether `encryptSecretAhead` would use a key derived ahead for this passphrase. */
export function encryptsAhead(passphrase: string): boolean {
  return rememberedFor !== undefined && passphrase === rememberedFor;
}

/**
 * `encryptSecret` for rows written repeatedly while unlocked (the private
 * vault states): the same wire format and a fresh salt per call, its key
 * derived ahead of time (see SpareKey). The key is also remembered for its
 * salt, so reading the row back derives nothing. Any passphrase other than the
 * remembered unlock key takes the plain `encryptSecret` path.
 */
export async function encryptSecretAhead(plaintext: string, passphrase: string): Promise<string> {
  const spare = await takeSpareKey(passphrase);
  if (!spare) return encryptSecret(plaintext, passphrase);
  const { iv, ciphertext } = await aesEncrypt(plaintext, spare.key);
  const combined = new Uint8Array(SALT_LENGTH + IV_LENGTH + ciphertext.length);
  combined.set(spare.salt);
  combined.set(iv, SALT_LENGTH);
  combined.set(ciphertext, SALT_LENGTH + IV_LENGTH);
  return bytesToBase64(combined);
}

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

  const key = await rememberedKey(passphrase, salt);
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
  return encryptBatchUnder(plaintexts, await freshSaltKey(passphrase));
}

/** `encryptSecretsBatch` with its salt's key derived ahead (see SpareKey). */
export async function encryptSecretsBatchAhead(plaintexts: string[], passphrase: string): Promise<string[]> {
  if (plaintexts.length === 0) return [];
  return encryptBatchUnder(plaintexts, await takeSpareKey(passphrase) ?? await freshSaltKey(passphrase));
}
async function freshSaltKey(passphrase: string): Promise<{ salt: Uint8Array; key: CryptoKey }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  return { salt, key: await deriveAesKey(passphrase, salt) };
}
async function encryptBatchUnder(plaintexts: string[], { salt, key }: { salt: Uint8Array; key: CryptoKey }): Promise<string[]> {
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
        keyPromise = rememberedKey(passphrase, salt);
        keyCache.set(cacheKey, keyPromise);
      }
      results[i] = await aesDecrypt(iv, ciphertext, await keyPromise);
    } catch {
      results[i] = null;
    }
  }
  return results;
}
