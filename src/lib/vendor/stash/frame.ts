/*! @license
 * Vendored Stash FSWNENC2 codec at 0d9f5e1917a4d4d9dd3bfa661f4bf9f97823e102; upstream source SHA-256 ebcc0fc2eba6cf53538c5731f15f49bf726b69e7d1d5abf597539aa68b3899cb.
 * MIT License
 * 
 * Copyright (c) 2026 ForgeSworn (TheCryptoDonkey, decented)
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * The Stash **v3** frame — the ForgeSworn `aes-256-gcm-chunked` envelope, byte for byte,
 * under a key Stash supplies.
 *
 * v2 sealed a whole item in one XChaCha20-Poly1305 pass: the size leaked exactly, a
 * truncation showed up only as total failure, and the item had to fit in memory twice. v3 is
 * the construction Wildbloom and Stash publish vectors for together — a clear header, 1 MiB
 * AES-256-GCM records, each record's position bound into its AAD — so truncation and
 * reordering are caught per record, padding hides the exact size, and the name and type move
 * inside the ciphertext.
 *
 *   header  = "FSWNENC2" | u32 BE chunk size (1 MiB) | u32 BE record count | 8-byte nonce prefix | 32-byte salt
 *   key     = HKDF-SHA256(ikm = input key, salt = header salt, info = HKDF_INFO, L = 32)
 *   record  = AES-256-GCM( nonce = prefix ‖ u32 BE counter, aad = header ‖ u32 BE counter )
 *   logical = u32 BE metadata length | {"name","size","type"} | bytes | padding
 *   frame   = header | record 0 | record 1 | …
 *
 * Padding buckets: 64 KiB floor, the next power of two up to 1 MiB, then 1 MiB steps.
 *
 * ## FSWNENC2 — the per-envelope key, 2026-08-29
 *
 * `FSWNENC1` is nonce-safe **only under a fresh key per envelope**. Its nonce is an 8-byte
 * random prefix and a counter from zero, so two envelopes sealed under one reused key
 * collide on `(key, nonce)` after a birthday-bounded number of envelopes — about 2³² for a
 * meaningful probability. Wildbloom mints a key per file and never comes near it; **Stash
 * reuses the per-(persona, app) vault key for every item it ever seals**, which is exactly
 * the shape the bound was drawn against, and an AES-GCM nonce collision is not a graceful
 * failure — it leaks the XOR of two plaintexts and the authentication key with it.
 *
 * `FSWNENC2` closes it in the format rather than in the caller. The header carries 32 fresh
 * random bytes, and the AES key is `HKDF-SHA256(ikm = the supplied key, salt = those 32
 * bytes, info = {@link HKDF_INFO}, L = 32)`. A fresh salt gives a fresh key, so the
 * counter-from-zero nonce is safe no matter how the input key is managed. Per-file and vault
 * sealing are byte-identical in every respect except the input key, and that difference never
 * reaches the wire: **there is no mode flag in the envelope.**
 *
 * The shared specification is `docs/FSWNENC2.md` in `forgesworn/wildbloom`
 * (`forgesworn/wildbloom#19`); the scheme name is {@link SCHEME}.
 *
 * |            | `FSWNENC1`                      | `FSWNENC2`                            |
 * |------------|---------------------------------|---------------------------------------|
 * | magic      | `FSWNENC1`                      | `FSWNENC2`                            |
 * | header     | 24 bytes                        | 56 bytes (salt at offset 24)          |
 * | AAD        | 28 bytes                        | 60 bytes                              |
 * | AES key    | the supplied key, used directly | HKDF-SHA256 of it under the header salt |
 *
 * The MIME is unchanged: {@link MEDIA_TYPE} stays `application/vnd.forgesworn.encrypted`,
 * because the media type names the envelope family and the magic is the version field.
 *
 * The coordinated writer flip was merged and Git-tagged in 0.5.0 after both
 * owners signed joint core contract **0.3**. Older frames remain readable;
 * new frames use `FSWNENC2`.
 *
 * ## The magic and the MIME — renamed, 2026-08-28
 *
 * **Owner decision, 2026-08-28: the envelope's names went product-neutral**, per the frozen
 * joint core contract §9 and BOTHY §10 Q21: magic `WBLMENC1` → `FSWNENC1`, MIME
 * `application/vnd.wildbloom.encrypted` → `application/vnd.forgesworn.encrypted`. The gate
 * was **TheCryptoDonkey's direct word, not an engineering agreement**, and it cleared that
 * day.
 *
 * ## Reading is never broken
 *
 * {@link isV3} and {@link open} take **all three magics**, dispatching on the magic alone:
 * `FSWNENC2` reads a 56-byte header and derives its key; `FSWNENC1` and {@link LEGACY_MAGIC}
 * read a 24-byte header and use the supplied key directly. The header a frame carries is what
 * goes into its AAD, so a frame sealed before either flip verifies exactly as it always did
 * and nothing in an existing vault has to be rewritten. Writing is current-version only:
 * {@link sealWithMagic} is the sole way to mint a legacy frame, and it exists for the vectors
 * alone.
 *
 * Byte-identical to `stash-rs` `src/frame.rs`, held there by the same six known-answer
 * vectors.
 */

