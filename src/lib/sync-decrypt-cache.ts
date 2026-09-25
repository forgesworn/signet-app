/**
 * Encrypted per-rail decrypt cache for the cross-device sync rails (family-bunker
 * §11.1.10). Post-migration every `nip44_decrypt` is a NIP-46 round-trip
 * through the ESP32 (0.4–2 s, serialised) — five rails per unlock. Relay
 * sync events are replaceable and rarely change, so remember the plaintext
 * of the last event we decrypted, keyed by its event id: an unchanged
 * event costs zero device round-trips on the next unlock.
 *
 * At rest: AES-256-GCM under a key derived from the unlock key (PBKDF2 once
 * per unlock, memoised; forgotten on lock via `forgetSyncCacheKeys`). Rows
 * are per (dTag, author) — see `SyncCacheEntry` in `db.ts`.
 *
 * The cache is best-effort throughout: any failure (no IDB, wrong key,
 * tampered row) degrades to a miss, never to a thrown fetch.
 */

import { deriveAesKey, aesEncrypt, aesDecrypt, SALT_LENGTH } from './aes-crypto';
import { getSyncCacheEntry, putSyncCacheEntry } from './db';

export interface SyncDecryptCache {
  /** Plaintext for this relay event id, or null on miss / undecryptable. */
  get(eventId: string): Promise<string | null>;
  /** Remember `plaintext` as the decryption of `eventId`. Never throws. */
  put(eventId: string, createdAt: number, plaintext: string): Promise<void>;
}

// Fixed salt: the passphrase here is the 256-bit random unlock key, not a
// low-entropy PIN, so a per-row random salt would buy nothing — there is no
// dictionary to precompute against, and one constant salt lets the derived
// key be memoised once per unlock instead of once per row.
const SYNC_CACHE_SALT = new TextEncoder().encode('signet-sync-cache-v1').slice(0, SALT_LENGTH);

/** Derived-key memo, keyed by unlock key. Cleared on lock. */
const keyMemo = new Map<string, Promise<CryptoKey>>();

function aesKeyFor(encryptionKey: string): Promise<CryptoKey> {
  let p = keyMemo.get(encryptionKey);
  if (!p) {
    p = deriveAesKey(encryptionKey, SYNC_CACHE_SALT);
    keyMemo.set(encryptionKey, p);
  }
  return p;
}

/** Drop the memoised AES keys. Call when the app locks. */
export function forgetSyncCacheKeys(): void {
  keyMemo.clear();
}

// Chunked: `String.fromCharCode(...u)` on a whole payload would spread tens of
// thousands of arguments (a credentials rail carrying merkleLeaves is easily
// 100 kB) and blow the call-stack argument limit.
const B64_CHUNK = 8192;
const b64 = (u: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < u.length; i += B64_CHUNK) {
    s += String.fromCharCode(...u.subarray(i, i + B64_CHUNK));
  }
  return btoa(s);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * What actually goes inside the ciphertext. Binding the row id and the event
 * id to the plaintext means a row lifted verbatim into another rail's slot (or
 * relabelled with a different eventId) fails the check and reads as a miss —
 * the AES key is the same for every row under one unlock, so the ciphertext
 * alone is portable; the plaintext envelope is what pins it to its slot.
 *
 * Rows written before this envelope existed decode as a bare payload, fail the
 * parse, and simply miss — best-effort, so the first unlock after the upgrade
 * pays one device round-trip per rail and re-writes them in the new format.
 */
interface CacheEnvelope {
  id: string;
  eventId: string;
  payload: string;
}

function parseEnvelope(raw: string): CacheEnvelope | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return null;
    const e = v as Partial<CacheEnvelope>;
    if (typeof e.id !== 'string' || typeof e.eventId !== 'string' || typeof e.payload !== 'string') return null;
    return { id: e.id, eventId: e.eventId, payload: e.payload };
  } catch {
    return null;
  }
}

export function createSyncDecryptCache({ dTag, authorPubkey, encryptionKey }: {
  dTag: string;
  authorPubkey: string;
  encryptionKey: string;
}): SyncDecryptCache {
  const id = `${dTag}:${authorPubkey.toLowerCase()}`;
  return {
    async get(eventId) {
      try {
        const row = await getSyncCacheEntry(id);
        if (!row || row.eventId !== eventId) return null;
        const raw = await aesDecrypt(unb64(row.iv), unb64(row.ciphertext), await aesKeyFor(encryptionKey));
        const env = parseEnvelope(raw);
        // The cleartext row fields are only routing hints; the authority is
        // what the ciphertext itself says it belongs to.
        if (!env || env.id !== id || env.eventId !== eventId) return null;
        return env.payload;
      } catch {
        return null;
      }
    },
    async put(eventId, createdAt, plaintext) {
      try {
        const envelope: CacheEnvelope = { id, eventId, payload: plaintext };
        const { iv, ciphertext } = await aesEncrypt(JSON.stringify(envelope), await aesKeyFor(encryptionKey));
        await putSyncCacheEntry({
          id,
          eventId,
          createdAt,
          iv: b64(iv),
          ciphertext: b64(ciphertext),
          updatedAt: Date.now(),
        });
      } catch { /* cache is best-effort */ }
    },
  };
}

/**
 * Resolve the plaintext of a fetched sync event: cache hit, else `decrypt()`
 * (a device round-trip) and remember the result. Shared by all five rails so
 * the get → miss → decrypt → put sequence lives in exactly one place.
 *
 * With no cache supplied (locked, or a caller that opted out) this is just
 * `decrypt()`.
 */
export async function readSyncPlaintext(
  cache: SyncDecryptCache | undefined,
  event: { id: string; created_at: number },
  decrypt: () => Promise<string>,
): Promise<string> {
  const cached = cache ? await cache.get(event.id) : null;
  if (cached !== null) return cached;
  const plaintext = await decrypt();
  if (cache) await cache.put(event.id, event.created_at, plaintext);
  return plaintext;
}
