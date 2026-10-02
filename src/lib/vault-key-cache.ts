/**
 * Persisted cache for the vault envelope's key leg. `openVaultPayload` asks the
 * backend to `nip44Decrypt` each head's and chunk's 32-byte content key; on a
 * Heartwood every one of those is a device request (a card), and the private
 * vault cycle reads every head and chunk each time. Content-addressed on
 * (vault key, peer, ciphertext), so an unchanged head or chunk costs no device
 * request — within an unlock and across unlocks. Our own `nip44Encrypt` seeds
 * it, so a just-published envelope reads back without one either.
 *
 * Shares the §11.1.10 `syncCache` store and its unlock-derived AES key (no IDB
 * version bump; forgotten on lock, cleared by `purgeAllUserData`). Rows are
 * `vault-k:<digest>`, capped at `VAULT_KEY_CACHE_ROWS`, oldest write evicted.
 * Only short plaintexts are cached — a base64 content key, never a payload.
 *
 * Best-effort: a cache failure is a miss or a skipped write. The device's own
 * errors (refusals included) propagate untouched, and only successes are kept.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { aesEncrypt, aesDecrypt } from './aes-crypto';
import { aesKeyFor } from './sync-decrypt-cache';
import { getSyncCacheEntry, putSyncCacheEntry, pruneSyncCacheEntries } from './db';
import type { DecryptingSigningBackend } from './signing-backend';

export const VAULT_KEY_ROW_PREFIX = 'vault-k:';
export const VAULT_KEY_CACHE_ROWS = 256;
/** A base64 32-byte key is 44 chars; anything well over that is not a key leg. */
export const VAULT_KEY_MAX_PLAINTEXT = 128;
/** A hit older than this refreshes its row's write time, so live rows outlast eviction. */
const TOUCH_AFTER_MS = 60 * 60_000;
const HEX_64 = /^[0-9a-f]{64}$/;

export interface VaultKeyCache {
  /** Plaintext for this digest, or null on miss / undecryptable row. Never throws. */
  get(digest: string): Promise<string | null>;
  /** Remember `plaintext` under `digest`. Never throws. */
  put(digest: string, plaintext: string): Promise<void>;
}

/** The NIP-44 conversation is (own key, peer); both legs of a self-wrap key on (vault, vault, ct). */
export function vaultKeyDigest(ownPubkey: string, peerPubkey: string, ciphertext: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(
    ['signet:vault-k-cache:v1', ownPubkey.toLowerCase(), peerPubkey.toLowerCase(), ciphertext]))));
}

const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function createVaultKeyCache(encryptionKey: string): VaultKeyCache {
  return {
    async get(digest) {
      try {
        const id = `${VAULT_KEY_ROW_PREFIX}${digest}`;
        const row = await getSyncCacheEntry(id);
        if (!row || row.eventId !== digest) return null;
        const env = JSON.parse(await aesDecrypt(unb64(row.iv), unb64(row.ciphertext), await aesKeyFor(encryptionKey))) as unknown;
        // As in sync-decrypt-cache: the ciphertext, not the cleartext row, says which slot it belongs to.
        const e = env as { id?: unknown; eventId?: unknown; payload?: unknown } | null;
        if (!e || e.id !== id || e.eventId !== digest || typeof e.payload !== 'string') return null;
        if (Date.now() - row.updatedAt > TOUCH_AFTER_MS) {
          await putSyncCacheEntry({ ...row, updatedAt: Date.now() }).catch(() => {});
        }
        return e.payload;
      } catch {
        return null;
      }
    },
    async put(digest, plaintext) {
      try {
        const id = `${VAULT_KEY_ROW_PREFIX}${digest}`;
        const { iv, ciphertext } = await aesEncrypt(JSON.stringify({ id, eventId: digest, payload: plaintext }),
          await aesKeyFor(encryptionKey));
        const now = Date.now();
        await putSyncCacheEntry({ id, eventId: digest, createdAt: Math.floor(now / 1000),
          iv: b64(iv), ciphertext: b64(ciphertext), updatedAt: now });
        await pruneSyncCacheEntries(VAULT_KEY_ROW_PREFIX, VAULT_KEY_CACHE_ROWS);
      } catch { /* cache is best-effort */ }
    },
  };
}

const cacheable = (plaintext: unknown): plaintext is string =>
  typeof plaintext === 'string' && plaintext.length <= VAULT_KEY_MAX_PLAINTEXT;

/**
 * `backend` with its NIP-44 legs going through `cache`. One wrapper per
 * instance (instances are owned and `destroy()`ed by their caller); every
 * other member is the backend's own, bound to it.
 */
export function withVaultKeyCache<T extends DecryptingSigningBackend>(backend: T, cache: VaultKeyCache): T {
  const own = () => (HEX_64.test(backend.activePublicKeyHex) ? backend.activePublicKeyHex : null);
  const nip44Decrypt = async (sender: string, ciphertext: string): Promise<string> => {
    const pub = own();
    const digest = pub ? vaultKeyDigest(pub, sender, ciphertext) : null;
    const hit = digest ? await cache.get(digest) : null;
    if (hit !== null) return hit;
    const plaintext = await backend.nip44Decrypt(sender, ciphertext);
    if (digest && cacheable(plaintext)) await cache.put(digest, plaintext);
    return plaintext;
  };
  const nip44Encrypt = async (peer: string, plaintext: string): Promise<string> => {
    const ciphertext = await backend.nip44Encrypt(peer, plaintext);
    const pub = own();
    if (pub && cacheable(plaintext) && typeof ciphertext === 'string') {
      await cache.put(vaultKeyDigest(pub, peer, ciphertext), plaintext);
    }
    return ciphertext;
  };
  return new Proxy(backend, {
    get(target, prop) {
      if (prop === 'nip44Decrypt') return nip44Decrypt;
      if (prop === 'nip44Encrypt') return nip44Encrypt;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
