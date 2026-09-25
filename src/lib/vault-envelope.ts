/**
 * Vault envelope v2 — the size-unblocked payload format for every private
 * state rail (internal design exploration §7, 2026-09-15 review note).
 *
 * WHY. `nostr-tools`' NIP-44 v2 implementation rejects plaintext over 65535
 * bytes, so a single NIP-44-to-self payload cannot carry more than 64 KiB and
 * the originally-planned 256 KiB padding bucket cannot be produced at all.
 * The v2 envelope takes the bulk off the NIP-44 path entirely: the body is
 * AES-256-GCM under a fresh random 32-byte content key, and the NIP-44-to-self
 * wrap carries only that key. The signer — an ESP32 over NIP-46 — therefore
 * only ever wraps 32 bytes, whatever the payload size, which is also why most
 * of the §11.1.10 decrypt cache's reason for existing fades over time.
 *
 * WIRE. The event `content` is the JSON string `{ v: 2, k, iv, ct, b }`: `k`
 * is the NIP-44 ciphertext of the base64 content key — wrapped to the
 * sealer's own pubkey by default, or to `opts.recipientPubkey` when one is
 * given (R-4) — `iv` the base64 AES-GCM IV, `ct` the base64 AES ciphertext,
 * `b` the bucket the plaintext was padded to (redundant with the length
 * prefix, kept as a cheap sanity check).
 *
 * PADDING. The AES plaintext is a 4-byte big-endian length prefix, the UTF-8
 * body, then zero fill to the smallest bucket in `BUCKETS` that fits. NIP-44's
 * own padding is not a full power-of-two ladder and leaks a few bits of
 * length, which is why the explicit buckets stay even though the body is no
 * longer a NIP-44 payload.
 *
 * KEY MATERIAL, honestly. The raw content key and the padded body are
 * `fill(0)`ed in a `finally` on both legs. `b64(rawKey)` nonetheless mints an
 * immutable JavaScript string holding the 256-bit content key, and the open
 * path gets one back from the signer; neither can be zeroized and both live
 * until GC. That is accepted: it is exactly the exposure every existing rail
 * already has for its whole NIP-44 plaintext, and here it is 32 bytes rather
 * than the entire payload. The `Uint8Array`s are still wiped.
 *
 * The wrap is NIP-44 **to self by default**, so an envelope is openable only
 * by the pubkey that sealed it, UNLESS the sealer passes `opts.recipientPubkey`
 * (R-4): a per-app projection is written by the grant's rail key and must be
 * readable by the app, so the content key is wrapped to the app's pubkey
 * instead. `openVaultPayload` needs no equivalent branch — NIP-44 conversation
 * keys are symmetric, so the app opening `k` with `(appSk, railPubkey)`
 * recovers what the rail wrapped with `(railSk, appPubkey)`. A future family
 * or re-home rail (Phase E) therefore cannot assume a guardian can open a
 * dependant-authored envelope sealed to self: sharing one means re-wrapping
 * its content key to the other party (or sealing to them in the first place),
 * not handing over the `content` string.
 *
 * NOT BOUND TO THE EVENT. The envelope authenticates its own body and nothing
 * around it — not the `d` tag, not the author, not `created_at`. Lifting a
 * `content` onto another event of the same author is therefore undetectable
 * here; replay of an older self-signed event is caught a layer up, by the
 * rails' newest-wins / sequence rule (R2), and cross-rail relabelling by the
 * fact that every rail decrypts to its own `d`-tagged schema. Any FUTURE
 * envelope field that is not redundant with the plaintext must go in AAD
 * rather than rely on a post-decrypt cross-check the way `b` does.
 *
 * MIXED VERSION. Readers accept BOTH formats — a `content` that is not a v2
 * envelope falls back to a bare `nip44Decrypt`. An OLDER build cannot read a
 * v2 envelope, treats it as "no record", and may republish a v1 record that
 * then wins newest-first; the newer build reads that v1 record fine, so
 * nothing is lost, only flapped. That is accepted while adoption is unknown
 * (exploration §8.4 review note).
 *
 * RELAY SIZE. The top bucket is 64 KiB of plaintext, roughly 87 KB of base64
 * in the event `content`. Confirm the relay pool's maximum event size before
 * raising it. A payload that does not fit is chunked by its rail
 * (`contacts-v2-sync.ts`) or refused with a `false` publish — never truncated,
 * and no record is ever silently dropped.
 */

import { importAesKeyRaw, IV_LENGTH } from './aes-crypto';
import type { DecryptingSigningBackend } from './signing-backend';

/** Power-of-two padding ladder, 4 KiB to 64 KiB, applied to the AES plaintext. */
export const BUCKETS: readonly number[] = [4096, 8192, 16384, 32768, 65536];

