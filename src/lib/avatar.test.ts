import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  initialFromName, colourFromPubkey, AVATAR_MAX_BYTES, AVATAR_MAX_DOWNLOAD_BYTES, fetchAvatar,
  uploadAvatar, uploadContactAvatar, uploadPublicPicture, downscaleAvatar,
} from './avatar';
import {
  AVATAR_UPLOADER_DOMAIN, CONTACT_AVATAR_UPLOADER_DOMAIN, PUBLIC_PICTURE_UPLOADER_DOMAIN, deriveUploaderKey, hmacUploaderBackend,
} from './blossom-uploader';
import { encryptPhoto, decryptPhoto } from './photo-crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
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

  it('S3: the user\'s own server may be a single-label name or an IP literal; a contact-controlled one may not', async () => {
    const plaintext = new Uint8Array([1, 2, 3]);
    const { encryptedBlob, keyHex } = await encryptPhoto(plaintext);
    const bytes = new Uint8Array(encryptedBlob);
    const hash = bytesToHex(sha256(bytes));
    const body = () => ({
      ok: true, status: 200, headers: { get: () => null }, body: null,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    for (const own of ['https://nas', 'https://203.0.113.5']) {
      const fetchFn = mockFetchOnce(body);
      const blob = await fetchAvatar({ hash, blossomUrl: own, keyHex });
      expect(blob.size).toBe(3);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
      const contactFetch = mockFetchOnce(body);
      await expect(fetchAvatar({ hash, blossomUrl: own, keyHex, contactControlled: true })).rejects.toThrow(/unsafe Blossom URL/);
      expect(contactFetch).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it('S5: a contact-controlled GET refuses redirects and sends no credentials; the user\'s own server follows them', async () => {
    const { encryptedBlob, keyHex } = await encryptPhoto(new Uint8Array([1]));
    const bytes = new Uint8Array(encryptedBlob);
    const hash = bytesToHex(sha256(bytes));
    const body = () => ({
      ok: true, status: 200, headers: { get: () => null }, body: null,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    const calls: Array<RequestInit | undefined> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => { calls.push(init); return body(); }));
    await fetchAvatar({ hash, blossomUrl: 'https://blossom.example.com', keyHex, contactControlled: true });
    await fetchAvatar({ hash, blossomUrl: 'https://blossom.example.com', keyHex });
    expect(calls[0]).toMatchObject({ redirect: 'error', credentials: 'omit' });
    // Own server: blossom.primal.net answers GETs with a 302 to its media host.
    expect(calls[1]?.redirect).toBeUndefined();
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

// ---- Blossom upload auth: never an identity, persona or dependant key --------

const SERVER = 'https://nostr.download';
const UNLOCK_KEY = 'correct-horse-battery-staple';
/** The key the real-name (NP), persona and dependant slots would sign with. */
const REAL_PUBKEYS = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];

/** Stub fetch as a Blossom server; returns the decoded kind-24242 auth events it was sent. */
function stubBlossom(): Array<{ pubkey: string; kind: number; tags: string[][]; sig: string }> {
  const seen: Array<{ pubkey: string; kind: number; tags: string[][]; sig: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const header = (init.headers as Record<string, string>).Authorization;
    seen.push(JSON.parse(atob(header.replace(/^Nostr /, ''))));
    const body = new Uint8Array(await (init.body as Blob).arrayBuffer());
    return new Response(JSON.stringify({ sha256: bytesToHex(sha256(body)) }), { status: 200 });
  }));
  return seen;
}

describe('Blossom upload auth is signed by one-off keys', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The uploader pubkey this install rebuilds for `(domain, blob hash)` — what a later DELETE would sign with. */
  async function rebuiltPubkey(domain: string, blobHash: string): Promise<string> {
    const backend = await hmacUploaderBackend(domain, blobHash, UNLOCK_KEY);
    const pubkey = backend.activePublicKeyHex;
    backend.destroy();
    return pubkey;
  }

  it('uploadPublicPicture: signed by the HMAC key for (public-picture domain, blob hash), never a real key', async () => {
    const seen = stubBlossom();
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    const hash = await uploadPublicPicture(blob, SERVER, true, UNLOCK_KEY);
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe(24242);
    expect(REAL_PUBKEYS).not.toContain(seen[0].pubkey);
    expect(seen[0].pubkey).toBe(await rebuiltPubkey(PUBLIC_PICTURE_UPLOADER_DOMAIN, hash));
    // Different bytes -> a different uploader (unlinkable per blob).
    const other = await uploadPublicPicture(new Blob([new Uint8Array([4, 5, 6])], { type: 'image/jpeg' }), SERVER, true, UNLOCK_KEY);
    expect(seen[1].pubkey).toBe(await rebuiltPubkey(PUBLIC_PICTURE_UPLOADER_DOMAIN, other));
    expect(seen[1].pubkey).not.toBe(seen[0].pubkey);
  }, 30_000);

  it('uploadPublicPicture still enforces the consent gate', async () => {
    stubBlossom();
    await expect(uploadPublicPicture(new Blob([new Uint8Array([1])]), SERVER, false, UNLOCK_KEY)).rejects.toThrow('Enable Blossom uploads');
  }, 30_000);

  it('uploadAvatar: signed by the HMAC key for (avatar domain, encrypted blob hash), not derivable from the content key', async () => {
    const seen = stubBlossom();
    const meta = await uploadAvatar(new Blob([new Uint8Array([9, 9, 9])], { type: 'image/jpeg' }), SERVER, true, UNLOCK_KEY);
    expect(seen).toHaveLength(1);
    expect(seen[0].pubkey).toBe(await rebuiltPubkey(AVATAR_UPLOADER_DOMAIN, meta.hash));
    expect(REAL_PUBKEYS).not.toContain(seen[0].pubkey);
    // The content key (shared with a kid's device) must not yield the signer.
    expect(seen[0].pubkey).not.toBe(bytesToHex(schnorr.getPublicKey(deriveUploaderKey(meta.keyHex, AVATAR_UPLOADER_DOMAIN))));
  }, 30_000);

  it('uploadContactAvatar: signed by the HMAC key for (contact-avatar domain, blob hash), not derivable from the content key that goes in contact QRs', async () => {
    const seen = stubBlossom();
    const keyHex = '7'.repeat(64);
    const first = await uploadContactAvatar(new Uint8Array([4, 5, 6]), keyHex, SERVER, true, UNLOCK_KEY);
    const second = await uploadContactAvatar(new Uint8Array([7, 8, 9]), keyHex, SERVER, true, UNLOCK_KEY);
    expect(seen[0].pubkey).toBe(await rebuiltPubkey(CONTACT_AVATAR_UPLOADER_DOMAIN, first.hash));
    expect(seen[1].pubkey).toBe(await rebuiltPubkey(CONTACT_AVATAR_UPLOADER_DOMAIN, second.hash));
    const fromContentKey = bytesToHex(schnorr.getPublicKey(deriveUploaderKey(keyHex, CONTACT_AVATAR_UPLOADER_DOMAIN)));
    expect(seen.map(e => e.pubkey)).not.toContain(fromContentKey);
    expect(seen[0].pubkey).not.toBe(await rebuiltPubkey(AVATAR_UPLOADER_DOMAIN, first.hash));
  }, 30_000);
});

// ---- downscaleAvatar with a crop ---------------------------------------------

function fakeCanvas() {
  const draws: number[][] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: (_b: unknown, ...a: number[]) => { draws.push(a); } }),
    toBlob: (cb: (b: Blob | null) => void, type: string, quality: number) => {
      cb(Object.assign(new Blob(['jpeg'], { type }), { quality }));
    },
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, draws };
}
const bitmapOf = (width: number, height: number) => ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;

