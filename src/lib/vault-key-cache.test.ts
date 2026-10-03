import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createVaultKeyCache, withVaultKeyCache, vaultKeyDigest, VAULT_KEY_CACHE_ROWS, VAULT_KEY_ROW_PREFIX } from './vault-key-cache';
import { createSyncDecryptCache, forgetSyncCacheKeys } from './sync-decrypt-cache';
import { clearSyncCache, getSyncCacheEntry, putSyncCacheEntry } from './db';
import { LocalSigningBackend } from './signing-backend';
import type { DecryptingSigningBackend } from './signing-backend';
import { aesEncrypt } from './aes-crypto';
import { aesKeyFor } from './sync-decrypt-cache';
import { sealVaultPayload, openVaultPayload } from './vault-envelope';
import { VaultApprovalError } from './vault-approval';

const KEY = 'a'.repeat(64);
/** A well-formed key leg: base64 of 32 bytes, as vault-envelope wraps it. */
const leg = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
const LEG1 = leg(1), LEG2 = leg(2);

/** A real NIP-44 backend whose device calls are counted. */
function countingBackend() {
  const local = new LocalSigningBackend(bytesToHex(crypto.getRandomValues(new Uint8Array(32))));
  const backend = {
    type: 'bunker' as const,
    activePublicKeyHex: local.activePublicKeyHex,
    signEvent: vi.fn((e: Parameters<LocalSigningBackend['signEvent']>[0]) => local.signEvent(e)),
    nip44Encrypt: vi.fn((peer: string, text: string) => local.nip44Encrypt(peer, text)),
    nip44Decrypt: vi.fn((peer: string, ct: string) => local.nip44Decrypt(peer, ct)),
    destroy: vi.fn(),
  };
  return backend as typeof backend & DecryptingSigningBackend;
}

