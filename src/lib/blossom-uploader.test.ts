import { describe, it, expect } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  AVATAR_UPLOADER_DOMAIN, CONTACT_AVATAR_UPLOADER_DOMAIN, CONTACT_PICTURE_UPLOADER_DOMAIN, VENUE_PHOTO_UPLOADER_DOMAIN,
  deriveUploaderKey, derivedUploaderBackend, randomUploaderBackend,
} from './blossom-uploader';
import { deriveUploaderKey as deriveContactPictureKey } from './contact-picture-backup';

const K0 = '00'.repeat(32);
const K1 = '0123456789abcdef'.repeat(4);

describe('uploader domains', () => {
  it('are the documented strings', () => {
    expect(AVATAR_UPLOADER_DOMAIN).toBe('signet:avatar-uploader:v1');
    expect(CONTACT_AVATAR_UPLOADER_DOMAIN).toBe('signet:contact-avatar-uploader:v1');
    expect(CONTACT_PICTURE_UPLOADER_DOMAIN).toBe('signet:contact-picture-uploader:v1');
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
    const keys = [AVATAR_UPLOADER_DOMAIN, CONTACT_AVATAR_UPLOADER_DOMAIN, CONTACT_PICTURE_UPLOADER_DOMAIN, VENUE_PHOTO_UPLOADER_DOMAIN]
      .map(d => bytesToHex(deriveUploaderKey(K1, d)));
    expect(new Set(keys).size).toBe(4);
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

describe('uploader backends', () => {
  it('a derived backend signs as the pubkey of the derived key', () => {
    const backend = derivedUploaderBackend(K1, AVATAR_UPLOADER_DOMAIN);
    expect(backend.activePublicKeyHex).toBe(bytesToHex(schnorr.getPublicKey(deriveUploaderKey(K1, AVATAR_UPLOADER_DOMAIN))));
    backend.destroy();
  });

  it('a random backend is fresh every time', () => {
    const a = randomUploaderBackend();
    const b = randomUploaderBackend();
    expect(a.activePublicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(a.activePublicKeyHex).not.toBe(b.activePublicKeyHex);
    a.destroy();
    b.destroy();
  });
});
