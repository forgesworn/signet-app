import { describe, it, expect, vi } from 'vitest';
import {
  BUCKETS, TOP_BUCKET, LENGTH_PREFIX_BYTES, MAX_ENVELOPE_CHARS, MIN_NIP44_V2_CHARS,
  padToBucket, unpad, parseVaultEnvelope, looksLikeNip44V2,
  sealVaultPayload, openVaultPayload, openVaultPayloadOrThrow,
} from './vault-envelope';
import { importAesKeyRaw } from './aes-crypto';
import { LocalSigningBackend } from './signing-backend';

/** A plaintext of exactly `n` single-byte characters. */
const ascii = (n: number) => 'a'.repeat(n);

describe('BUCKETS', () => {
  it('is the power-of-two ladder from 4 KiB to 64 KiB', () => {
    expect([...BUCKETS]).toEqual([4096, 8192, 16384, 32768, 65536]);
    expect(TOP_BUCKET).toBe(65536);
    expect(LENGTH_PREFIX_BYTES).toBe(4);
  });

  // The relay pool caps a message at 131_072 bytes, and the top bucket
  // base64-expands to ~88 kB, so 100_000 is headroom over anything we can
  // ever legitimately receive and still a hard bound on what a hostile relay
  // can make us parse. It is NOT the old 262_144 — that admitted a `content`
  // twice the size the pool will ever deliver.
  it('caps the content string we will parse below the relay message limit', () => {
    expect(MAX_ENVELOPE_CHARS).toBe(100_000);
    expect(MAX_ENVELOPE_CHARS).toBeLessThan(131_072);
  });
});

describe('padToBucket', () => {
  it('pads a short payload to the smallest bucket', () => {
    expect(padToBucket('hello')!.length).toBe(4096);
  });

  it('fills the tail with zeroes and length-prefixes the body', () => {
    const padded = padToBucket('hi')!;
    expect(Array.from(padded.subarray(0, 4))).toEqual([0, 0, 0, 2]);
    expect(padded.subarray(6).every((b) => b === 0)).toBe(true);
  });

  // The 4-byte length prefix lives inside the bucket, so the largest payload
  // that still fits the 4 KiB bucket is 4096 - 4 = 4092 bytes.
  it('crosses a bucket boundary at exactly bucket-minus-prefix bytes', () => {
    expect(padToBucket(ascii(4091))!.length).toBe(4096);
    expect(padToBucket(ascii(4092))!.length).toBe(4096);
    expect(padToBucket(ascii(4093))!.length).toBe(8192);
  });

  it('measures UTF-8 bytes, not characters', () => {
    // 'é' is two bytes; 2046 of them is 4092 bytes — still the 4 KiB bucket.
    expect(padToBucket('é'.repeat(2046))!.length).toBe(4096);
    expect(padToBucket('é'.repeat(2047))!.length).toBe(8192);
  });

  it('returns null above the top bucket rather than truncating', () => {
    expect(padToBucket(ascii(TOP_BUCKET - LENGTH_PREFIX_BYTES))).not.toBeNull();
    expect(padToBucket(ascii(TOP_BUCKET - LENGTH_PREFIX_BYTES + 1))).toBeNull();
  });

  it('honours a caller-supplied lower ceiling', () => {
    expect(padToBucket(ascii(4092), 4096)!.length).toBe(4096);
    expect(padToBucket(ascii(4093), 4096)).toBeNull();
  });
});

describe('unpad', () => {
  it('round-trips every bucket', () => {
    for (const bucket of BUCKETS) {
      const body = ascii(bucket - LENGTH_PREFIX_BYTES);
      const padded = padToBucket(body)!;
      expect(padded.length).toBe(bucket);
      expect(unpad(padded)).toBe(body);
    }
  });

  it('round-trips an empty payload', () => {
    expect(unpad(padToBucket('')!)).toBe('');
  });

  it('round-trips through a subarray view', () => {
    const padded = padToBucket('offset me')!;
    const framed = new Uint8Array(padded.length + 8);
    framed.set(padded, 8);
    expect(unpad(framed.subarray(8))).toBe('offset me');
  });

  it('rejects a truncated buffer and a length prefix past the end', () => {
    expect(unpad(new Uint8Array(3))).toBeNull();
    const bad = new Uint8Array(16);
    new DataView(bad.buffer).setUint32(0, 999, false);
    expect(unpad(bad)).toBeNull();
  });
});

