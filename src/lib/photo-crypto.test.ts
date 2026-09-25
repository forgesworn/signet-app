import { describe, it, expect } from 'vitest';
import { encryptPhoto, encryptPhotoWithKey, decryptPhoto, generateContactAvatarKey } from './photo-crypto';

describe('encryptPhotoWithKey', () => {
  it('round-trips with decryptPhoto using a caller-supplied stable key', async () => {
    const key = generateContactAvatarKey();
    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 250, 0, 99]);
    const blob = await encryptPhotoWithKey(plaintext, key);
    expect(blob.byteLength).toBe(plaintext.byteLength + 12 + 16); // iv + ct + tag
    const out = await decryptPhoto(blob, key);
    expect(Array.from(out)).toEqual(Array.from(plaintext));
  });

  it('reuses the same key across calls (stable-key contract)', async () => {
    const key = generateContactAvatarKey();
    const a = await encryptPhotoWithKey(new Uint8Array([7, 7, 7]), key);
    const b = await encryptPhotoWithKey(new Uint8Array([9, 9, 9]), key);
    expect(Array.from(await decryptPhoto(a, key))).toEqual([7, 7, 7]);
    expect(Array.from(await decryptPhoto(b, key))).toEqual([9, 9, 9]);
  });

  it('rejects a malformed key', async () => {
    await expect(encryptPhotoWithKey(new Uint8Array([1]), 'not-hex')).rejects.toThrow(/Invalid photo key/);
  });
});

describe('generateContactAvatarKey', () => {
  it('returns 64-char lowercase hex', () => {
    expect(generateContactAvatarKey()).toMatch(/^[0-9a-f]{64}$/);
  });
  it('returns a different key each call', () => {
    expect(generateContactAvatarKey()).not.toBe(generateContactAvatarKey());
  });
});

describe('encryptPhoto (unchanged contract after refactor)', () => {
  it('still generates a fresh key and round-trips', async () => {
    const pt = crypto.getRandomValues(new Uint8Array(64));
    const { encryptedBlob, keyHex } = await encryptPhoto(pt);
    expect(keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.from(await decryptPhoto(encryptedBlob, keyHex))).toEqual(Array.from(pt));
  });
});
