import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret, isEncrypted } from './crypto-store';

describe('encryptSecret / decryptSecret', () => {
  const passphrase = 'a]3kF9#mP2xL7qR1vN8wJ5tY0uBc6dHg';

  it('round-trips plaintext through encrypt then decrypt', async () => {
    const plaintext = 'my-secret-value-12345';
    const encrypted = await encryptSecret(plaintext, passphrase);
    const decrypted = await decryptSecret(encrypted, passphrase);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext each time (random IV/salt)', async () => {
    const plaintext = 'same-input';
    const a = await encryptSecret(plaintext, passphrase);
    const b = await encryptSecret(plaintext, passphrase);
    expect(a).not.toBe(b);
  });

  it('throws when decrypting with the wrong passphrase', async () => {
    const encrypted = await encryptSecret('secret', passphrase);
    await expect(decryptSecret(encrypted, 'wrong-passphrase-that-is-long')).rejects.toThrow();
  });

  it('throws on tampered ciphertext', async () => {
    const encrypted = await encryptSecret('secret', passphrase);
    const chars = encrypted.split('');
    const mid = Math.floor(chars.length / 2);
    chars[mid] = chars[mid] === 'A' ? 'B' : 'A';
    const tampered = chars.join('');
    await expect(decryptSecret(tampered, passphrase)).rejects.toThrow();
  });

  it('throws on ciphertext that is too short', async () => {
    const tooShort = btoa('x'.repeat(28));
    await expect(decryptSecret(tooShort, passphrase)).rejects.toThrow('Encrypted payload too short');
  });
});

describe('isEncrypted', () => {
  it('returns true for output of encryptSecret', async () => {
    const encrypted = await encryptSecret('test', 'passphrase-long-enough-here');
    expect(isEncrypted(encrypted)).toBe(true);
  });

  it('returns false for plain strings', () => {
    expect(isEncrypted('hello world')).toBe(false);
  });

  it('returns false for short base64', () => {
    expect(isEncrypted(btoa('short'))).toBe(false);
  });

  it('returns false for non-base64', () => {
    expect(isEncrypted('not!valid@base64###')).toBe(false);
  });
});