describe('importAesKeyRaw', () => {
  it('imports 32 bytes as an AES-GCM key that encrypts and decrypts', async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await importAesKeyRaw(raw);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array([1, 2, 3]));
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
    expect(Array.from(pt)).toEqual([1, 2, 3]);
  });

  it('rejects a key of the wrong length', async () => {
    await expect(importAesKeyRaw(new Uint8Array(16))).rejects.toThrow(/32 bytes/);
  });
});

const AUTHOR = 'a'.repeat(64);

/**
 * A fake NIP-44 v2 ciphertext: the version byte 2, then the plaintext,
 * space-padded to the 96-byte body a real v2 payload's floor implies, then
 * base64. `openVaultPayload` pre-filters the legacy fallback on exactly that
 * shape (S5), so a fixture without it would never reach the backend at all.
 * The trailing spaces are harmless: every rail parses its plaintext with
 * `JSON.parse`, which ignores trailing whitespace.
 */
function fakeNip44(plaintext: string): string {
  const body = new TextEncoder().encode(plaintext.padEnd(96, ' '));
  const bytes = new Uint8Array(1 + body.length);
  bytes[0] = 2;
  bytes.set(body, 1);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Reverse `fakeNip44`. Throws for anything that is not one, as a real signer
 * would. This block and `fakeNip44` above are repeated verbatim in
 * `vault-envelope-rails.test.ts` and in the five landed rail suites Task 3
 * migrates — deliberately duplicated rather than imported, because importing
 * a `.test.ts` file would re-register its `describe` blocks in the importer.
 */
function openFakeNip44(ciphertext: string): string {
  const bytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  if (bytes[0] !== 2) throw new Error('not our ciphertext');
  return new TextDecoder().decode(bytes.subarray(1));
}

/**
 * A fake NIP-44 backend: a visible, reversible wrapper with the real format's
 * outward shape. Real NIP-44 is exercised by signet-protocol's own tests; what
 * matters here is that the envelope only ever hands the backend a 32-byte key,
 * and that AES-GCM is the real thing.
 */
function makeBackend(overrides: Record<string, unknown> = {}) {
  return {
    activePublicKeyHex: AUTHOR,
    nip44Encrypt: vi.fn(async (_pub: string, plaintext: string) => fakeNip44(plaintext)),
    nip44Decrypt: vi.fn(async (_pub: string, ciphertext: string) => openFakeNip44(ciphertext)),
    ...overrides,
  } as never;
}

/** The plaintext the fake backend was asked to wrap on its Nth call. */
function wrappedArg(backend: unknown, call = 0): string {
  return (backend as { nip44Encrypt: { mock: { calls: string[][] } } }).nip44Encrypt.mock.calls[call][1];
}

function encryptCallCount(backend: unknown): number {
  return (backend as { nip44Encrypt: { mock: { calls: unknown[] } } }).nip44Encrypt.mock.calls.length;
}

describe('sealVaultPayload / openVaultPayload', () => {
  it('round-trips a small payload and wraps only the 32-byte key', async () => {
    const backend = makeBackend();
    const sealed = (await sealVaultPayload('{"hello":"world"}', backend))!;
    expect(sealed).not.toBeNull();
    const envelope = parseVaultEnvelope(sealed)!;
    expect(envelope.v).toBe(2);
    expect(envelope.b).toBe(4096);
    // The NIP-44 leg carries the base64 of a 32-byte content key and nothing
    // else, whatever the payload size — that is the whole point of the format.
    expect(atob(wrappedArg(backend)).length).toBe(32);
    expect(await openVaultPayload(sealed, backend, AUTHOR)).toBe('{"hello":"world"}');
  });

  it('never puts the plaintext on the NIP-44 leg', async () => {
    const backend = makeBackend();
    const sealed = (await sealVaultPayload('SECRET-MARKER', backend))!;
    expect(wrappedArg(backend)).not.toContain('SECRET-MARKER');
    expect(sealed).not.toContain('SECRET-MARKER');
  });

  it('round-trips at every bucket boundary', async () => {
    const backend = makeBackend();
    for (const bucket of BUCKETS) {
      const body = 'x'.repeat(bucket - LENGTH_PREFIX_BYTES);
      const sealed = (await sealVaultPayload(body, backend))!;
      expect(parseVaultEnvelope(sealed)!.b).toBe(bucket);
      expect(await openVaultPayload(sealed, backend, AUTHOR)).toBe(body);
    }
  });

  it('pads two different payloads in the same bucket to the same ciphertext length', async () => {
    const backend = makeBackend();
    const a = parseVaultEnvelope((await sealVaultPayload('a', backend))!)!;
    const b = parseVaultEnvelope((await sealVaultPayload('b'.repeat(3000), backend))!)!;
    expect(a.ct.length).toBe(b.ct.length);
  });

  it('uses a fresh content key and IV per seal', async () => {
    const backend = makeBackend();
    const first = parseVaultEnvelope((await sealVaultPayload('same', backend))!)!;
    const second = parseVaultEnvelope((await sealVaultPayload('same', backend))!)!;
    expect(first.k).not.toBe(second.k);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ct).not.toBe(second.ct);
  });

  it('returns null above the top bucket rather than truncating, without touching the backend', async () => {
    const backend = makeBackend();
    expect(await sealVaultPayload('x'.repeat(TOP_BUCKET), backend)).toBeNull();
    expect(encryptCallCount(backend)).toBe(0);
  });

  it('honours an explicit lower ceiling', async () => {
    const backend = makeBackend();
    expect(await sealVaultPayload('x'.repeat(5000), backend, { maxBucket: 4096 })).toBeNull();
    expect(await sealVaultPayload('x'.repeat(100), backend, { maxBucket: 4096 })).not.toBeNull();
  });

  it('refuses to seal to a backend with no usable pubkey', async () => {
    // A disconnected `BunkerSigningBackend` reports `''`. Wrapping to that
    // would throw out of a publish path whose contract is a `false` return,
    // so the seal refuses instead — and never spends the round-trip.
    for (const pubkey of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'z'.repeat(64), 'nostr:npub1x']) {
      const backend = makeBackend({ activePublicKeyHex: pubkey });
      expect(await sealVaultPayload('refuse me', backend)).toBeNull();
      expect(encryptCallCount(backend)).toBe(0);
    }
    const missing = makeBackend({ activePublicKeyHex: undefined });
    expect(await sealVaultPayload('refuse me', missing)).toBeNull();
    expect(encryptCallCount(missing)).toBe(0);
  });
});