import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * The envelope magic: `FSWNENC2` since the per-envelope key derivation. Written on every
 * frame this package seals, and authenticated in every record's AAD — so this constant is
 * the format, and it is the version field.
 */
export const MAGIC = new Uint8Array([0x46, 0x53, 0x57, 0x4e, 0x45, 0x4e, 0x43, 0x32]); // "FSWNENC2"
/**
 * The media type a v3 frame is served as, when a server declares one at all. Unchanged
 * across `FSWNENC1` → `FSWNENC2`: the media type names the envelope family, the magic names
 * the version.
 */
export const MEDIA_TYPE = 'application/vnd.forgesworn.encrypted';
/**
 * The first product-neutral magic, from the 2026-08-28 rename. **Accepted on read and never
 * written**: a `FSWNENC1` frame has a 24-byte header and uses the supplied key directly.
 */
export const MAGIC_V1 = new Uint8Array([0x46, 0x53, 0x57, 0x4e, 0x45, 0x4e, 0x43, 0x31]); // "FSWNENC1"
/**
 * The Wildbloom-branded magic this envelope carried before the 2026-08-28 rename.
 * **Accepted on read and never written**, so frames sealed before the flip — and Wildbloom's
 * two original known-answer vectors — stay readable. The header is authenticated as it is
 * found, so a legacy frame verifies unchanged.
 */
export const LEGACY_MAGIC = new Uint8Array([0x57, 0x42, 0x4c, 0x4d, 0x45, 0x4e, 0x43, 0x31]); // "WBLMENC1"
/**
 * Every magic {@link open} accepts besides {@link MAGIC}, each of them a 24-byte-header,
 * key-used-directly frame. Read-only, in both senses.
 */
export const LEGACY_MAGICS: readonly Uint8Array[] = [MAGIC_V1, LEGACY_MAGIC];
/**
 * The media type paired with {@link LEGACY_MAGIC}. Recognised if a server declares it;
 * never sent.
 */
export const LEGACY_MEDIA_TYPE = 'application/vnd.wildbloom.encrypted';

/** The scheme name the shared specification gives this construction. */
export const SCHEME = 'forgesworn-aes-256-gcm-chunked-v2';
/**
 * The HKDF `info` label, exactly 33 UTF-8 bytes and no NUL. Part of the format: change a
 * byte of it and every envelope this package writes becomes unreadable to Wildbloom.
 */
export const HKDF_INFO = new TextEncoder().encode('forgesworn-aes-256-gcm-chunked/v2');

/**
 * The clear header of a {@link MAGIC} frame, in bytes: magic 8, chunk size 4, record count 4,
 * nonce prefix 8, salt 32.
 */
export const HEADER_BYTES = 56;
/** The clear header of a {@link LEGACY_MAGICS} frame, in bytes — the same, without the salt. */
export const HEADER_BYTES_V1 = 24;
/** The key-derivation salt, in bytes. Offset 24 of the header, public, never secret. */
export const SALT_BYTES = 32;
/** One authenticated record's plaintext, in bytes. */
export const CHUNK_BYTES = 1024 * 1024;
/** A GCM tag, in bytes. */
export const TAG_BYTES = 16;
/** The smallest padding bucket. Anything shorter is padded up to it. */
export const MIN_PADDING_BUCKET = 64 * 1024;
/** Stash's record limit. Wildbloom additionally caps source files at 256 MiB. */
export const MAX_RECORDS = 258;
/** The ceiling on the encoded metadata JSON. */
export const MAX_METADATA_BYTES = 4096;
const KEY_LEN = 32;

