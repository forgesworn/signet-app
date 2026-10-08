import { describe, it, expect } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hmac } from '@noble/hashes/hmac.js';
import {
  AVATAR_UPLOADER_DOMAIN, CONTACT_AVATAR_UPLOADER_DOMAIN, CONTACT_PICTURE_UPLOADER_DOMAIN, VENUE_PHOTO_UPLOADER_DOMAIN,
  PUBLIC_PICTURE_UPLOADER_DOMAIN,
  deriveUploaderKey, derivedUploaderBackend, deriveHmacUploaderKey, hmacUploaderBackend, hmacUploaderBackendForBlob,
} from './blossom-uploader';
import { getOrCreateUploaderSecret, purgeAllUserData } from './db';
import { deleteFromBlossom } from './blossom';
import { deriveUploaderKey as deriveContactPictureKey } from './contact-picture-backup';

const K0 = '00'.repeat(32);
const K1 = '0123456789abcdef'.repeat(4);

describe('uploader domains', () => {
  it('are the documented strings', () => {
    expect(AVATAR_UPLOADER_DOMAIN).toBe('signet:avatar-uploader:v1');
    expect(CONTACT_AVATAR_UPLOADER_DOMAIN).toBe('signet:contact-avatar-uploader:v1');
    expect(CONTACT_PICTURE_UPLOADER_DOMAIN).toBe('signet:contact-picture-uploader:v1');
    expect(VENUE_PHOTO_UPLOADER_DOMAIN).toBe('signet:venue-photo-uploader:v1');
    expect(PUBLIC_PICTURE_UPLOADER_DOMAIN).toBe('signet:public-picture-uploader:v1');
  });
});

describe('deriveUploaderKey', () => {
  it('is sha256(utf8(domain) || key) and deterministic', () => {
    const domain = AVATAR_UPLOADER_DOMAIN;
    const expected = bytesToHex(sha256(new Uint8Array([...new TextEncoder().encode(domain), ...hexToBytes(K1)])));
    expect(bytesToHex(deriveUploaderKey(K1, domain))).toBe(expected);
    expect(bytesToHex(deriveUploaderKey(K1, domain))).toBe(expected);
  });

  it('gives a different uploader per domain for the same content key', () => {
    const keys = [AVATAR_UPLOADER_DOMAIN, CONTACT_AVATAR_UPLOADER_DOMAIN, CONTACT_PICTURE_UPLOADER_DOMAIN, VENUE_PHOTO_UPLOADER_DOMAIN, PUBLIC_PICTURE_UPLOADER_DOMAIN]
      .map(d => bytesToHex(deriveUploaderKey(K1, d)));
    expect(new Set(keys).size).toBe(5);
  });

  it('rejects a malformed content key', () => {
    expect(() => deriveUploaderKey('zz', AVATAR_UPLOADER_DOMAIN)).toThrow();
    expect(() => deriveUploaderKey(K1.toUpperCase(), AVATAR_UPLOADER_DOMAIN)).toThrow();
  });

  it('keeps the contact-picture derivation byte-identical to before it was generalised (pinned vectors)', () => {
    // Computed with the pre-change implementation.
    expect(bytesToHex(deriveContactPictureKey(K0))).toBe('5254e3c9c0615828f1e21fe618d672935c7918264f99d6de3f38ffa6448e7412');
    expect(bytesToHex(deriveContactPictureKey(K1))).toBe('272ced7052649bba4e0200a9b33b311698b26c186ef62ab51e78a049cf264315');
    expect(bytesToHex(deriveUploaderKey(K0, CONTACT_PICTURE_UPLOADER_DOMAIN))).toBe('5254e3c9c0615828f1e21fe618d672935c7918264f99d6de3f38ffa6448e7412');
  });
});

describe('derivedUploaderBackend (contact-picture backup only)', () => {
  it('signs as the pubkey of the content-key-derived key', () => {
    const backend = derivedUploaderBackend(K1, CONTACT_PICTURE_UPLOADER_DOMAIN);
    expect(backend.activePublicKeyHex).toBe(bytesToHex(schnorr.getPublicKey(deriveUploaderKey(K1, CONTACT_PICTURE_UPLOADER_DOMAIN))));
    backend.destroy();
  });
});

const PASSPHRASE = 'correct-horse-battery-staple';
const SECRET = new Uint8Array(32).map((_, i) => i + 1);
const HASH_A = 'ab'.repeat(32);
const HASH_B = 'cd'.repeat(32);
const ALL_DOMAINS = [AVATAR_UPLOADER_DOMAIN, CONTACT_AVATAR_UPLOADER_DOMAIN, VENUE_PHOTO_UPLOADER_DOMAIN, PUBLIC_PICTURE_UPLOADER_DOMAIN];

