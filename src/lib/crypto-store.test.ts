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
    const { forgetDerivedKeys, rememberDerivedKeysFor } = await import('./crypto-store');
    const { vi } = await import('vitest');
    forgetDerivedKeys();
    rememberDerivedKeysFor(unlockKey);
    const sealed = await encryptSecret('row', unlockKey);
    const spy = vi.spyOn(crypto.subtle, 'deriveKey');
    try {
      for (let i = 0; i < 3; i++) expect(await decryptSecret(sealed, unlockKey)).toBe('row');
      expect(spy).toHaveBeenCalledTimes(1);
      // Another row (its own salt) needs its own key.
      await decryptSecret(await encryptSecret('other', unlockKey), unlockKey);
      expect(spy).toHaveBeenCalledTimes(3);
      forgetDerivedKeys();
      // Locked: nothing is remembered, so a read still running at lock cannot refill it.
      await decryptSecret(sealed, unlockKey); await decryptSecret(sealed, unlockKey);
      expect(spy).toHaveBeenCalledTimes(5);
      rememberDerivedKeysFor(unlockKey);
      // A short passphrase (a PIN) is derived every time, never remembered.
      const pinSealed = await encryptSecret('pin row', '123456');
      spy.mockClear();
      await decryptSecret(pinSealed, '123456'); await decryptSecret(pinSealed, '123456');
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); forgetDerivedKeys(); }
  });
  it('a different unlock key never reuses a remembered key', async () => {
    const { forgetDerivedKeys, rememberDerivedKeysFor } = await import('./crypto-store');
    forgetDerivedKeys();
    rememberDerivedKeysFor(unlockKey);
    const sealed = await encryptSecret('row', unlockKey);
    expect(await decryptSecret(sealed, unlockKey)).toBe('row');
    await expect(decryptSecret(sealed, 'cd'.repeat(32))).rejects.toThrow();
    expect(await decryptSecret(sealed, unlockKey)).toBe('row');
    forgetDerivedKeys();
  });
});

describe('keys derived ahead for vault writes', () => {
  const unlockKey = 'ef'.repeat(32);
  const saltOf = (sealed: string) => atob(sealed).slice(0, 16);
  it('gives every write a fresh salt, reads back without deriving, and matches encryptSecret\'s format', async () => {
    const { encryptSecretAhead, encryptSecretsBatchAhead, forgetDerivedKeys, rememberDerivedKeysFor } = await import('./crypto-store');
    const { vi } = await import('vitest');
    forgetDerivedKeys();
    rememberDerivedKeysFor(unlockKey);
    try {
      const sealed: string[] = [];
      for (let i = 0; i < 6; i++) sealed.push(await encryptSecretAhead(`row ${i}`, unlockKey));
      expect(new Set(sealed.map(saltOf)).size).toBe(6);
      const batch = await encryptSecretsBatchAhead(['a', 'b'], unlockKey);
      expect(saltOf(batch[0])).toBe(saltOf(batch[1]));
      expect(sealed.map(saltOf)).not.toContain(saltOf(batch[0]));
      const spy = vi.spyOn(crypto.subtle, 'deriveKey');
      try {
        for (let i = 0; i < 6; i++) expect(await decryptSecret(sealed[i], unlockKey)).toBe(`row ${i}`);
        expect(await decryptSecret(batch[1], unlockKey)).toBe('b');
        expect(spy).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); }
      // Locked: the same ciphertext needs its key derived again.
      forgetDerivedKeys();
      expect(await decryptSecret(sealed[0], unlockKey)).toBe('row 0');
    } finally { forgetDerivedKeys(); }
  });
  it('a passphrase that is not the remembered unlock key derives as encryptSecret does, with nothing ahead', async () => {
    const { encryptSecretAhead, encryptsAhead, forgetDerivedKeys, rememberDerivedKeysFor } = await import('./crypto-store');
    const { vi } = await import('vitest');
    forgetDerivedKeys();
    expect(encryptsAhead(unlockKey)).toBe(false);
    const spy = vi.spyOn(crypto.subtle, 'deriveKey');
    try {
      await encryptSecretAhead('locked', unlockKey);
      expect(spy).toHaveBeenCalledTimes(1);
      rememberDerivedKeysFor(unlockKey);
      expect(encryptsAhead(unlockKey)).toBe(true);
      expect(encryptsAhead('123456')).toBe(false);
      spy.mockClear();
      await encryptSecretAhead('pin row', '123456');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); forgetDerivedKeys(); }
  });
  it('keys derived for one unlock never serve another, even when they finish after the switch', async () => {
    const { encryptSecretAhead, forgetDerivedKeys, rememberDerivedKeysFor } = await import('./crypto-store');
    const other = '01'.repeat(32);
    forgetDerivedKeys();
    rememberDerivedKeysFor(unlockKey);
    // Starts keys ahead for the first unlock key, then switches before they land.
    const first = encryptSecretAhead('first', unlockKey);
    rememberDerivedKeysFor(other);
    const second = await encryptSecretAhead('second', other);
    expect(await decryptSecret(await first, unlockKey)).toBe('first');
    expect(await decryptSecret(second, other)).toBe('second');
    await expect(decryptSecret(second, unlockKey)).rejects.toThrow();
    forgetDerivedKeys();
    const third = await encryptSecretAhead('third', other);
    expect(await decryptSecret(third, other)).toBe('third');
    await expect(decryptSecret(third, unlockKey)).rejects.toThrow();
  });
});
