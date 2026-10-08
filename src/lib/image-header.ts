/**
 * Image format sniffing and header-only dimension reading for contact pictures.
 *
 * Pure, synchronous, no decoding. Every picture — downloaded or picked — goes
 * through `checkImageHeader` BEFORE any decoder sees it: the format comes from
 * the magic bytes (never from a Content-Type or a file name), and the
 * dimensions come from the header, so an image bomb (a tiny file claiming a
 * huge canvas) is refused before `createImageBitmap` can allocate for it.
 *
 * Only JPEG, PNG and WebP are accepted. Everything else — SVG (scriptable),
 * GIF, AVIF, HEIC, BMP — is refused.
 */

export type ImageFormat = 'jpeg' | 'png' | 'webp';

/** Longest side allowed, in pixels. */
export const MAX_IMAGE_SIDE_PX = 8192;
/** Most pixels allowed (width × height). */
export const MAX_IMAGE_PIXELS = 40_000_000;

export interface ImageHeader {
  format: ImageFormat;
  width: number;
  height: number;
}

export type ImageHeaderCheck =
  | ({ ok: true } & ImageHeader)
  | { ok: false; reason: 'unsupported' | 'unreadable' | 'too-large' };

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** The format the magic bytes claim, or null when it is not one we accept. */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 'PNG')
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png';
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'webp';
  return null;
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);

/** SOFn markers carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) do not. */
function isSofMarker(m: number): boolean {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
}

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2; // after SOI
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    // Fill bytes: any number of 0xFF before the marker code.
    while (i < b.length && b[i] === 0xff) i += 1;
    if (i >= b.length) return null;
    const marker = b[i];
    i += 1;
    // Standalone markers (no length): TEM, RSTn.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // Start of scan or end of image before any frame header: no size to read.
    if (marker === 0xda || marker === 0xd9) return null;
    if (i + 2 > b.length) return null;
    const length = u16be(b, i);
    if (length < 2) return null;
    if (isSofMarker(marker)) {
      if (i + 7 > b.length || length < 7) return null;
      const height = u16be(b, i + 3);
      const width = u16be(b, i + 5);
      return { width, height };
    }
    i += length;
  }
  return null;
}

function pngSize(b: Uint8Array): { width: number; height: number } | null {
  // Signature (8) + chunk length (4) + "IHDR" (4) + width (4) + height (4).
  if (b.length < 24 || !ascii(b, 12, 'IHDR')) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30) return null;
  if (ascii(b, 12, 'VP8 ')) {
    // Frame tag (3) then the key-frame start code 9D 01 2A.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, 'VP8L')) {
    if (b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, 'VP8X')) {
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  return null;
}

/** Format and dimensions from the header alone, or null when unreadable. */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  const format = sniffImageFormat(bytes);
  if (!format) return null;
  const size = format === 'jpeg' ? jpegSize(bytes) : format === 'png' ? pngSize(bytes) : webpSize(bytes);
  if (!size || size.width <= 0 || size.height <= 0) return null;
  return { format, ...size };
}

/** The gate every contact picture passes before it is decoded. */
export function checkImageHeader(bytes: Uint8Array): ImageHeaderCheck {
  if (!sniffImageFormat(bytes)) return { ok: false, reason: 'unsupported' };
  const header = readImageHeader(bytes);
  if (!header) return { ok: false, reason: 'unreadable' };
  if (header.width > MAX_IMAGE_SIDE_PX || header.height > MAX_IMAGE_SIDE_PX
    || header.width * header.height > MAX_IMAGE_PIXELS) {
    return { ok: false, reason: 'too-large' };
  }
  return { ok: true, ...header };
}

/** Thumbnail longest side, in pixels. */
export const THUMBNAIL_MAX_SIDE_PX = 256;
/** JPEG quality for the re-encoded thumbnail. */
export const THUMBNAIL_JPEG_QUALITY = 0.8;

/** Fit `width × height` inside `maxSide`, keeping the aspect ratio. Never upscales. */
export function thumbnailSize(width: number, height: number, maxSide: number = THUMBNAIL_MAX_SIDE_PX): { width: number; height: number } {
  const longest = Math.max(width, height, 1);
  const scale = longest > maxSide ? maxSide / longest : 1;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
