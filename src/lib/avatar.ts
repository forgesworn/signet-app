/**
 * Avatar utilities — initial/colour fallbacks (top), plus per-persona
 * upload/fetch helpers (bottom). The upload/fetch path reuses
 * `photo-crypto` (AES-256-GCM) and `blossom` (NIP-98 PUT) so we don't
 * grow new crypto/HTTP surface for the same problem.
 */

import { encryptPhoto, encryptPhotoWithKey, decryptPhoto } from './photo-crypto';
import { uploadToBlossom } from './blossom';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SigningBackend } from './signing-backend';
import { isPrivateOrInternalHost } from './safe-url';

/** Cap per blob (post-downscale) so a fat photo can't choke a Blossom server. */
export const AVATAR_MAX_BYTES = 500 * 1024;

/**
 * Hard cap on the DOWNLOAD size in `fetchAvatar` (security audit 2026-06-15).
 * Uploads are capped at AVATAR_MAX_BYTES, but the download path trusts the
 * server — a malicious/attacker-steered Blossom host could return a multi-GB
 * body that is buffered into memory before the hash check can reject it.
 * 4× the upload cap is generous headroom while still bounding the buffer.
 */
export const AVATAR_MAX_DOWNLOAD_BYTES = AVATAR_MAX_BYTES * 4;

/**
 * Validate a Blossom base URL before issuing a fetch. Mirrors
 * `safeImageOrLinkUrl`: https only (plus http loopback for local dev), and
 * reject private/loopback/link-local/metadata hosts so a contact- or
 * inventory-supplied blossomUrl can't drive an SSRF/IP-probe.
 */
function isSafeBlossomBase(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return true;
  }
  if (url.protocol !== 'https:') return false;
  return !isPrivateOrInternalHost(url.hostname);
}

/**
 * Read a fetch Response body into a Uint8Array, aborting if it exceeds `cap`.
 * Checks the declared Content-Length first (cheap reject for honest servers),
 * then streams with a running byte counter (defends against a lying or absent
 * Content-Length). Falls back to a buffered read + post-check in environments
 * without a streaming body (e.g. some test mocks).
 */
async function readBodyCapped(response: Response, cap: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > cap) {
      throw new Error('Avatar too large — declared size exceeds cap');
    }
  }
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.length > cap) throw new Error('Avatar too large');
    return buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > cap) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error('Avatar too large — stream exceeded cap');
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
/** Max edge length for the downscaled avatar. 512 is a good balance — visibly
 *  sharp on retina-density profile renders, small enough to keep blob size
 *  under the cap without aggressive JPEG quality drops. */
export const AVATAR_MAX_EDGE_PX = 512;

/** Max edge length for the kind-0 public profile picture. Larger than the
 *  in-app avatar because external Nostr clients display these at varying
 *  sizes (profile screens, follow lists, hover cards). Still re-encoded
 *  via `downscaleAvatar` to strip EXIF — see also `PUBLIC_BANNER_MAX_EDGE_PX`. */
export const PUBLIC_PICTURE_MAX_EDGE_PX = 1024;

/** Max edge length for the kind-0 public profile banner. Wide images shown
 *  at the top of profile pages — capped a bit higher than the picture. */
export const PUBLIC_BANNER_MAX_EDGE_PX = 1500;

export interface AvatarMetadata {
  /** SHA-256 hex of the encrypted blob (matches `photoHash` on identity types). */
  hash: string;
  /** Blossom base URL the blob was uploaded to. */
  blossomUrl: string;
  /** Hex AES-256-GCM key — caller stores encrypted at rest. */
  keyHex: string;
  /** Unix seconds — caller uses for `avatarUpdatedAt`. */
  updatedAt: number;
}

/**
 * Downscale + re-encode an image File/Blob to a JPEG at most
 * `AVATAR_MAX_EDGE_PX` on its longest edge. Keeps aspect ratio. Re-encodes
 * regardless of input format to strip metadata (EXIF location etc.) and
 * normalise to JPEG. Returns the new Blob.
 *
 * If the input already fits, still re-encodes — strip-EXIF is the bigger
 * win than skipping a no-op resize.
 */