/** The largest bucket a single envelope can carry. */
export const TOP_BUCKET = BUCKETS[BUCKETS.length - 1];

/** Big-endian uint32 body length, inside the padded plaintext. */
export const LENGTH_PREFIX_BYTES = 4;

/**
 * Hard cap on the `content` string we will even attempt to parse, or hand to
 * the signer as a legacy fallback. The top bucket base64-expands to ~88 kB
 * plus the JSON frame, and the relay pool caps a message at 131_072 bytes, so
 * 100_000 is comfortable headroom over anything legitimate while still
 * bounding the work a hostile relay can impose. (§3.9: the earlier 262_144
 * admitted — and paid a NIP-44 round-trip for — a `content` twice the size
 * the pool will ever deliver.)
 */
export const MAX_ENVELOPE_CHARS = 100_000;

/**
 * Length-prefix `plaintext` and zero-pad it to the smallest bucket that fits.
 * Returns null when it does not fit `maxBucket` — the caller chunks or
 * refuses, and never truncates.
 */
export function padToBucket(
  plaintext: string,
  maxBucket: number = TOP_BUCKET,
  // `Uint8Array<ArrayBuffer>`, not a bare `Uint8Array`: SubtleCrypto's
  // `BufferSource` excludes a `SharedArrayBuffer`-backed view, and the seal
  // path hands this buffer straight to `crypto.subtle.encrypt` — the
  // alternative would be a defensive copy we could not then wipe.
): Uint8Array<ArrayBuffer> | null {
  const body = new TextEncoder().encode(plaintext);
  const needed = LENGTH_PREFIX_BYTES + body.length;
  const bucket = BUCKETS.find((b) => b >= needed && b <= maxBucket);
  if (bucket === undefined) return null;
  const out = new Uint8Array(bucket);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, LENGTH_PREFIX_BYTES);
  return out;
}

/** Reverse `padToBucket`. Returns null for a malformed or truncated buffer. */
export function unpad(padded: Uint8Array): string | null {
  if (padded.length < LENGTH_PREFIX_BYTES) return null;
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const length = view.getUint32(0, false);
  if (length > padded.length - LENGTH_PREFIX_BYTES) return null;
  return new TextDecoder().decode(padded.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length));
}

/** The JSON shape of a sealed `content`. */
export interface VaultEnvelope {
  v: 2;
  /** NIP-44-to-self ciphertext of the base64 content key. */
  k: string;
  /** Base64 AES-GCM IV. */
  iv: string;
  /** Base64 AES-GCM ciphertext of the padded body. */
  ct: string;
  /** Padding bucket the plaintext was padded to. */
  b: number;
}

/** What `sealVaultPayload` needs from a backend. */
export type SealBackend = Pick<DecryptingSigningBackend, 'nip44Encrypt' | 'activePublicKeyHex'>;

/** What `openVaultPayload` needs from a backend. */
export type OpenBackend = Pick<DecryptingSigningBackend, 'nip44Decrypt'>;

/** Per-call open behaviour. */
export interface OpenVaultOptions {
  /**
   * Attempt a bare `nip44Decrypt` when `content` is not a v2 envelope.
   * Default true — the five legacy rails need it to keep reading pre-v2
   * records. The contacts v2 rail passes `false`: it never had a v1 format,
   * and it opens up to 49 relay-supplied `content` strings per fetch, each of
   * which would otherwise be able to buy a signer round-trip (S5).
   */
  legacyFallback?: boolean;
}

/**
 * The shortest possible NIP-44 v2 payload in base64: a 1-byte version, a
 * 32-byte nonce, a 34-byte minimum padded ciphertext (a 2-byte length prefix
 * plus the 32-byte minimum pad block) and a 32-byte MAC is 99 bytes, which
 * base64-expands to exactly 132 characters. Anything shorter cannot be one.
 */
export const MIN_NIP44_V2_CHARS = 132;

const STRICT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * A connected backend's own pubkey. Strict lowercase, because that is what
 * every real backend produces (`bytesToHex` of the Schnorr public key) and
 * because a case-tolerant check here would quietly admit a pubkey that does
 * not match the one the rail stamps on the event.
 */
const LOWERCASE_HEX_64 = /^[0-9a-f]{64}$/;

// Chunked: `String.fromCharCode(...u)` over a 64 KiB payload would spread tens
// of thousands of arguments and blow the call-stack argument limit. Same
// helper shape as `sync-decrypt-cache.ts`.
const B64_CHUNK = 8192;
const b64 = (u: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < u.length; i += B64_CHUNK) {
    s += String.fromCharCode(...u.subarray(i, i + B64_CHUNK));
  }
  return btoa(s);
};
// `Uint8Array<ArrayBuffer>` for the same reason as `padToBucket` above: these
// go straight into SubtleCrypto's `BufferSource` parameters.
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Shape-check a `content` string as a v2 envelope. Returns null for anything
 * else — including a legacy bare NIP-44 ciphertext, which is not JSON at all.
 */