describe('openVaultPayload — rejection and fallback', () => {
  it('returns null when a ciphertext byte is flipped', async () => {
    const backend = makeBackend();
    const envelope = parseVaultEnvelope((await sealVaultPayload('tamper me', backend))!)!;
    const bytes = Uint8Array.from(atob(envelope.ct), (c) => c.charCodeAt(0));
    bytes[0] ^= 0x01;
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const tampered = JSON.stringify({ ...envelope, ct: btoa(binary) });
    expect(await openVaultPayload(tampered, backend, AUTHOR)).toBeNull();
  });

  it('returns null when the IV is tampered with', async () => {
    const backend = makeBackend();
    const envelope = parseVaultEnvelope((await sealVaultPayload('tamper the iv', backend))!)!;
    const iv = Uint8Array.from(atob(envelope.iv), (c) => c.charCodeAt(0));
    iv[0] ^= 0x01;
    let binary = '';
    for (const byte of iv) binary += String.fromCharCode(byte);
    expect(await openVaultPayload(JSON.stringify({ ...envelope, iv: btoa(binary) }), backend, AUTHOR)).toBeNull();
    // A shorter-than-legal IV is a decrypt failure, not a throw.
    expect(await openVaultPayload(JSON.stringify({ ...envelope, iv: btoa('short') }), backend, AUTHOR)).toBeNull();
  });

  it('returns null when the wrapped key is swapped for another valid wrap', async () => {
    const backend = makeBackend();
    // Both envelopes are genuine and both wraps open — but the key inside the
    // second one does not authenticate the first one's ciphertext.
    const mine = parseVaultEnvelope((await sealVaultPayload('mine', backend))!)!;
    const theirs = parseVaultEnvelope((await sealVaultPayload('theirs', backend))!)!;
    expect(await openVaultPayload(JSON.stringify({ ...mine, k: theirs.k }), backend, AUTHOR)).toBeNull();
  });

  it('returns null for a wrong-length content key', async () => {
    const sealed = (await sealVaultPayload('anything', makeBackend()))!;
    const liar = makeBackend({ nip44Decrypt: vi.fn(async () => btoa('short')) });
    expect(await openVaultPayload(sealed, liar, AUTHOR)).toBeNull();
  });

  it('returns null, never throws, when the backend hands back rubbish', async () => {
    const sealed = (await sealVaultPayload('anything', makeBackend()))!;
    const notBase64 = makeBackend({ nip44Decrypt: vi.fn(async () => 'not base64 at all!!') });
    expect(await openVaultPayload(sealed, notBase64, AUTHOR)).toBeNull();
    const notAString = makeBackend({ nip44Decrypt: vi.fn(async () => undefined) });
    expect(await openVaultPayload(sealed, notAString, AUTHOR)).toBeNull();
  });

  it('returns null when the LEGACY leg resolves with something that is not a string', async () => {
    // `nip44Decrypt` is a remote NIP-46 call on a Heartwood install: the device
    // can resolve it with any JSON value. An object returned verbatim here
    // would be a non-null "plaintext" that `readSyncPlaintext` caches as one.
    for (const rubbish of [{}, [], 42, null, undefined, true]) {
      const backend = makeBackend({ nip44Decrypt: vi.fn(async () => rubbish) });
      expect(await openVaultPayload(fakeNip44('{"v":1}'), backend, AUTHOR)).toBeNull();
    }
  });

  it('falls back to bare NIP-44 for a legacy (v1) content string', async () => {
    const backend = makeBackend();
    const opened = await openVaultPayload(fakeNip44('{"v":1,"contacts":[]}'), backend, AUTHOR);
    expect(opened!.trim()).toBe('{"v":1,"contacts":[]}');
  });

  it('returns null when the legacy fallback itself fails', async () => {
    const backend = makeBackend();
    // Right shape, wrong key: the backend throws, the open degrades to null.
    const notOurs = makeBackend({ nip44Decrypt: vi.fn(async () => { throw new Error('wrong key'); }) });
    expect(await openVaultPayload(fakeNip44('anything'), notOurs, AUTHOR)).toBeNull();
    expect(await openVaultPayload('not-a-ciphertext', backend, AUTHOR)).toBeNull();
  });

  it('never spends a signer round-trip on something that cannot be a NIP-44 payload', async () => {
    const backend = makeBackend();
    // Too short, wrong alphabet, and wrong version byte: three different ways
    // of not being a v2 ciphertext, none of which may reach the backend. On a
    // Heartwood install each of these would otherwise be a 0.4-2 s NIP-46 call.
    expect(await openVaultPayload('garbage-not-our-format', backend, AUTHOR)).toBeNull();
    expect(await openVaultPayload('x'.repeat(MIN_NIP44_V2_CHARS), backend, AUTHOR)).toBeNull();
    expect(await openVaultPayload(fakeNip44('hi').slice(0, 40), backend, AUTHOR)).toBeNull();
    expect((backend as { nip44Decrypt: { mock: { calls: unknown[] } } }).nip44Decrypt.mock.calls).toHaveLength(0);
  });

  it('skips the legacy fallback entirely when the caller opts out', async () => {
    const backend = makeBackend();
    // The contacts v2 rail never had a v1 format, so it passes
    // `{ legacyFallback: false }` and a non-envelope tag costs nothing.
    expect(await openVaultPayload(fakeNip44('{"v":1}'), backend, AUTHOR, { legacyFallback: false })).toBeNull();
    expect((backend as { nip44Decrypt: { mock: { calls: unknown[] } } }).nip44Decrypt.mock.calls).toHaveLength(0);
    // ...but a genuine v2 envelope still opens.
    const sealed = (await sealVaultPayload('still works', backend))!;
    expect(await openVaultPayload(sealed, backend, AUTHOR, { legacyFallback: false })).toBe('still works');
  });

  it('refuses an oversized content string before parsing OR decrypting it', async () => {
    const backend = makeBackend();
    const huge = 'x'.repeat(MAX_ENVELOPE_CHARS + 1);
    expect(parseVaultEnvelope(huge)).toBeNull();
    expect(looksLikeNip44V2(huge)).toBe(false);
    expect(await openVaultPayload(huge, backend, AUTHOR)).toBeNull();
    // The cap is a PRE-parse, PRE-decrypt gate: the backend is never asked.
    expect((backend as { nip44Decrypt: { mock: { calls: unknown[] } } }).nip44Decrypt.mock.calls).toHaveLength(0);
  });


  it('rejects a malformed or relabelled envelope', async () => {
    const backend = makeBackend();
    const envelope = parseVaultEnvelope((await sealVaultPayload('hi', backend))!)!;
    expect(parseVaultEnvelope(JSON.stringify({ ...envelope, b: 5000 }))).toBeNull();
    expect(parseVaultEnvelope(JSON.stringify({ ...envelope, v: 1 }))).toBeNull();
    expect(parseVaultEnvelope(JSON.stringify({ ...envelope, ct: 42 }))).toBeNull();
    expect(parseVaultEnvelope('[]')).toBeNull();
    // A bucket relabelled to another LADDER value passes the parse but must
    // fail the post-decrypt length check.
    expect(await openVaultPayload(JSON.stringify({ ...envelope, b: 8192 }), backend, AUTHOR)).toBeNull();
  });
});