export async function downscaleAvatar(
  input: Blob,
  maxEdge: number = AVATAR_MAX_EDGE_PX,
): Promise<Blob> {
  const bitmap = await createImageBitmap(input);
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const scale = longEdge > maxEdge ? maxEdge / longEdge : 1;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(bitmap, 0, 0, w, h);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('Canvas toBlob failed')),
        'image/jpeg',
        0.85,
      );
    });
  } finally {
    bitmap.close?.();
  }
}

/**
 * Encrypt + upload a persona avatar to Blossom. Returns the metadata the
 * caller persists on the persona record. The `backend` signs the NIP-98 PUT
 * auth event under the user's key — Blossom never sees plaintext bytes.
 *
 * Caller is responsible for downscaling first via `downscaleAvatar` (we
 * accept any Blob here for testability; live callers should always
 * downscale to avoid wasted bandwidth and stay under `AVATAR_MAX_BYTES`).
 */
export async function uploadAvatar(
  blob: Blob,
  blossomUrl: string,
  backend: SigningBackend,
  /** Pass-through for the Blossom consent gate (now enforced at uploadToBlossom). */
  blossomConsent: boolean,
): Promise<AvatarMetadata> {
  if (blob.size > AVATAR_MAX_BYTES) {
    throw new Error(`Avatar too large (${Math.round(blob.size / 1024)} KB) — keep it under ${Math.round(AVATAR_MAX_BYTES / 1024)} KB`);
  }
  const raw = new Uint8Array(await blob.arrayBuffer());
  const { encryptedBlob, keyHex } = await encryptPhoto(raw);
  raw.fill(0);
  const encBlob = new Blob([new Uint8Array(encryptedBlob)], { type: 'application/octet-stream' });
  const hash = await uploadToBlossom(encBlob, blossomUrl, backend, blossomConsent);
  return { hash, blossomUrl, keyHex, updatedAt: Math.floor(Date.now() / 1000) };
}

/**
 * Encrypt + upload a contact-share avatar to Blossom under a STABLE,
 * caller-supplied key (the per-slot `contactAvatarKey`) — distinct from
 * `uploadAvatar`, which mints a fresh key each call. Returns the new blob
 * hash + the pointer fields the caller persists and republishes.
 */
export async function uploadContactAvatar(
  plaintext: Uint8Array,
  keyHex: string,
  blossomUrl: string,
  backend: SigningBackend,
  blossomConsent: boolean,
): Promise<{ hash: string; blossomUrl: string; updatedAt: number }> {
  const encryptedBlob = await encryptPhotoWithKey(plaintext, keyHex);
  const encBlob = new Blob([new Uint8Array(encryptedBlob)], { type: 'application/octet-stream' });
  const hash = await uploadToBlossom(encBlob, blossomUrl, backend, blossomConsent);
  return { hash, blossomUrl, updatedAt: Math.floor(Date.now() / 1000) };
}

/**
 * Fetch an encrypted avatar blob from Blossom, verify the hash matches
 * what was stored, then decrypt with the keyHex from IDB. Returns a Blob
 * that callers can pass to `URL.createObjectURL` for `<img>` display.
 *
 * Verifying the hash before decrypt protects against a malicious Blossom
 * server serving a tampered (but identically-encrypted-looking) blob —
 * the auth tag in AES-GCM also catches this, but the hash check is a
 * cheap pre-flight that avoids the SubtleCrypto round-trip.
 */
