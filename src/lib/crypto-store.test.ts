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

describe('derived keys remembered until lock', () => {
  const unlockKey = 'ab'.repeat(32);
  it('derives a stored row\'s key once per unlock, again after forgetDerivedKeys, and never for a PIN', async () => {
    const { forgetDerivedKeys } = await import('./crypto-store');
    const { vi } = await import('vitest');
    forgetDerivedKeys();
    const sealed = await encryptSecret('row', unlockKey);
    const spy = vi.spyOn(crypto.subtle, 'deriveKey');
    try {
      for (let i = 0; i < 3; i++) expect(await decryptSecret(sealed, unlockKey)).toBe('row');
      expect(spy).toHaveBeenCalledTimes(1);
      // Another row (its own salt) needs its own key.
      await decryptSecret(await encryptSecret('other', unlockKey), unlockKey);
      expect(spy).toHaveBeenCalledTimes(3);
      forgetDerivedKeys();
      await decryptSecret(sealed, unlockKey);
      expect(spy).toHaveBeenCalledTimes(4);
      // A short passphrase (a PIN) is derived every time, never remembered.
      const pinSealed = await encryptSecret('pin row', '123456');
      spy.mockClear();
      await decryptSecret(pinSealed, '123456'); await decryptSecret(pinSealed, '123456');
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); forgetDerivedKeys(); }
  });
  it('a different unlock key never reuses a remembered key', async () => {
    const { forgetDerivedKeys } = await import('./crypto-store');
    forgetDerivedKeys();
    const sealed = await encryptSecret('row', unlockKey);
    expect(await decryptSecret(sealed, unlockKey)).toBe('row');
    await expect(decryptSecret(sealed, 'cd'.repeat(32))).rejects.toThrow();
    expect(await decryptSecret(sealed, unlockKey)).toBe('row');
    forgetDerivedKeys();
  });
});