describe('vault envelope key-material hygiene', () => {
  // The `Uint8Array`s holding the content key and the padded body are wiped in
  // a `finally` on BOTH legs. These two tests hold a reference to the real
  // buffers the implementation used and read them back afterwards, so a
  // regression that drops a `fill(0)` fails here rather than passing silently.
  it('wipes the content key and the padded body after a seal', async () => {
    const backend = makeBackend();
    const randoms: Uint8Array[] = [];
    const encrypted: Uint8Array[] = [];
    const realRandom = crypto.getRandomValues.bind(crypto);
    const realEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    const randomSpy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(((array: Uint8Array<ArrayBuffer>) => {
      const out = realRandom(array) as Uint8Array;
      randoms.push(out);
      return out;
    }) as never);
    const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation((async (
      algorithm: AlgorithmIdentifier,
      key: CryptoKey,
      data: Uint8Array,
    ) => {
      encrypted.push(data);
      return realEncrypt(algorithm as never, key, data as never);
    }) as never);
    try {
      expect(await sealVaultPayload('wipe me', backend)).not.toBeNull();
    } finally {
      randomSpy.mockRestore();
      encryptSpy.mockRestore();
    }
    const rawKey = randoms.find((r) => r.length === 32)!;
    expect(rawKey).toBeDefined();
    expect(rawKey.every((b) => b === 0)).toBe(true);
    expect(encrypted[0].length).toBe(4096);
    expect(encrypted[0].every((b) => b === 0)).toBe(true);
  });

  it('wipes the unwrapped content key and the decrypted body after an open', async () => {
    const backend = makeBackend();
    const sealed = (await sealVaultPayload('wipe me too', backend))!;
    const decrypted: ArrayBuffer[] = [];
    const from32: Uint8Array[] = [];
    const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const realFrom = Uint8Array.from.bind(Uint8Array) as typeof Uint8Array.from;
    const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementation((async (
      algorithm: AlgorithmIdentifier,
      key: CryptoKey,
      data: BufferSource,
    ) => {
      const out = await realDecrypt(algorithm as never, key, data as never);
      decrypted.push(out);
      return out;
    }) as never);
    const fromSpy = vi.spyOn(Uint8Array, 'from').mockImplementation(((...args: unknown[]) => {
      const out = (realFrom as (...a: unknown[]) => Uint8Array)(...args);
      if (out.length === 32) from32.push(out);
      return out;
    }) as never);
    try {
      expect(await openVaultPayload(sealed, backend, AUTHOR)).toBe('wipe me too');
    } finally {
      decryptSpy.mockRestore();
      fromSpy.mockRestore();
    }
    // from32[0] is the content key as unwrapped from the NIP-44 leg; from32[1]
    // is the private copy `importAesKeyRaw` makes for SubtleCrypto. Both are
    // wiped — the second one by the helper's own `finally`, which is the last
    // live 256-bit buffer of an open if it is ever dropped.
    expect(from32[0]).toBeDefined();
    expect(from32[0].every((b) => b === 0)).toBe(true);
    expect(from32[1]).toBeDefined();
    expect(from32[1].every((b) => b === 0)).toBe(true);
    // The AES plaintext, i.e. the whole padded body, is wiped too.
    expect(decrypted[0].byteLength).toBe(4096);
    expect(new Uint8Array(decrypted[0]).every((b) => b === 0)).toBe(true);
  });
});