export function parseVaultEnvelope(content: string): VaultEnvelope | null {
  if (typeof content !== 'string' || content.length > MAX_ENVELOPE_CHARS) return null;
  let obj: unknown;
  try { obj = JSON.parse(content); } catch { return null; }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const e = obj as Record<string, unknown>;
  if (e.v !== 2) return null;
  if (typeof e.k !== 'string' || typeof e.iv !== 'string' || typeof e.ct !== 'string') return null;
  if (typeof e.b !== 'number' || !BUCKETS.includes(e.b)) return null;
  return { v: 2, k: e.k, iv: e.iv, ct: e.ct, b: e.b };
}

/**
 * Could `content` be a NIP-44 v2 ciphertext at all? Cheap, allocation-light,
 * and checked BEFORE the legacy fallback hands anything to the signer: on a
 * Heartwood install a `nip44Decrypt` is a 0.4-2 s NIP-46 round-trip, and a
 * hostile relay must not be able to buy one with arbitrary junk (S5).
 *
 * Three gates, cheapest first: the length window, the base64 alphabet, and
 * then the version byte — the first base64 quad decodes to the payload's
 * first three bytes, and byte 0 of a v2 payload is `2`.
 */
export function looksLikeNip44V2(content: string): boolean {
  if (typeof content !== 'string') return false;
  if (content.length < MIN_NIP44_V2_CHARS || content.length > MAX_ENVELOPE_CHARS) return false;
  if (content.length % 4 !== 0) return false;
  if (!STRICT_BASE64.test(content)) return false;
  try {
    return atob(content.slice(0, 4)).charCodeAt(0) === 2;
  } catch {
    return false;
  }
}

/**
 * Seal `plaintext` into a v2 envelope string, or null when it exceeds the top
 * bucket (or `opts.maxBucket`). The caller decides what "too big" means: the
 * contacts rail chunks, every other rail refuses the publish.
 *
 * The content key is wrapped to the AUTHOR'S OWN key by default — the backup
 * rails' behaviour, unchanged (R-4). Passing `opts.recipientPubkey` is the
 * per-app projection case: a grant's rail key writes an envelope only that
 * app can open, and it gets the same padding buckets every other rail gets
 * rather than a bare, length-revealing ciphertext. `openVaultPayload` needs
 * no equivalent change: NIP-44 conversation keys are symmetric, so the app
 * opening `k` with `(appSk, railPubkey)` recovers what the rail wrapped with
 * `(railSk, appPubkey)`.
 *
 * `crypto.subtle.encrypt` is called directly rather than through `aesEncrypt`
 * because the body here is already bytes — `aesEncrypt` takes a string and
 * would re-encode the zero padding away.
 *
 * A backend with no usable pubkey yields null too. `BunkerSigningBackend`
 * reports `activePublicKeyHex: ''` while disconnected, and wrapping to an
 * empty recipient would throw out of a publish path that is built to treat a
 * refusal as a `false` return, not an exception. A `recipientPubkey` that is
 * not strict lowercase 64-hex yields null the same way, checked before any
 * key material is generated.
 *
 * FAILS CLOSED, not just on shape. A `recipientPubkey` that is syntactically
 * valid lowercase 64-hex but not a point on secp256k1 (the self-wrap default
 * can never be this, since a connected backend's own `activePublicKeyHex` is
 * always a real point) — or any other rejection from `backend.nip44Encrypt`,
 * such as a bunker refusing the live request — throws inside the `try`. The
 * surrounding `catch` turns that into `null`, same contract as every other
 * failure in this function and the SDK mirror's own `sealVaultPayload`.
 *
 * `opts.random` is a test-only hook, mirroring the SDK's mirrored module
 * (`signet-contacts/src/wire/envelope.ts`): production callers omit it and
 * get real entropy from the platform `crypto`; the vector-parity test needs a
 * deterministic content key and IV to reproduce a frozen fixture byte for
 * byte. Called once for the 32-byte content key and once for the IV; a
 * misbehaving generator that returns the wrong length for either also fails
 * closed rather than being handed to `crypto.subtle`.
 */
