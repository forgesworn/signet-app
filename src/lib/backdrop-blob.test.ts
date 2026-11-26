import { describe, it, expect, vi, afterEach } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  BACKDROP_MAX_BYTES, BACKDROP_MAX_DOWNLOAD_BYTES, uploadBackdrop, fetchBackdrop,
} from './backdrop-blob';
import { AVATAR_MAX_BYTES } from './avatar';
import {
  BACKDROP_UPLOADER_DOMAIN, AVATAR_UPLOADER_DOMAIN, deriveUploaderKey, hmacUploaderBackend,
} from './blossom-uploader';
import { encryptPhoto } from './photo-crypto';

const SERVER = 'https://nostr.download';
const UNLOCK_KEY = 'correct-horse-battery-staple';

function stubBlossom(): Array<{ pubkey: string; kind: number }> {
  const seen: Array<{ pubkey: string; kind: number }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const header = (init.headers as Record<string, string>).Authorization;
    seen.push(JSON.parse(atob(header.replace(/^Nostr /, ''))));
    const body = new Uint8Array(await (init.body as Blob).arrayBuffer());
    return new Response(JSON.stringify({ sha256: bytesToHex(sha256(body)) }), { status: 200 });
  }));
  return seen;
}

describe('backdrop caps', () => {
  it('are their own numbers: a 1280px backdrop outgrows the 500 KB avatar cap', () => {
    // Measured in Chromium (1280 px edge, JPEG 0.85): a photo-like 1280x960 is
    // about 180 KB; worst-case per-pixel colour noise at 1280x1280 is 1.17 MB.
    expect(BACKDROP_MAX_BYTES).toBe(1.5 * 1024 * 1024);
    expect(BACKDROP_MAX_BYTES).toBeGreaterThan(AVATAR_MAX_BYTES);
    expect(BACKDROP_MAX_BYTES).toBeGreaterThan(1_166_717);
    expect(BACKDROP_MAX_DOWNLOAD_BYTES).toBe(BACKDROP_MAX_BYTES * 2);
  });
});

describe('uploadBackdrop', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is signed by the backdrop-domain HMAC key for the encrypted blob, never one derivable from the content key', async () => {
    const seen = stubBlossom();
    const meta = await uploadBackdrop(new Blob([new Uint8Array([9, 9, 9])], { type: 'image/jpeg' }), SERVER, true, UNLOCK_KEY);
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe(24242);
    const rebuilt = await hmacUploaderBackend(BACKDROP_UPLOADER_DOMAIN, meta.hash, UNLOCK_KEY);
    expect(seen[0].pubkey).toBe(rebuilt.activePublicKeyHex);
    rebuilt.destroy();
    // The key handed to the child must not give the signer, in this or the avatar domain.
    for (const domain of [BACKDROP_UPLOADER_DOMAIN, AVATAR_UPLOADER_DOMAIN]) {
      expect(seen[0].pubkey).not.toBe(bytesToHex(schnorr.getPublicKey(deriveUploaderKey(meta.keyHex, domain))));
    }
    const asAvatar = await hmacUploaderBackend(AVATAR_UPLOADER_DOMAIN, meta.hash, UNLOCK_KEY);
    expect(seen[0].pubkey).not.toBe(asAvatar.activePublicKeyHex);
    asAvatar.destroy();
    expect(BACKDROP_UPLOADER_DOMAIN).not.toBe(AVATAR_UPLOADER_DOMAIN);
    expect(meta.blossomUrl).toBe(SERVER);
    expect(meta.keyHex).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it('enforces the Blossom consent gate', async () => {
    stubBlossom();
    await expect(uploadBackdrop(new Blob([new Uint8Array([1])]), SERVER, false, UNLOCK_KEY)).rejects.toThrow('Enable Blossom uploads');
  }, 30_000);

  it('refuses a blob over the backdrop cap before anything is sent, and accepts one the avatar cap would refuse', async () => {
    const seen = stubBlossom();
    await expect(uploadBackdrop(new Blob([new Uint8Array(BACKDROP_MAX_BYTES + 1)]), SERVER, true, UNLOCK_KEY)).rejects.toThrow(/too large/i);
    expect(seen).toHaveLength(0);
    const big = new Uint8Array(AVATAR_MAX_BYTES + 1024);
    await expect(uploadBackdrop(new Blob([big], { type: 'image/jpeg' }), SERVER, true, UNLOCK_KEY)).resolves.toMatchObject({ blossomUrl: SERVER });
  }, 30_000);
});

describe('fetchBackdrop', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('verifies the hash, decrypts, and returns the picture bytes', async () => {
    const plain = new Uint8Array([1, 2, 3, 4, 5]);
    const { encryptedBlob, keyHex } = await encryptPhoto(plain);
    const enc = new Uint8Array(encryptedBlob);
    const hash = bytesToHex(sha256(enc));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(enc, { status: 200 })));
    const blob = await fetchBackdrop({ hash, blossomUrl: SERVER, keyHex });
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(plain);
    expect(blob.type).toBe('image/jpeg');
  });

  it('rejects a server that returns different bytes', async () => {
    const { encryptedBlob, keyHex } = await encryptPhoto(new Uint8Array([1]));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(encryptedBlob), { status: 200 })));
    await expect(fetchBackdrop({ hash: 'a'.repeat(64), blossomUrl: SERVER, keyHex })).rejects.toThrow(/hash mismatch/i);
  });

  it.each(['http://nostr.download', 'https://127.0.0.1', 'https://192.168.1.5', 'https://localhost', 'ftp://x.example'])(
    'applies the avatar SSRF guard to an inventory-supplied server: %s', async (url) => {
      const f = vi.fn();
      vi.stubGlobal('fetch', f);
      await expect(fetchBackdrop({ hash: 'a'.repeat(64), blossomUrl: url, keyHex: 'b'.repeat(64) })).rejects.toThrow(/unsafe/i);
      expect(f).not.toHaveBeenCalled();
    });

  it('caps the download at the backdrop download cap, not the avatar one', async () => {
    // Over the avatar download cap (2 MB) but under the backdrop one: read, then fail the hash, not the size.
    const over = new Uint8Array(2 * 1024 * 1024 + 10);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(over, { status: 200 })));
    await expect(fetchBackdrop({ hash: 'a'.repeat(64), blossomUrl: SERVER, keyHex: 'b'.repeat(64) })).rejects.toThrow(/hash mismatch/i);
    const tooBig = new Uint8Array(BACKDROP_MAX_DOWNLOAD_BYTES + 10);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(tooBig, { status: 200 })));
    await expect(fetchBackdrop({ hash: 'a'.repeat(64), blossomUrl: SERVER, keyHex: 'b'.repeat(64) })).rejects.toThrow(/too large/i);
  });
});
