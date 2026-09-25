import { describe, it, expect, vi, afterEach } from 'vitest';
import { initialFromName, colourFromPubkey, AVATAR_MAX_BYTES, AVATAR_MAX_DOWNLOAD_BYTES, fetchAvatar } from './avatar';
import { encryptPhoto, decryptPhoto } from './photo-crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

describe('avatar.initialFromName', () => {
  it('returns first letter uppercased', () => {
    expect(initialFromName('Lily')).toBe('L');
    expect(initialFromName('alice')).toBe('A');
  });

  it('falls back to ? for empty', () => {
    expect(initialFromName('')).toBe('?');
    expect(initialFromName('   ')).toBe('?');
  });

  it('handles emoji-prefixed names', () => {
    expect(initialFromName('🎮 Gamer')).toBe('G');
  });
});

describe('avatar.colourFromPubkey', () => {
  it('returns deterministic gradient css for the same pubkey', () => {
    const pk = 'a'.repeat(64);
    const a = colourFromPubkey(pk);
    const b = colourFromPubkey(pk);
    expect(a).toBe(b);
  });

  it('returns different gradients for different pubkeys', () => {
    const a = colourFromPubkey('a'.repeat(64));
    const b = colourFromPubkey('b'.repeat(64));
    expect(a).not.toBe(b);
  });

  it('returns a valid linear-gradient string', () => {
    const g = colourFromPubkey('1234'.repeat(16));
    expect(g).toMatch(/^linear-gradient/);
  });

  it('is a muted, on-brand jewel tone with legible white text (2026-09 rebrand)', () => {
    const pubkeys = ['a'.repeat(64), 'b'.repeat(64), '0123456789abcdef'.repeat(4), 'deadbeef'.repeat(8), '7'.repeat(64)];
    for (const pk of pubkeys) {
      const g = colourFromPubkey(pk);
      const rgbs = [...g.matchAll(/rgb\((\d+),(\d+),(\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const);
      expect(rgbs).toHaveLength(2);
      for (const [r, gg, b] of rgbs) {
        // Saturation constrained to a muted band.
        const max = Math.max(r, gg, b) / 255;
        const min = Math.min(r, gg, b) / 255;
        const l = (max + min) / 2;
        const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
        expect(s).toBeGreaterThanOrEqual(0.20);
        expect(s).toBeLessThanOrEqual(0.40);

        // WCAG contrast of white (#FFFFFF) text over this swatch is >= 4.5:1.
        const toLinear = (c: number) => {
          const cs = c / 255;
          return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
        };
        const luminance = 0.2126 * toLinear(r) + 0.7152 * toLinear(gg) + 0.0722 * toLinear(b);
        const contrast = (1.0 + 0.05) / (luminance + 0.05);
        expect(contrast).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('avatar — photo-crypto encrypt/decrypt round-trip', () => {
  // The avatar upload/fetch path leans on photo-crypto for AES-GCM. These
  // tests cover the round-trip directly so we catch any regression in the
  // primitive before the upload layer is even on the relay.
  it('decrypts what encryptPhoto produced', async () => {
    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const { encryptedBlob, keyHex } = await encryptPhoto(plaintext);
    expect(keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(encryptedBlob.byteLength).toBe(plaintext.byteLength + 12 + 16); // iv + ct + tag
    const decrypted = await decryptPhoto(encryptedBlob, keyHex);
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
  });

  it('rejects a wrong key with a SubtleCrypto exception', async () => {
    const plaintext = new Uint8Array([42]);
    const { encryptedBlob } = await encryptPhoto(plaintext);
    const wrongKey = 'f'.repeat(64);
    await expect(decryptPhoto(encryptedBlob, wrongKey)).rejects.toThrow();
  });

  it('rejects a malformed key string', async () => {
    const plaintext = new Uint8Array([42]);
    const { encryptedBlob } = await encryptPhoto(plaintext);
    await expect(decryptPhoto(encryptedBlob, 'not-hex')).rejects.toThrow(/Invalid photo key/);
  });

  it('rejects a truncated blob', async () => {
    const tooShort = new Uint8Array(20); // less than IV (12) + auth tag (16)
    await expect(decryptPhoto(tooShort, 'a'.repeat(64))).rejects.toThrow(/too short/);
  });

  it('survives a binary roundtrip with random bytes', async () => {
    const plaintext = crypto.getRandomValues(new Uint8Array(1024));
    const { encryptedBlob, keyHex } = await encryptPhoto(plaintext);
    const decrypted = await decryptPhoto(encryptedBlob, keyHex);
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
  });
});

describe('avatar — constants', () => {
  it('AVATAR_MAX_BYTES is a sane size cap', () => {
    // Sanity check that the cap stays in the order of magnitude we expect.
    // The cap is enforced by uploadAvatar to keep Blossom load reasonable.
    expect(AVATAR_MAX_BYTES).toBeGreaterThanOrEqual(100 * 1024); // ≥ 100KB
    expect(AVATAR_MAX_BYTES).toBeLessThanOrEqual(2 * 1024 * 1024); // ≤ 2MB
  });
});

describe('fetchAvatar — SSRF guard + download cap (security audit 2026-06-15)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function mockFetchOnce(impl: (url: string) => unknown) {
    const fn = vi.fn(async (url: string) => impl(url));
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('rejects an internal/private Blossom host WITHOUT issuing a request', async () => {
    const fetchFn = mockFetchOnce(() => { throw new Error('should not fetch'); });
    await expect(fetchAvatar({
      hash: 'a'.repeat(64),
      blossomUrl: 'https://169.254.169.254',
      keyHex: 'b'.repeat(64),
    })).rejects.toThrow(/unsafe Blossom URL/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a non-https Blossom host without issuing a request', async () => {
    const fetchFn = mockFetchOnce(() => { throw new Error('should not fetch'); });
    await expect(fetchAvatar({
      hash: 'a'.repeat(64),
      blossomUrl: 'http://evil.example.com',
      keyHex: 'b'.repeat(64),
    })).rejects.toThrow(/unsafe Blossom URL/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a body whose declared Content-Length exceeds the cap', async () => {
    mockFetchOnce(() => ({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(AVATAR_MAX_DOWNLOAD_BYTES + 1) : null) },
      body: null,
      arrayBuffer: async () => new ArrayBuffer(8),
    }));
    await expect(fetchAvatar({
      hash: 'a'.repeat(64),
      blossomUrl: 'https://blossom.example.com',
      keyHex: 'b'.repeat(64),
    })).rejects.toThrow(/too large/);
  });

  it('rejects an oversized body when Content-Length is absent (buffered fallback post-check)', async () => {
    const huge = new Uint8Array(AVATAR_MAX_DOWNLOAD_BYTES + 16);
    mockFetchOnce(() => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: null,
      arrayBuffer: async () => huge.buffer,
    }));
    await expect(fetchAvatar({
      hash: 'a'.repeat(64),
      blossomUrl: 'https://blossom.example.com',
      keyHex: 'b'.repeat(64),
    })).rejects.toThrow(/too large/);
  });

  it('aborts a streamed body that exceeds the cap', async () => {
    const chunk = new Uint8Array(64 * 1024); // 64KB chunks
    let sent = 0;
    const cancel = vi.fn(async () => {});
    mockFetchOnce(() => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => {
            if (sent > AVATAR_MAX_DOWNLOAD_BYTES + chunk.length) return { done: true, value: undefined };
            sent += chunk.length;
            return { done: false, value: chunk };
          },
          cancel,
        }),
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    await expect(fetchAvatar({
      hash: 'a'.repeat(64),
      blossomUrl: 'https://blossom.example.com',
      keyHex: 'b'.repeat(64),
    })).rejects.toThrow(/exceeded cap/);
    expect(cancel).toHaveBeenCalled();
  });

  it('fetches + verifies + decrypts a valid avatar from a public host', async () => {
    const plaintext = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    const { encryptedBlob, keyHex } = await encryptPhoto(plaintext);
    const bytes = new Uint8Array(encryptedBlob);
    const hash = bytesToHex(sha256(bytes));
    mockFetchOnce(() => ({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
      body: null,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }));
    const blob = await fetchAvatar({ hash, blossomUrl: 'https://blossom.example.com', keyHex });
    const out = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(out)).toEqual(Array.from(plaintext));
  });
});