describe('downscaleAvatar crop', () => {
  it('cuts the chosen square, scaled to min(maxEdge, crop px), decoding with the preview orientation', async () => {
    const { canvas, draws } = fakeCanvas();
    const decode = vi.fn(async () => bitmapOf(2000, 1000));
    // Square at x 25%..75% of the width (side 50% of width = 1000 px), y 0.
    const out = await downscaleAvatar(new Blob(['x']), 512, { x: 0.25, y: 0, side: 0.5 }, { decode, makeCanvas: () => canvas });
    expect(decode).toHaveBeenCalledWith(expect.anything(), { imageOrientation: 'from-image' });
    expect(canvas.width).toBe(512);
    expect(canvas.height).toBe(512);
    expect(draws).toEqual([[500, 0, 1000, 1000, 0, 0, 512, 512]]);
    expect(out.type).toBe('image/jpeg');
    expect((out as Blob & { quality: number }).quality).toBe(0.85);
  });

  it('never upscales: a crop smaller than the max edge keeps its own pixel side', async () => {
    const { canvas } = fakeCanvas();
    // 300 px square from a 1200 px wide image.
    await downscaleAvatar(new Blob(['x']), 1024, { x: 0, y: 0, side: 0.25 }, { decode: async () => bitmapOf(1200, 900), makeCanvas: () => canvas });
    expect(canvas.width).toBe(300);
    expect(canvas.height).toBe(300);
  });

  it('refuses a crop that is not inside the image', async () => {
    const { canvas } = fakeCanvas();
    await expect(
      downscaleAvatar(new Blob(['x']), 512, { x: 0.8, y: 0, side: 0.5 }, { decode: async () => bitmapOf(100, 100), makeCanvas: () => canvas }),
    ).rejects.toThrow('crop');
  });

  it('without a crop the longest edge is capped and the aspect ratio kept, as before', async () => {
    const { canvas, draws } = fakeCanvas();
    const decode = vi.fn(async () => bitmapOf(2000, 1000));
    await downscaleAvatar(new Blob(['x']), 512, undefined, { decode, makeCanvas: () => canvas });
    expect(decode).toHaveBeenCalledWith(expect.anything(), undefined);
    expect([canvas.width, canvas.height]).toEqual([512, 256]);
    expect(draws).toEqual([[0, 0, 512, 256]]);
  });
});