describe('vault key-leg cache', () => {
  beforeEach(async () => { forgetSyncCacheKeys(); await clearSyncCache(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('opens an unchanged envelope with no device decrypt, within and across unlocks', async () => {
    const device = countingBackend();
    const content = (await sealVaultPayload('{"v":1}', device))!;
    const pub = device.activePublicKeyHex;
    const first = withVaultKeyCache(device, createVaultKeyCache(KEY));
    expect(await openVaultPayload(content, first, pub)).toBe('{"v":1}');
    expect(device.nip44Decrypt).toHaveBeenCalledTimes(1);
    expect(await openVaultPayload(content, first, pub)).toBe('{"v":1}');
    expect(device.nip44Decrypt).toHaveBeenCalledTimes(1);
    // Next unlock: same unlock key, fresh cache and derived AES key.
    forgetSyncCacheKeys();
    expect(await openVaultPayload(content, withVaultKeyCache(device, createVaultKeyCache(KEY)), pub)).toBe('{"v":1}');
    expect(device.nip44Decrypt).toHaveBeenCalledTimes(1);
    // Another unlock key cannot read the row: a miss, not a throw.
    expect(await openVaultPayload(content, withVaultKeyCache(device, createVaultKeyCache('c'.repeat(64))), pub)).toBe('{"v":1}');
    expect(device.nip44Decrypt).toHaveBeenCalledTimes(2);
  });

  it('seeds on encrypt, so a just-sealed payload opens with no device decrypt', async () => {
    const device = countingBackend();
    const wrapped = withVaultKeyCache(device, createVaultKeyCache(KEY));
    const content = (await sealVaultPayload('fresh', wrapped))!;
    expect(device.nip44Encrypt).toHaveBeenCalledTimes(1);
    expect(await openVaultPayload(content, wrapped, device.activePublicKeyHex)).toBe('fresh');
    forgetSyncCacheKeys();
    expect(await openVaultPayload(content, withVaultKeyCache(device, createVaultKeyCache(KEY)), device.activePublicKeyHex)).toBe('fresh');
    expect(device.nip44Decrypt).not.toHaveBeenCalled();
  });

  it('does not cache a refusal, and rethrows the very error', async () => {
    const device = countingBackend();
    const refusal = new VaultApprovalError('The signer refused the vault request');
    const wrapped = withVaultKeyCache(device, createVaultKeyCache(KEY));
    const ct = await device.nip44Encrypt(device.activePublicKeyHex, LEG1);
    device.nip44Decrypt.mockRejectedValueOnce(refusal);
    await expect(wrapped.nip44Decrypt(device.activePublicKeyHex, ct)).rejects.toBe(refusal);
    expect(await getSyncCacheEntry(`${VAULT_KEY_ROW_PREFIX}${vaultKeyDigest(device.activePublicKeyHex, device.activePublicKeyHex, ct)}`)).toBeUndefined();
    expect(await wrapped.nip44Decrypt(device.activePublicKeyHex, ct)).toBe(LEG1);
    expect(device.nip44Decrypt).toHaveBeenCalledTimes(2);
    const encryptRefusal = new VaultApprovalError('The signer refused the vault request');
    device.nip44Encrypt.mockRejectedValueOnce(encryptRefusal);
    await expect(wrapped.nip44Encrypt(device.activePublicKeyHex, LEG1)).rejects.toBe(encryptRefusal);
  });

  it('never caches a long plaintext', async () => {
    const device = countingBackend();
    const wrapped = withVaultKeyCache(device, createVaultKeyCache(KEY));
    const ct = await device.nip44Encrypt(device.activePublicKeyHex, 'x'.repeat(200));
    await wrapped.nip44Decrypt(device.activePublicKeyHex, ct);
    await wrapped.nip44Decrypt(device.activePublicKeyHex, ct);
    expect(device.nip44Decrypt).toHaveBeenCalledTimes(2);
  });

  it('treats a corrupt or relabelled row as a miss', async () => {
    const device = countingBackend();
    const pub = device.activePublicKeyHex;
    const wrapped = withVaultKeyCache(device, createVaultKeyCache(KEY));
    const ct = await device.nip44Encrypt(pub, LEG1);
    await wrapped.nip44Decrypt(pub, ct);
    const id = `${VAULT_KEY_ROW_PREFIX}${vaultKeyDigest(pub, pub, ct)}`;
    const row = (await getSyncCacheEntry(id))!;
    await putSyncCacheEntry({ ...row, ciphertext: btoa('garbage-garbage-garbage') });
    expect(await wrapped.nip44Decrypt(pub, ct)).toBe(LEG1);
    expect(device.nip44Decrypt).toHaveBeenCalledTimes(2);
    // A valid row lifted into another digest's slot does not answer for it.
    const other = await device.nip44Encrypt(pub, LEG2);
    const otherId = `${VAULT_KEY_ROW_PREFIX}${vaultKeyDigest(pub, pub, other)}`;
    const good = (await getSyncCacheEntry(id))!;
    await putSyncCacheEntry({ ...good, id: otherId, eventId: otherId.slice(VAULT_KEY_ROW_PREFIX.length) });
    expect(await wrapped.nip44Decrypt(pub, other)).toBe(LEG2);
    expect(device.nip44Decrypt).toHaveBeenCalledTimes(3);
  });

  it('caps its rows, evicting the oldest writes and never a rail row', async () => {
    const rail = createSyncDecryptCache({ dTag: 'signet:personas', authorPubkey: 'b'.repeat(64), encryptionKey: KEY });
    await rail.put('ev1', 1, 'RAIL');
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    const cache = createVaultKeyCache(KEY);
    const digests = Array.from({ length: VAULT_KEY_CACHE_ROWS + 4 }, (_, i) => i.toString(16).padStart(64, '0'));
    for (const d of digests) await cache.put(d, LEG1);
    for (const d of digests.slice(0, 4)) expect(await getSyncCacheEntry(`${VAULT_KEY_ROW_PREFIX}${d}`)).toBeUndefined();
    expect(await cache.get(digests[4])).toBe(LEG1);
    expect(await cache.get(digests[digests.length - 1])).toBe(LEG1);
    expect(await rail.get('ev1')).toBe('RAIL');
  });

  it('keeps every other backend member as it was', async () => {
    const device = countingBackend();
    const wrapped = withVaultKeyCache(device, createVaultKeyCache(KEY));
    expect(wrapped.activePublicKeyHex).toBe(device.activePublicKeyHex);
    expect(wrapped.type).toBe('bunker');
    wrapped.destroy?.();
    expect(device.destroy).toHaveBeenCalledTimes(1);
    const event = await wrapped.signEvent({ kind: 30078, pubkey: device.activePublicKeyHex, created_at: 1, tags: [], content: '' });
    expect(event.pubkey).toBe(device.activePublicKeyHex);
  });

  it('is a no-op once the session is no longer current', async () => {
    let current = true;
    const cache = createVaultKeyCache(KEY, () => current);
    await cache.put('1'.repeat(64), LEG1);
    expect(await cache.get('1'.repeat(64))).toBe(LEG1);
    current = false;
    forgetSyncCacheKeys();
    // A late device reply after lock: no row written, no read served.
    await cache.put('2'.repeat(64), LEG2);
    expect(await getSyncCacheEntry(`${VAULT_KEY_ROW_PREFIX}${'2'.repeat(64)}`)).toBeUndefined();
    expect(await cache.get('1'.repeat(64))).toBeNull();
  });

  it('does not answer for another own key or another peer', async () => {
    const device = countingBackend();
    const other = countingBackend();
    const pub = device.activePublicKeyHex;
    const wrapped = withVaultKeyCache(device, createVaultKeyCache(KEY));
    const ct = await device.nip44Encrypt(pub, LEG1);
    expect(await wrapped.nip44Decrypt(pub, ct)).toBe(LEG1);
    // Same ciphertext, another sender: a miss, answered by the backend.
    device.nip44Decrypt.mockResolvedValueOnce(LEG2);
    expect(await wrapped.nip44Decrypt(other.activePublicKeyHex, ct)).toBe(LEG2);
    expect(device.nip44Decrypt).toHaveBeenCalledTimes(2);
    // Same ciphertext under another own key: a miss too.
    const stranger = countingBackend();
    stranger.nip44Decrypt.mockResolvedValueOnce(LEG2);
    expect(await withVaultKeyCache(stranger, createVaultKeyCache(KEY)).nip44Decrypt(pub, ct)).toBe(LEG2);
    expect(stranger.nip44Decrypt).toHaveBeenCalledTimes(1);
  });

  it('returns a malformed device reply unchanged but never caches it', async () => {
    const device = countingBackend();
    const pub = device.activePublicKeyHex;
    const wrapped = withVaultKeyCache(device, createVaultKeyCache(KEY));
    const ct = await device.nip44Encrypt(pub, LEG1);
    const bad = ['not-a-key', 'A'.repeat(44), btoa('x'.repeat(31)), leg(1).replace('=', '*')];
    for (const reply of bad) {
      device.nip44Decrypt.mockClear();
      device.nip44Decrypt.mockResolvedValue(reply);
      expect(await wrapped.nip44Decrypt(pub, ct)).toBe(reply);
      expect(await wrapped.nip44Decrypt(pub, ct)).toBe(reply);
      expect(device.nip44Decrypt).toHaveBeenCalledTimes(2);
    }
    expect(await getSyncCacheEntry(`${VAULT_KEY_ROW_PREFIX}${vaultKeyDigest(pub, pub, ct)}`)).toBeUndefined();
  });

  it('does not seed from an encrypt whose plaintext is not a key leg', async () => {
    const device = countingBackend();
    const pub = device.activePublicKeyHex;
    const wrapped = withVaultKeyCache(device, createVaultKeyCache(KEY));
    const ct = await wrapped.nip44Encrypt(pub, 'short note');
    expect(await getSyncCacheEntry(`${VAULT_KEY_ROW_PREFIX}${vaultKeyDigest(pub, pub, ct)}`)).toBeUndefined();
    expect(await wrapped.nip44Decrypt(pub, ct)).toBe('short note');
    expect(device.nip44Decrypt).toHaveBeenCalledTimes(1);
  });

  it('reads a row written by an earlier build with a malformed payload as a miss', async () => {
    const digest = 'c'.repeat(64);
    const id = `${VAULT_KEY_ROW_PREFIX}${digest}`;
    const { iv, ciphertext } = await aesEncrypt(JSON.stringify({ id, eventId: digest, payload: 'not-a-key' }), await aesKeyFor(KEY));
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    await putSyncCacheEntry({ id, eventId: digest, createdAt: 1, iv: b64(iv), ciphertext: b64(ciphertext), updatedAt: Date.now() });
    expect(await createVaultKeyCache(KEY).get(digest)).toBeNull();
  });

  it('refreshes a hit row older than an hour and leaves a younger one alone', async () => {
    let now = 5_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const cache = createVaultKeyCache(KEY);
    const digest = 'd'.repeat(64);
    const id = `${VAULT_KEY_ROW_PREFIX}${digest}`;
    await cache.put(digest, LEG1);
    const written = now;
    now += 30 * 60_000;
    expect(await cache.get(digest)).toBe(LEG1);
    expect((await getSyncCacheEntry(id))!.updatedAt).toBe(written);
    now += 31 * 60_000;
    expect(await cache.get(digest)).toBe(LEG1);
    expect((await getSyncCacheEntry(id))!.updatedAt).toBe(now);
  });
});