describe('looksLikeNip44V2', () => {
  it('accepts a v2-shaped ciphertext and rejects everything else', () => {
    expect(looksLikeNip44V2(fakeNip44('{"v":1}'))).toBe(true);
    expect(MIN_NIP44_V2_CHARS).toBe(132);
    // Shorter than any real v2 payload.
    expect(looksLikeNip44V2('A'.repeat(MIN_NIP44_V2_CHARS - 4))).toBe(false);
    // Not base64 at all.
    expect(looksLikeNip44V2('-'.repeat(MIN_NIP44_V2_CHARS))).toBe(false);
    // Base64, right length, wrong version byte ('x' quads decode to 0xc7...).
    expect(looksLikeNip44V2('x'.repeat(MIN_NIP44_V2_CHARS))).toBe(false);
    // A v2 envelope is JSON, not base64 — it must not be mistaken for one.
    expect(looksLikeNip44V2(JSON.stringify({ v: 2, k: 'a', iv: 'b', ct: 'c', b: 4096 }))).toBe(false);
  });
});

describe('openVaultPayloadOrThrow', () => {
  it('returns the plaintext on success and throws on failure', async () => {
    const backend = makeBackend();
    const sealed = (await sealVaultPayload('ok', backend))!;
    await expect(openVaultPayloadOrThrow(sealed, backend, AUTHOR)).resolves.toBe('ok');
    await expect(openVaultPayloadOrThrow('rubbish', backend, AUTHOR)).rejects.toThrow(/could not be opened/);
  });
});

