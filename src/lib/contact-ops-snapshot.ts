/**
 * A persisted memo of the contacts log's row decrypts, so the first read of
 * the log after an unlock costs one key derivation instead of one per row.
 *
 * Every contacts operation row carries its own PBKDF2 salt (one per saved
 * batch), and a phone runs Web Crypto's PBKDF2 one derivation at a time,
 * about a quarter of a second each, behind every other unlock-time read. A
 * log of a few dozen batches therefore kept the first handshake's block
 * check waiting 12–24 s after an unlock (the in-memory caches start empty).
 *
 * Content-addressed: each entry maps a digest of one stored row (every field
 * the decrypt takes from it, ciphertext included) to the plaintext
 * `decryptSecret` returned for that row. AES-GCM under the same key turns the
 * same ciphertext into the same plaintext, so a hit is exactly what a fresh
 * decrypt would return, and the caller runs the same parse and validation on
 * it. A rewritten row has a different digest and is decrypted afresh.
 *
 * At rest: one `syncCache` row per directory (`contact-ops:<directoryId>`),
 * sealed under the §11.1.10 unlock-derived key (`aesKeyFor`), like the rail
 * caches and `vault-key-cache.ts`; the row id and directory are bound inside
 * the ciphertext. No IDB version bump; cleared by `purgeAllUserData`.
 *
 * Best-effort throughout: any failure (no row, another key, tampered
 * ciphertext, a malformed body) is a miss, and a miss is the full decrypt.
 * Callers use it only while `live()` holds (unlocked with this key), so a read
 * or write still running at lock cannot re-derive the cache key.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { aesEncrypt, aesDecrypt } from './aes-crypto';
import { aesKeyFor } from './sync-decrypt-cache';
import type { SyncCacheEntry } from './db';

export const CONTACT_OPS_SNAPSHOT_PREFIX = 'contact-ops:';
const HEX_64 = /^[0-9a-f]{64}$/;

export interface ContactOpsSnapshotStore {
  get(id: string): Promise<SyncCacheEntry | undefined>;
  put(entry: SyncCacheEntry): Promise<void>;
}

/** The stored row fields, clear and encrypted, that a decrypt depends on. */
export interface ContactOpRowFields {
  operationId?: unknown; directoryId?: unknown; contactId?: unknown;
  logicalClock?: unknown; createdAt?: unknown; encryptedData?: unknown;
}

export function contactOpRowDigest(row: ContactOpRowFields): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(['signet:contact-ops-row:v1',
    row.operationId, row.directoryId, row.contactId, row.logicalClock, row.createdAt, row.encryptedData]))));
}

const B64_CHUNK = 8192;
const b64 = (u: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < u.length; i += B64_CHUNK) s += String.fromCharCode(...u.subarray(i, i + B64_CHUNK));
  return btoa(s);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rowId = (directoryId: string) => `${CONTACT_OPS_SNAPSHOT_PREFIX}${directoryId}`;
const setDigest = (entries: Map<string, string>) =>
  bytesToHex(sha256(new TextEncoder().encode([...entries.keys()].sort().join('\n'))));

/** The remembered plaintexts for one directory, by row digest; empty on any miss. */
export async function readContactOpsSnapshot(directoryId: string, encryptionKey: string,
  store: ContactOpsSnapshotStore, live: () => boolean): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    if (!live()) return out;
    const id = rowId(directoryId);
    const row = await store.get(id);
    if (!row || !live()) return out;
    const env = JSON.parse(await aesDecrypt(unb64(row.iv), unb64(row.ciphertext), await aesKeyFor(encryptionKey))) as unknown;
    // The ciphertext, not the cleartext row, says which directory it belongs to.
    const e = env as { id?: unknown; directoryId?: unknown; entries?: unknown } | null;
    if (!e || e.id !== id || e.directoryId !== directoryId || !e.entries || typeof e.entries !== 'object' || Array.isArray(e.entries)) return out;
    for (const [digest, plaintext] of Object.entries(e.entries as Record<string, unknown>)) {
      if (HEX_64.test(digest) && typeof plaintext === 'string') out.set(digest, plaintext);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Replace one directory's snapshot with `entries`. Never throws. */
export async function writeContactOpsSnapshot(directoryId: string, encryptionKey: string, entries: Map<string, string>,
  store: ContactOpsSnapshotStore, live: () => boolean): Promise<void> {
  try {
    if (!live() || entries.size === 0) return;
    const id = rowId(directoryId);
    const { iv, ciphertext } = await aesEncrypt(JSON.stringify({ id, directoryId, entries: Object.fromEntries(entries) }),
      await aesKeyFor(encryptionKey));
    if (!live()) return;
    const now = Date.now();
    await store.put({ id, eventId: setDigest(entries), createdAt: Math.floor(now / 1000),
      iv: b64(iv), ciphertext: b64(ciphertext), updatedAt: now });
  } catch { /* cache is best-effort */ }
}