describe('deriveHmacUploaderKey', () => {
  it('is HMAC-SHA256(secret, utf8(domain) || blob sha256 bytes) and deterministic', () => {
    const msg = new Uint8Array([...new TextEncoder().encode(AVATAR_UPLOADER_DOMAIN), ...hexToBytes(HASH_A)]);
    const expected = bytesToHex(hmac(sha256, SECRET, msg));
    expect(bytesToHex(deriveHmacUploaderKey(SECRET, AVATAR_UPLOADER_DOMAIN, HASH_A))).toBe(expected);
    expect(bytesToHex(deriveHmacUploaderKey(SECRET, AVATAR_UPLOADER_DOMAIN, HASH_A))).toBe(expected);
  });

  it('differs per blob, per domain and per secret', () => {
    const keys = new Set<string>();
    for (const d of ALL_DOMAINS) for (const h of [HASH_A, HASH_B]) keys.add(bytesToHex(deriveHmacUploaderKey(SECRET, d, h)));
    expect(keys.size).toBe(ALL_DOMAINS.length * 2);
    const other = new Uint8Array(32).fill(9);
    expect(keys.has(bytesToHex(deriveHmacUploaderKey(other, AVATAR_UPLOADER_DOMAIN, HASH_A)))).toBe(false);
  });

  it('is never the sha256-of-content-key derivation, whatever the content key', () => {
    // Anyone holding a content key can compute deriveUploaderKey(contentKey, domain); the HMAC key must not match.
    const hmacKey = bytesToHex(deriveHmacUploaderKey(SECRET, AVATAR_UPLOADER_DOMAIN, bytesToHex(sha256(hexToBytes(K1)))));
    for (const k of [K0, K1, HASH_A]) {
      for (const d of ALL_DOMAINS) expect(hmacKey).not.toBe(bytesToHex(deriveUploaderKey(k, d)));
    }
  });

  it('rejects a malformed blob hash or secret', () => {
    expect(() => deriveHmacUploaderKey(SECRET, AVATAR_UPLOADER_DOMAIN, 'zz')).toThrow();
    expect(() => deriveHmacUploaderKey(SECRET, AVATAR_UPLOADER_DOMAIN, HASH_A.toUpperCase())).toThrow();
    expect(() => deriveHmacUploaderKey(new Uint8Array(16), AVATAR_UPLOADER_DOMAIN, HASH_A)).toThrow();
  });
});

describe('hmacUploaderBackend', () => {
  it('signs as the HMAC key under the install secret, and rebuilds identically from (domain, hash) for a delete', async () => {
    const secret = await getOrCreateUploaderSecret(PASSPHRASE);
    const expected = bytesToHex(schnorr.getPublicKey(deriveHmacUploaderKey(secret, VENUE_PHOTO_UPLOADER_DOMAIN, HASH_A)));
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const blobHash = bytesToHex(sha256(new Uint8Array([1, 2, 3])));
    const uploader = await hmacUploaderBackendForBlob(VENUE_PHOTO_UPLOADER_DOMAIN, blob, PASSPHRASE);
    const rebuilt = await hmacUploaderBackend(VENUE_PHOTO_UPLOADER_DOMAIN, blobHash, PASSPHRASE);
    expect(rebuilt.activePublicKeyHex).toBe(uploader.activePublicKeyHex);
    expect(uploader.activePublicKeyHex).toBe(bytesToHex(schnorr.getPublicKey(deriveHmacUploaderKey(secret, VENUE_PHOTO_UPLOADER_DOMAIN, blobHash))));
    // A different blob or domain is a different uploader.
    expect((await hmacUploaderBackend(VENUE_PHOTO_UPLOADER_DOMAIN, HASH_A, PASSPHRASE)).activePublicKeyHex).toBe(expected);
    expect(expected).not.toBe(uploader.activePublicKeyHex);
    expect((await hmacUploaderBackend(AVATAR_UPLOADER_DOMAIN, blobHash, PASSPHRASE)).activePublicKeyHex).not.toBe(uploader.activePublicKeyHex);
    uploader.destroy();
    rebuilt.destroy();
  }, 20_000);

  it('the rebuilt backend signs a DELETE whose pubkey is the uploader of the original upload', async () => {
    const blobHash = bytesToHex(sha256(new Uint8Array([7, 7, 7])));
    const uploader = await hmacUploaderBackendForBlob(AVATAR_UPLOADER_DOMAIN, new Blob([new Uint8Array([7, 7, 7])]), PASSPHRASE);
    const rebuilt = await hmacUploaderBackend(AVATAR_UPLOADER_DOMAIN, blobHash, PASSPHRASE);
    let sent: { pubkey: string; tags: string[][] } | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(atob((init.headers as Record<string, string>).Authorization.replace(/^Nostr /, '')));
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    await deleteFromBlossom(blobHash, 'https://blossom.example', rebuilt, fetchImpl);
    expect(sent!.pubkey).toBe(uploader.activePublicKeyHex);
    expect(sent!.tags).toContainEqual(['t', 'delete']);
    expect(sent!.tags).toContainEqual(['x', blobHash]);
    uploader.destroy();
    rebuilt.destroy();
  }, 20_000);

  it('is a different uploader after the install secret is purged', async () => {
    const before = await hmacUploaderBackend(AVATAR_UPLOADER_DOMAIN, HASH_A, PASSPHRASE);
    await purgeAllUserData();
    const after = await hmacUploaderBackend(AVATAR_UPLOADER_DOMAIN, HASH_A, PASSPHRASE);
    expect(after.activePublicKeyHex).not.toBe(before.activePublicKeyHex);
    before.destroy();
    after.destroy();
  }, 20_000);
});
