import { describe, expect, it, vi } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describeCryptoRequest, isBunkerCryptoMethod, runBunkerCrypto } from './bunker-crypto-approval';
import { LocalSigningBackend, type DecryptingSigningBackend } from './signing-backend';

const self = 'a'.repeat(64);
const peer = getPublicKey(generateSecretKey());

describe('describeCryptoRequest', () => {
  it('names data encrypted to yourself without a key', () => {
    expect(describeCryptoRequest('nip44_decrypt', self.toUpperCase(), self)).toBe('Decrypt data you encrypted to yourself');
    expect(describeCryptoRequest('nip44_encrypt', self, self)).toBe('Encrypt data to yourself');
  });
  it('names the other party by a short npub, never hex', () => {
    const text = describeCryptoRequest('nip44_decrypt', peer, self);
    expect(text).toMatch(/^Decrypt a message from npub1\S+…\S+$/);
    expect(text).not.toContain(peer);
    expect(describeCryptoRequest('nip44_encrypt', peer, self)).toMatch(/^Encrypt a message to npub1/);
  });
  it('marks NIP-04 as the older format', () => {
    expect(describeCryptoRequest('nip04_decrypt', peer, self)).toMatch(/\(older format\)$/);
  });
});

describe('isBunkerCryptoMethod', () => {
  it('accepts the four methods and nothing else', () => {
    for (const m of ['nip04_encrypt', 'nip04_decrypt', 'nip44_encrypt', 'nip44_decrypt']) expect(isBunkerCryptoMethod(m)).toBe(true);
    for (const m of ['sign_event', 'nip44', 'get_public_key', '']) expect(isBunkerCryptoMethod(m)).toBe(false);
  });
});

describe('runBunkerCrypto', () => {
  it('round-trips NIP-44 through a local key', async () => {
    const backend = new LocalSigningBackend(bytesToHex(generateSecretKey()));
    const me = backend.activePublicKeyHex;
    const enc = await runBunkerCrypto(backend, 'nip44_encrypt', me, 'secret');
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;
    expect(await runBunkerCrypto(backend, 'nip44_decrypt', me, enc.result)).toEqual({ ok: true, result: 'secret' });
  });
  it('reports NIP-04 as unsupported on a backend without it', async () => {
    const backend = { nip44Encrypt: vi.fn(), nip44Decrypt: vi.fn() } as unknown as DecryptingSigningBackend;
    expect(await runBunkerCrypto(backend, 'nip04_decrypt', peer, 'x')).toEqual({ ok: false, error: 'NIP-04 not supported' });
    expect(await runBunkerCrypto(backend, 'nip04_encrypt', peer, 'x')).toEqual({ ok: false, error: 'NIP-04 not supported' });
  });
  it('turns a backend failure into a wire error instead of throwing', async () => {
    const backend = {
      nip44Encrypt: vi.fn().mockRejectedValue(new Error('device said no: secret detail')),
      nip44Decrypt: vi.fn().mockRejectedValue(new Error('bad mac')),
    } as unknown as DecryptingSigningBackend;
    expect(await runBunkerCrypto(backend, 'nip44_decrypt', peer, 'x')).toEqual({ ok: false, error: 'decryption failed' });
    expect(await runBunkerCrypto(backend, 'nip44_encrypt', peer, 'x')).toEqual({ ok: false, error: 'encryption failed' });
  });
});