export async function sealVaultPayload(
  plaintext: string,
  backend: SealBackend,
  opts: { maxBucket?: number; recipientPubkey?: string; random?: (bytes: number) => Uint8Array<ArrayBuffer> } = {},
): Promise<string | null> {
  if (typeof backend.activePublicKeyHex !== 'string') return null;
  if (!LOWERCASE_HEX_64.test(backend.activePublicKeyHex)) return null;
  // R-4: default is the author's own key — the backup rails' behaviour,
  // unchanged. A recipient is the per-app projection case: the grant's rail
  // writes an envelope only that app can open, and gets the same padding
  // buckets every other rail gets rather than a bare, length-revealing
  // ciphertext.
  const recipient = opts.recipientPubkey ?? backend.activePublicKeyHex;
  if (!LOWERCASE_HEX_64.test(recipient)) return null;
  const padded = padToBucket(plaintext, opts.maxBucket ?? TOP_BUCKET);
  if (padded === null) return null;
  const random = opts.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const rawKey = random(32);
  try {
    // Fail closed on a misbehaving injected `random` — a test-only hook, but
    // a short return here is still cheaper than an AES-GCM key import on
    // garbage, and matches the SDK mirror's own guard.
    if (rawKey.length !== 32) return null;
    const key = await importAesKeyRaw(rawKey);
    const iv = random(IV_LENGTH);
    if (iv.length !== IV_LENGTH) return null;
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, padded));
    const wrapped = await backend.nip44Encrypt(recipient, b64(rawKey));
    const envelope: VaultEnvelope = { v: 2, k: wrapped, iv: b64(iv), ct: b64(ciphertext), b: padded.length };
    return JSON.stringify(envelope);
  } catch {
    // A caller-supplied `recipientPubkey` that is syntactically valid
    // lowercase 64-hex but not a point on the curve (or a bunker's
    // `nip44Encrypt` refusing a live request) throws out of a path whose
    // contract everywhere else is a `null` return, never an exception — the
    // self-wrap default could never hit this, since a connected backend's
    // own `activePublicKeyHex` is always a real point. Fail closed, same as
    // every other failure mode in this module and the SDK mirror
    // (`envelope.ts`'s own `sealVaultPayload`).
    return null;
  } finally {
    rawKey.fill(0);
    padded.fill(0);
  }
}

/**
 * Open a v2 envelope, or fall back to a bare NIP-44 decrypt for a legacy (v1)
 * `content`. Returns null on ANY failure — tampered ciphertext, wrong key,
 * malformed padding, a backend that threw. A rail treats null exactly as it
 * already treats a parse failure: "nothing usable found".
 */
export async function openVaultPayload(
  content: string,
  backend: OpenBackend,
  authorPubkey: string,
  opts: OpenVaultOptions = {},
): Promise<string | null> {
  const envelope = parseVaultEnvelope(content);
  if (!envelope) {
    // Legacy bare NIP-44 payload (or junk). One attempt, never a throw, and
    // only when the caller wants the fallback AND the string could actually
    // be a v2 ciphertext — otherwise a hostile relay gets a free signer
    // round-trip per tag for the cost of a junk `content` (S5).
    if (opts.legacyFallback === false) return null;
    if (!looksLikeNip44V2(content)) return null;
    try {
      // The result is type-checked, not trusted: `nip44Decrypt` is a remote
      // NIP-46 call on a Heartwood install, and a device (or a man in the
      // middle of the bunker transport) can resolve it with any JSON value.
      // An object escaping here would be a non-null "plaintext" that
      // `readSyncPlaintext` would go on to cache as if it were one.
      const opened = await backend.nip44Decrypt(authorPubkey, content);
      return typeof opened === 'string' ? opened : null;
    } catch { return null; }
  }
  let rawKey: Uint8Array | null = null;
  // The decrypted body is the whole plaintext in the clear — wiped in the
  // `finally` alongside the key, exactly as the seal leg wipes its own copy.
  let padded: Uint8Array | null = null;
  try {
    rawKey = unb64(await backend.nip44Decrypt(authorPubkey, envelope.k));
    if (rawKey.length !== 32) return null;
    const key = await importAesKeyRaw(rawKey);
    padded = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(envelope.iv) },
      key,
      unb64(envelope.ct),
    ));
    // The declared bucket must match what actually came out — a mismatch
    // means the envelope was relabelled, which is a rewrite, not a read.
    if (padded.length !== envelope.b) return null;
    return unpad(padded);
  } catch {
    return null;
  } finally {
    rawKey?.fill(0);
    padded?.fill(0);
  }
}

/**
 * `openVaultPayload` as a throwing closure, for `readSyncPlaintext` — the
 * §11.1.10 decrypt cache takes a `() => Promise<string>` and caches whatever
 * it returns, so "could not open" has to be a rejection rather than a null
 * that would be cached as if it were plaintext.
 */
export async function openVaultPayloadOrThrow(
  content: string,
  backend: OpenBackend,
  authorPubkey: string,
  opts: OpenVaultOptions = {},
): Promise<string> {
  const plaintext = await openVaultPayload(content, backend, authorPubkey, opts);
  if (plaintext === null) throw new Error('vault payload could not be opened');
  return plaintext;
}