export async function fetchAvatar(meta: {
  hash: string;
  blossomUrl: string;
  keyHex: string;
}): Promise<Blob> {
  const baseUrl = meta.blossomUrl.replace(/\/+$/, '');
  // SSRF / IP-leak guard (security audit 2026-06-15): reject non-https or
  // private/internal Blossom hosts before issuing the GET. blossomUrl is
  // contact- / inventory-supplied for shared avatars.
  if (!isSafeBlossomBase(baseUrl)) {
    throw new Error('Avatar fetch rejected: unsafe Blossom URL (scheme or internal host)');
  }
  const url = `${baseUrl}/${meta.hash.toLowerCase()}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new Error(`Avatar fetch failed: ${response.status}`);
  }
  // Bound the buffered body so a hostile server can't exhaust memory before
  // the hash check runs.
  const buf = await readBodyCapped(response, AVATAR_MAX_DOWNLOAD_BYTES);
  const localHash = bytesToHex(sha256(buf));
  if (localHash.toLowerCase() !== meta.hash.toLowerCase()) {
    throw new Error('Avatar hash mismatch — server returned different bytes than expected');
  }
  const plaintext = await decryptPhoto(buf, meta.keyHex);
  // We re-encoded to JPEG during upload, so the type is always image/jpeg.
  return new Blob([new Uint8Array(plaintext)], { type: 'image/jpeg' });
}

/** Extract the first alphabetic character from a display name, uppercased. */
export function initialFromName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  for (const ch of trimmed) {
    if (/[A-Za-z]/.test(ch)) return ch.toUpperCase();
  }
  return '?';
}

/**
 * hue in [0, 360) → sRGB, given fixed saturation/lightness (both 0-1).
 * Small local HSL→RGB so this stays dependency-free.
 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (hp >= 0 && hp < 1) { r1 = c; g1 = x; }
  else if (hp < 2) { r1 = x; g1 = c; }
  else if (hp < 3) { g1 = c; b1 = x; }
  else if (hp < 4) { g1 = x; b1 = c; }
  else if (hp < 5) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }
  const m = l - c / 2;
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

/** WCAG relative luminance (sRGB → linear, Rec. 709 weights). */
function relativeLuminance(r: number, g: number, b: number): number {
  const toLinear = (c: number) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * The highest lightness `l` (at the given hue/saturation) whose luminance
 * stays at or below `maxLuminance`, found by binary search on the desired
 * lightness as the upper bound. Luminance rises monotonically with `l` for
 * a fixed hue/saturation in this HSL model, so this converges cleanly.
 * Some hues (yellow-green in particular) read far brighter than others at
 * the same nominal lightness, so a flat lightness band can't by itself
 * guarantee the white-text contrast bound below — this closes that gap
 * without moving hue or saturation.
 */
function capLightnessForLuminance(hue: number, saturation: number, lightness: number, maxLuminance: number): number {
  let lo = 0;
  let hi = lightness;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const [r, g, b] = hslToRgb(hue, saturation, mid);
    if (relativeLuminance(r, g, b) > maxLuminance) hi = mid; else lo = mid;
  }
  return lo;
}

/**
 * Relative luminance cap for the lighter gradient stop. WCAG contrast of
 * white (#FFFFFF, luminance 1.0) over a background of luminance L is
 * (1.05) / (L + 0.05); solving for contrast >= 4.5 gives L <= 0.1833. 0.16
 * leaves rounding headroom while still landing comfortably inside the
 * "muted jewel tone" band the top-of-range lightness targets.
 */
const AVATAR_MAX_TOP_LUMINANCE = 0.16;

/**
 * Deterministic brand-harmonious avatar gradient (2026-09 rebrand).
 *
 * Derives a hue from the pubkey bytes but constrains saturation/lightness
 * to a narrow band (muted, deep jewel tones) so every result sits well on
 * both navy and ivory app backgrounds and keeps white initials legible:
 * saturation ~22-38%, lightness top ~40-46% / bottom ~24-30%, each then
 * capped by `capLightnessForLuminance` so every hue clears a 4.5:1 white-
 * text contrast bound rather than just the ones with darker perceived
 * brightness at the same lightness. Determinism and the
 * `linear-gradient(135deg, …)` shape are unchanged from the previous
 * raw-RGB implementation, so existing callers/tests don't move.
 */
export function colourFromPubkey(pubkey: string): string {
  const hex = pubkey.replace(/^0x/, '').toLowerCase();
  const slice = (hex + '0000').slice(0, 4);
  const hueSeed = parseInt(slice, 16) || 0;
  const hue = hueSeed % 360;
  const saturation = 0.22 + (hueSeed % 17) / 100; // 0.22–0.38
  const lightnessTop = capLightnessForLuminance(hue, saturation, 0.40 + (hueSeed % 7) / 100, AVATAR_MAX_TOP_LUMINANCE);
  const lightnessBottom = capLightnessForLuminance(hue, saturation, 0.24 + (hueSeed % 7) / 100, AVATAR_MAX_TOP_LUMINANCE);

  const [r1, g1, b1] = hslToRgb(hue, saturation, lightnessTop);
  const [r2, g2, b2] = hslToRgb(hue, saturation, lightnessBottom);
  const c1 = `rgb(${r1},${g1},${b1})`;
  const c2 = `rgb(${r2},${g2},${b2})`;
  return `linear-gradient(135deg, ${c1}, ${c2})`;
}