/**
 * The private metadata carried inside the first record: never on a relay, never on a
 * server, never in a URL.
 */
export interface FrameMetadata {
  /** The item's name. */
  name: string;
  /** The exact plaintext byte count, before padding. */
  size: number;
  /** The item's media type, lowercased. */
  type: string;
}

/**
 * How a record's padding is filled. Production is always `'random'`; `'known-answer'`
 * exists so the published vectors can be reproduced and is **test material only**.
 */
export type Padding = 'random' | 'known-answer';

/** C0 controls and DEL — the characters neither a name nor a media type may contain. */
function isControl(codePoint: number): boolean {
  return codePoint < 0x20 || codePoint === 0x7f;
}

function stripControls(value: string): string {
  let out = '';
  for (const ch of value) {
    if (!isControl(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out;
}

function hasControls(value: string): boolean {
  for (const ch of value) {
    if (isControl(ch.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/**
 * The padding bucket for a logical plaintext of `length` bytes: 64 KiB floor, the next
 * power of two up to 1 MiB, then the next 1 MiB boundary. Unchanged from `FSWNENC1`.
 */
export function paddedLength(length: number): number {
  if (length <= MIN_PADDING_BUCKET) return MIN_PADDING_BUCKET;
  if (length <= CHUNK_BYTES) return 2 ** Math.ceil(Math.log2(length));
  return Math.ceil(length / CHUNK_BYTES) * CHUNK_BYTES;
}

/**
 * Wildbloom's filename rule, so a name this seals is a name its decoder accepts.
 *
 * Unicode normalisation is the one place the two implementations differ: `String.normalize`
 * is free here so NFC is applied, and `stash-rs` has no normaliser to hand so it does not.
 * A name that differs only in normalisation therefore seals to different bytes in the two.
 * Recorded rather than hidden; Stash names come from an app's own manifest, not from a
 * filesystem, and are ASCII in every current caller.
 */
export function sanitiseName(value: string): string {
  const leaf = value.split(/[\\/]/u).at(-1) ?? '';
  const cleaned = stripControls(leaf.normalize('NFC'))
    .replace(/[<>:"|?*]/gu, '_')
    .replace(/^\.+/u, '')
    .trim();
  const fallback = cleaned || 'blob.bin';
  if (fallback.length <= 180) return fallback;
  // Keep Unicode scalar values intact at the UTF-16 length boundary.
  const last = fallback.charCodeAt(179);
  const next = fallback.charCodeAt(180);
  const end = last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 179 : 180;
  return fallback.slice(0, end);
}

/** Wildbloom's MIME rule: lowercased, defaulted, no control characters, at most 255 bytes. */
export function normaliseMediaType(value: string): string {
  const type = (value || 'application/octet-stream').toLowerCase();
  if (type.length > 255 || hasControls(type)) {
    throw new Error(`stash: invalid frame media type ${JSON.stringify(value)}`);
  }
  return type;
}

/**
 * Canonical metadata JSON: `{"name":…,"size":…,"type":…}`, in that key order. The order is
 * load-bearing — it is what the reader re-encodes and compares against — so do not tidy it.
 */
function canonicalMetadata(meta: FrameMetadata): Uint8Array {
  const json = JSON.stringify({ name: meta.name, size: meta.size, type: meta.type });
  const bytes = new TextEncoder().encode(json);
  if (bytes.length > MAX_METADATA_BYTES) {
    throw new Error(`stash: frame metadata is ${bytes.length} bytes, over the ${MAX_METADATA_BYTES}-byte ceiling`);
  }
  return bytes;
}

/** The `FSWNENC2` clear header: {@link MAGIC}, chunk size, record count, nonce prefix, salt. */
function headerBytes(recordCount: number, noncePrefix: Uint8Array, salt: Uint8Array): Uint8Array {
  const h = new Uint8Array(HEADER_BYTES);
  h.set(MAGIC, 0);
  const view = new DataView(h.buffer);
  view.setUint32(8, CHUNK_BYTES, false);
  view.setUint32(12, recordCount, false);
  h.set(noncePrefix, 16);
  h.set(salt, 24);
  return h;
}

/**
 * The 24-byte header of a {@link LEGACY_MAGICS} frame. Only {@link sealWithMagic} builds one;
 * every frame this package seals for real carries {@link MAGIC} and a salt.
 */
function headerBytesV1(magic: Uint8Array, recordCount: number, noncePrefix: Uint8Array): Uint8Array {
  const h = new Uint8Array(HEADER_BYTES_V1);
  h.set(magic, 0);
  const view = new DataView(h.buffer);
  view.setUint32(8, CHUNK_BYTES, false);
  view.setUint32(12, recordCount, false);
  h.set(noncePrefix, 16);
  return h;
}

/**
 * The header length a magic implies, or `null` if this is not a v3 frame at all. The magic
 * is the only thing that selects it — the header carries no length of its own.
 */
function headerLength(frame: Uint8Array): number | null {
  if (frame.length < 8) return null;
  if (startsWith(frame, MAGIC)) return HEADER_BYTES;
  for (const magic of LEGACY_MAGICS) if (startsWith(frame, magic)) return HEADER_BYTES_V1;
  return null;
}

/**
 * `envelope_key = HKDF-SHA256(ikm = inputKey, salt = the header salt, info = HKDF_INFO,
 * L = 32)`. The whole of `FSWNENC2`'s nonce safety rests on the salt being fresh.
 *
 * `@noble/hashes` rather than `crypto.subtle.deriveBits`: this is one HMAC over 32 bytes, so
 * the reason the record cipher reaches for the platform — a JavaScript AES being two orders
 * of magnitude slower — does not apply, and a synchronous derivation keeps the one code path
 * that both the Web Crypto and the `@noble/ciphers` record paths share.
 */
export function deriveEnvelopeKey(inputKey: Uint8Array, salt: Uint8Array): Uint8Array {
  return hkdf(sha256, inputKey, salt, HKDF_INFO, KEY_LEN);
}

function nonceBytes(prefix: Uint8Array, counter: number): Uint8Array {
  const n = new Uint8Array(12);
  n.set(prefix, 0);
  new DataView(n.buffer).setUint32(8, counter, false);
  return n;
}

/** `header ‖ u32 BE counter` — 60 bytes for `FSWNENC2`, 28 for a legacy frame. */
function aadBytes(header: Uint8Array, counter: number): Uint8Array {
  const a = new Uint8Array(header.length + 4);
  a.set(header, 0);
  new DataView(a.buffer).setUint32(header.length, counter, false);
  return a;
}

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_LEN) throw new Error(`stash: vault key must be ${KEY_LEN} bytes`);
}

/**
 * AES-256-GCM, preferring the platform's own implementation.
 *
 * `crypto.subtle` is native and roughly two orders of magnitude faster than a JavaScript
 * cipher — measured here at about 0.7 s per MiB for a `@noble/ciphers` round trip, which
 * would make a multi-megabyte save from Record unusable on a phone. It is also exactly
 * what Wildbloom uses, so the two implementations run the same primitive.
 *
 * `@noble/ciphers` stays as the fallback for the one place `crypto.subtle` is missing: a
 * browser page served over plain HTTP on a non-localhost origin, where Web Crypto is not
 * exposed. The vectors are asserted against whichever path a given environment takes, so
 * neither can drift.
 */
async function encryptRecord(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return gcm(key, nonce, aad).encrypt(plaintext);
  const imported = await subtle.importKey('raw', toBuffer(key), 'AES-GCM', false, ['encrypt']);
  const out = await subtle.encrypt(
    { name: 'AES-GCM', iv: toBuffer(nonce), additionalData: toBuffer(aad), tagLength: 128 },
    imported,
    toBuffer(plaintext),
  );
  return new Uint8Array(out);
}

async function decryptRecord(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return gcm(key, nonce, aad).decrypt(ciphertext);
  const imported = await subtle.importKey('raw', toBuffer(key), 'AES-GCM', false, ['decrypt']);
  const out = await subtle.decrypt(
    { name: 'AES-GCM', iv: toBuffer(nonce), additionalData: toBuffer(aad), tagLength: 128 },
    imported,
    toBuffer(ciphertext),
  );
  return new Uint8Array(out);
}

/** Web Crypto wants an `ArrayBuffer`; a `Uint8Array` may be a view into a larger one. */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * The most `crypto.getRandomValues` will fill in one call. A 1 MiB record needs sixteen
 * calls, and asking for it in one throws `QuotaExceededError` — which would have broken
 * every item over 64 KiB in a browser. Wildbloom chunks at the same boundary.
 */
const RANDOM_FILL_LIMIT = 65_536;

/** Fill `record` — which starts at `offset` in the logical plaintext — with padding. */
function fillPadding(record: Uint8Array, offset: number, padding: Padding): void {
  if (padding === 'random') {
    for (let at = 0; at < record.length; at += RANDOM_FILL_LIMIT) {
      const span = Math.min(RANDOM_FILL_LIMIT, record.length - at);
      record.set(randomBytes(span), at);
    }
    return;
  }
  for (let i = 0; i < record.length; i++) record[i] = ((offset + i) * 73 + 41) % 256;
}

/**
 * Copy whatever part of `src` — which begins at `srcStart` in the logical plaintext —
 * falls inside the record beginning at `recordOffset`.
 */
function overlay(record: Uint8Array, recordOffset: number, srcStart: number, src: Uint8Array): void {
  const recordEnd = recordOffset + record.length;
  const srcEnd = srcStart + src.length;
  const from = Math.max(srcStart, recordOffset);
  const to = Math.min(srcEnd, recordEnd);
  if (to <= from) return;
  record.set(src.subarray(from - srcStart, to - srcStart), from - recordOffset);
}

/**
 * The shape of the logical plaintext, settled before the header can be written because the
 * record count goes inside it.
 */
interface Layout {
  /** `u32 BE metadata length ‖ canonical metadata JSON`. */
  prefix: Uint8Array;
  /** The padded logical plaintext length. */
  plaintextLength: number;
  recordCount: number;
}

function layoutOf(name: string, mediaType: string, itemLength: number): Layout {
  const meta: FrameMetadata = {
    name: sanitiseName(name),
    size: itemLength,
    type: normaliseMediaType(mediaType),
  };
  const json = canonicalMetadata(meta);

  const prefix = new Uint8Array(4 + json.length);
  new DataView(prefix.buffer).setUint32(0, json.length, false);
  prefix.set(json, 4);

  const plaintextLength = paddedLength(prefix.length + itemLength);
  const recordCount = Math.ceil(plaintextLength / CHUNK_BYTES);
  if (recordCount < 1 || recordCount > MAX_RECORDS) {
    throw new Error(`stash: a v3 frame holds at most ${MAX_RECORDS} records; this item needs ${recordCount}`);
  }
  return { prefix, plaintextLength, recordCount };
}

/**
 * The records, under whatever AES key and whatever header the caller has already settled.
 * Everything version-specific happens before this point.
 */
async function emit(
  aesKey: Uint8Array,
  header: Uint8Array,
  layout: Layout,
  bytes: Uint8Array,
  noncePrefix: Uint8Array,
  padding: Padding,
): Promise<Uint8Array> {
  const frame = new Uint8Array(header.length + layout.plaintextLength + layout.recordCount * TAG_BYTES);
  frame.set(header, 0);
  let at = header.length;

  for (let counter = 0; counter < layout.recordCount; counter++) {
    const offset = counter * CHUNK_BYTES;
    const length = Math.min(CHUNK_BYTES, layout.plaintextLength - offset);
    const record = new Uint8Array(length);
    try {
      fillPadding(record, offset, padding);
      overlay(record, offset, 0, layout.prefix);
      overlay(record, offset, layout.prefix.length, bytes);
      const ct = await encryptRecord(aesKey, nonceBytes(noncePrefix, counter), aadBytes(header, counter), record);
      frame.set(ct, at);
      at += ct.length;
    } finally {
      // The record held item bytes; do not leave them lying about.
      record.fill(0);
    }
  }
  return frame;
}

/**
 * Seal `bytes` into a `FSWNENC2` frame under the 32-byte vault `key`.
 *
 * `noncePrefix`, `padding` and `salt` are for the known-answer vectors; **production callers
 * pass none of them**, and each then comes from the CSPRNG. The salt in particular: a fixed
 * salt under a reused key is precisely the nonce-reuse hazard `FSWNENC2` exists to remove.
 */
export async function seal(
  key: Uint8Array,
  name: string,
  mediaType: string,
  bytes: Uint8Array,
  noncePrefix?: Uint8Array,
  padding: Padding = 'random',
  salt?: Uint8Array,
): Promise<Uint8Array> {
  assertKey(key);
  const prefixNonce = noncePrefix ?? randomBytes(8);
  if (prefixNonce.length !== 8) throw new Error('stash: frame nonce prefix must be 8 bytes');
  const headerSalt = salt ?? randomBytes(SALT_BYTES);
  if (headerSalt.length !== SALT_BYTES) throw new Error(`stash: frame salt must be ${SALT_BYTES} bytes`);

  const layout = layoutOf(name, mediaType, bytes.length);
  const header = headerBytes(layout.recordCount, prefixNonce, headerSalt);
  return emit(deriveEnvelopeKey(key, headerSalt), header, layout, bytes, prefixNonce, padding);
}

/**
 * Seal a **legacy** 24-byte-header frame under `magic`, with the key used directly and no
 * derivation. **Test material only**, and not re-exported from the package index: nothing
 * outside the known-answer vectors may write a frame under a {@link LEGACY_MAGICS} entry, and
 * everything Stash actually stores goes through {@link seal}.
 */
export async function sealWithMagic(
  magic: Uint8Array,
  key: Uint8Array,
  name: string,
  mediaType: string,
  bytes: Uint8Array,
  noncePrefix?: Uint8Array,
  padding: Padding = 'random',
): Promise<Uint8Array> {
  assertKey(key);
  if (magic.length !== 8) throw new Error('stash: frame magic must be 8 bytes');
  const prefixNonce = noncePrefix ?? randomBytes(8);
  if (prefixNonce.length !== 8) throw new Error('stash: frame nonce prefix must be 8 bytes');

  const layout = layoutOf(name, mediaType, bytes.length);
  const header = headerBytesV1(magic, layout.recordCount, prefixNonce);
  return emit(key, header, layout, bytes, prefixNonce, padding);
}

/**
 * Is this a v3 frame? A header check, which is all BOTHY §3.8 rule 2 needs.
 *
 * All three magics answer yes: {@link MAGIC}, and both {@link LEGACY_MAGICS} for frames
 * written before the version flips. The magic is what says how long the header is.
 */
export function isV3(frame: Uint8Array): boolean {
  const length = headerLength(frame);
  return length !== null && frame.length >= length;
}

function startsWith(frame: Uint8Array, magic: Uint8Array): boolean {
  for (let i = 0; i < magic.length; i++) if (frame[i] !== magic[i]) return false;
  return true;
}

/** The four-byte length, the canonical JSON, and the checks that keep it canonical. */
function parseMetadata(plaintext: Uint8Array): { meta: FrameMetadata; prefixLength: number } {
  if (plaintext.length < 4) throw new Error('stash: v3 metadata record is truncated');
  const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  const length = view.getUint32(0, false);
  if (length < 2 || length > MAX_METADATA_BYTES || 4 + length > plaintext.length) {
    throw new Error('stash: v3 metadata length is invalid');
  }
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext.subarray(4, 4 + length));
    value = JSON.parse(text);
  } catch {
    throw new Error('stash: v3 metadata is invalid');
  }
  if (!value || typeof value !== 'object') throw new Error('stash: v3 metadata is invalid');
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== 'string' || typeof candidate.size !== 'number' || typeof candidate.type !== 'string') {
    throw new Error('stash: v3 metadata types are invalid');
  }
  if (Object.keys(candidate).sort().join(',') !== 'name,size,type') {
    throw new Error('stash: v3 metadata shape is invalid');
  }
  const meta: FrameMetadata = { name: candidate.name, size: candidate.size, type: candidate.type };
  // Re-encode and compare: a frame whose metadata is not byte-identical to its canonical
  // form is not one we wrote, and accepting it would make the format's shape unenforceable.
  if (text !== new TextDecoder().decode(canonicalMetadata(meta))) {
    throw new Error('stash: v3 metadata is not canonical');
  }
  if (sanitiseName(meta.name) !== meta.name) throw new Error('stash: v3 metadata name is invalid');
  if (normaliseMediaType(meta.type) !== meta.type) {
    throw new Error('stash: v3 metadata media type is invalid');
  }
  return { meta, prefixLength: 4 + length };
}

/**
 * Open a v3 frame with the 32-byte vault `key`, returning its private metadata and the
 * item bytes. Every record is authenticated; a wrong key, a reordered or truncated record,
 * an altered header or a padding bucket that does not match the declared size is an error,
 * not a partial read.
 *
 * The magic selects both the header length and the key path: a {@link MAGIC} frame derives
 * its AES key from the header salt, a {@link LEGACY_MAGICS} frame uses `key` directly.
 */
export async function open(key: Uint8Array, frame: Uint8Array): Promise<{ meta: FrameMetadata; bytes: Uint8Array }> {
  assertKey(key);
  // The magic is the version field, and it is authenticated exactly as it is found — so a
  // frame sealed before either flip verifies unchanged.
  const headerSize = headerLength(frame);
  if (headerSize === null) throw new Error('stash: bad frame magic (not a Stash v3 frame)');
  if (frame.length < headerSize) throw new Error('stash: v3 frame is truncated');

  const header = frame.slice(0, headerSize);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const chunkSize = view.getUint32(8, false);
  const recordCount = view.getUint32(12, false);
  if (chunkSize !== CHUNK_BYTES || recordCount < 1 || recordCount > MAX_RECORDS) {
    throw new Error('stash: v3 frame header is invalid');
  }
  const noncePrefix = header.slice(16, 24);
  const aesKey = headerSize === HEADER_BYTES ? deriveEnvelopeKey(key, header.slice(24, 56)) : key;

  const minimum = headerSize + (recordCount - 1) * (chunkSize + TAG_BYTES) + 1 + TAG_BYTES;
  const maximum = headerSize + recordCount * (chunkSize + TAG_BYTES);
  if (frame.length < minimum || frame.length > maximum) {
    throw new Error('stash: v3 frame length is invalid');
  }
  const plaintextLength = frame.length - headerSize - recordCount * TAG_BYTES;

  let meta: FrameMetadata | null = null;
  let prefixLength = 0;
  const parts: Uint8Array[] = [];
  let copied = 0;

  for (let counter = 0; counter < recordCount; counter++) {
    const start = headerSize + counter * (chunkSize + TAG_BYTES);
    const end = counter === recordCount - 1 ? frame.length : start + chunkSize + TAG_BYTES;
    let plaintext: Uint8Array;
    try {
      plaintext = await decryptRecord(
        aesKey,
        nonceBytes(noncePrefix, counter),
        aadBytes(header, counter),
        frame.subarray(start, end),
      );
    } catch {
      throw new Error('stash: v3 open failed (wrong key, or the frame was modified)');
    }
    if (!meta) {
      const parsed = parseMetadata(plaintext);
      // The padding bucket is part of the authenticated shape: a frame whose length does
      // not match the bucket its declared size demands was written by something that does
      // not follow the format.
      if (paddedLength(parsed.prefixLength + parsed.meta.size) !== plaintextLength) {
        throw new Error('stash: v3 frame padding is invalid');
      }
      meta = parsed.meta;
      prefixLength = parsed.prefixLength;
    }
    const recordStart = counter * chunkSize;
    const from = Math.max(prefixLength, recordStart);
    const to = Math.min(prefixLength + meta.size, recordStart + plaintext.length);
    if (to > from) {
      const part = plaintext.slice(from - recordStart, to - recordStart);
      copied += part.length;
      parts.push(part);
    }
  }
  if (!meta || copied !== meta.size) {
    throw new Error('stash: v3 frame did not contain the item it declares');
  }

  const bytes = new Uint8Array(copied);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
    part.fill(0);
  }
  return { meta, bytes };
}
