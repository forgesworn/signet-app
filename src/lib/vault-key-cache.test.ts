import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createVaultKeyCache, withVaultKeyCache, vaultKeyDigest, VAULT_KEY_CACHE_ROWS, VAULT_KEY_ROW_PREFIX } from './vault-key-cache';
import { createSyncDecryptCache, forgetSyncCacheKeys } from './sync-decrypt-cache';
import { clearSyncCache, getSyncCacheEntry, putSyncCacheEntry } from './db';
import { LocalSigningBackend } from './signing-backend';
import type { DecryptingSigningBackend } from './signing-backend';
import { sealVaultPayload, openVaultPayload } from './vault-envelope';
import { VaultApprovalError } from './vault-approval';

const KEY = 'a'.repeat(64);

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
    const ct = await device.nip44Encrypt(device.activePublicKeyHex, 'k');
    device.nip44Decrypt.mockRejectedValueOnce(refusal);
    await expect(wrapped.nip44Decrypt(device.activePublicKeyHex, ct)).rejects.toBe(refusal);
    expect(await getSyncCacheEntry(`${VAULT_KEY_ROW_PREFIX}${vaultKeyDigest(device.activePublicKeyHex, device.activePublicKeyHex, ct)}`)).toBeUndefined();
    expect(await wrapped.nip44Decrypt(device.activePublicKeyHex, ct)).toBe('k');
    expect(device.nip44Decrypt).toHaveBeenCalledTimes(2);
    const encryptRefusal = new VaultApprovalError('The signer refused the vault request');
    device.nip44Encrypt.mockRejectedValueOnce(encryptRefusal);
    await expect(wrapped.nip44Encrypt(device.activePublicKeyHex, 'k')).rejects.toBe(encryptRefusal);
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
    const ct = await device.nip44Encrypt(pub, 'k1');
    await wrapped.nip44Decrypt(pub, ct);
    const id = `${VAULT_KEY_ROW_PREFIX}${vaultKeyDigest(pub, pub, ct)}`;
    const row = (await getSyncCacheEntry(id))!;
    await putSyncCacheEntry({ ...row, ciphertext: btoa('garbage-garbage-garbage') });
    expect(await wrapped.nip44Decrypt(pub, ct)).toBe('k1');
    expect(device.nip44Decrypt).toHaveBeenCalledTimes(2);
    // A valid row lifted into another digest's slot does not answer for it.
    const other = await device.nip44Encrypt(pub, 'k2');
    const otherId = `${VAULT_KEY_ROW_PREFIX}${vaultKeyDigest(pub, pub, other)}`;
    const good = (await getSyncCacheEntry(id))!;
    await putSyncCacheEntry({ ...good, id: otherId, eventId: otherId.slice(VAULT_KEY_ROW_PREFIX.length) });
    expect(await wrapped.nip44Decrypt(pub, other)).toBe('k2');
    expect(device.nip44Decrypt).toHaveBeenCalledTimes(3);
  });

  it('caps its rows, evicting the oldest writes and never a rail row', async () => {
    const rail = createSyncDecryptCache({ dTag: 'signet:personas', authorPubkey: 'b'.repeat(64), encryptionKey: KEY });
    await rail.put('ev1', 1, 'RAIL');
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    const cache = createVaultKeyCache(KEY);
    const digests = Array.from({ length: VAULT_KEY_CACHE_ROWS + 4 }, (_, i) => i.toString(16).padStart(64, '0'));
    for (const d of digests) await cache.put(d, `k-${d}`);
    for (const d of digests.slice(0, 4)) expect(await getSyncCacheEntry(`${VAULT_KEY_ROW_PREFIX}${d}`)).toBeUndefined();
    expect(await cache.get(digests[4])).toBe(`k-${digests[4]}`);
    expect(await cache.get(digests[digests.length - 1])).toBe(`k-${digests[digests.length - 1]}`);
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
});