describe('sealVaultPayload — recipientPubkey (R-4)', () => {
  const RAIL_SK = 'b'.repeat(63) + '1';
  const APP_SK = 'c'.repeat(63) + '1';

  it('defaults to self, exactly as before', async () => {
    const rail = new LocalSigningBackend(RAIL_SK);
    const sealed = await sealVaultPayload('{"hello":"world"}', rail);
    expect(sealed).not.toBeNull();
    expect(await openVaultPayload(sealed!, rail, rail.activePublicKeyHex, { legacyFallback: false }))
      .toBe('{"hello":"world"}');
  });

  it('wraps the content key to another pubkey when asked', async () => {
    const rail = new LocalSigningBackend(RAIL_SK);
    const app = new LocalSigningBackend(APP_SK);
    const sealed = await sealVaultPayload('{"for":"the app"}', rail, {
      recipientPubkey: app.activePublicKeyHex,
    });
    expect(sealed).not.toBeNull();
    // The app opens it against the rail's pubkey — NIP-44 is symmetric.
    expect(await openVaultPayload(sealed!, app, rail.activePublicKeyHex, { legacyFallback: false }))
      .toBe('{"for":"the app"}');
    // And the rail can no longer open its own envelope to self.
    expect(await openVaultPayload(sealed!, rail, rail.activePublicKeyHex, { legacyFallback: false }))
      .toBeNull();
  });

  it('still pads into the declared bucket', async () => {
    const rail = new LocalSigningBackend(RAIL_SK);
    const app = new LocalSigningBackend(APP_SK);
    const sealed = await sealVaultPayload('{"tiny":1}', rail, { recipientPubkey: app.activePublicKeyHex });
    const envelope = JSON.parse(sealed!) as { b: number };
    expect(BUCKETS).toContain(envelope.b);
    expect(envelope.b).toBe(4096);
  });

  it('returns null for a recipient that is not lowercase 64-hex', async () => {
    const rail = new LocalSigningBackend(RAIL_SK);
    for (const bad of ['', 'nope', 'A'.repeat(64), 'a'.repeat(63)]) {
      expect(await sealVaultPayload('{}', rail, { recipientPubkey: bad })).toBeNull();
    }
  });

  // Opus review, fix round 1: the seal body used to be a bare try/finally
  // with no catch, so a recipient that passes the shape check but makes
  // something downstream throw would escape `sealVaultPayload`'s null
  // contract instead of failing closed. The self-wrap default could never
  // hit this (a connected backend's own `activePublicKeyHex` is always a
  // real point), which is exactly why the recipient path needed its own
  // coverage.
  it('fails closed (null) when the backend rejects the wrap, not just when the shape is wrong', async () => {
    const rail = new LocalSigningBackend(RAIL_SK);
    const rejecting = makeBackend({
      activePublicKeyHex: rail.activePublicKeyHex,
      nip44Encrypt: vi.fn(async () => { throw new Error('bunker refused the request'); }),
    });
    expect(await sealVaultPayload('{"hello":"world"}', rejecting, {
      recipientPubkey: 'c'.repeat(64),
    })).toBeNull();
  });

  it('fails closed (null) for a syntactically valid 64-hex recipient that is not a real curve point', async () => {
    // 'f'.repeat(64) is 2^256 - 1, outside the secp256k1 field order — passes
    // the LOWERCASE_HEX_64 shape check but is not a valid public key, so the
    // real backend's underlying ECDH throws rather than the mock above.
    const rail = new LocalSigningBackend(RAIL_SK);
    expect(await sealVaultPayload('{"hello":"world"}', rail, {
      recipientPubkey: 'f'.repeat(64),
    })).toBeNull();
  });

  it('fails closed (null) when the injected random hands back the wrong number of bytes', async () => {
    const rail = new LocalSigningBackend(RAIL_SK);
    const shortKey = async () => sealVaultPayload('{}', rail, { random: () => new Uint8Array(16) });
    expect(await shortKey()).toBeNull();

    // A generator that gets the 32-byte content key right but the IV wrong
    // must also fail closed, not silently encrypt with a mis-sized IV.
    let call = 0;
    const badIv = () => sealVaultPayload('{}', rail, {
      random: () => { call += 1; return call === 1 ? new Uint8Array(32) : new Uint8Array(4); },
    });
    expect(await badIv()).toBeNull();
  });
});
