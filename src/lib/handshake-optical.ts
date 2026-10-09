import { sha256 } from '@noble/hashes/sha2.js';

// RFC 9285 Base45 uses QR's alphanumeric mode. The payload is a handshake
// session code (handshake-reveal.ts): a session key, its relays and expiry.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const PREFIX = 'SGH2:';
const FRAME_PREFIX = 'SGF1:';
const MAX_TEXT = 8192;
const MAX_FRAMES = 128;
const CHUNK_SIZE = 50;
const MAX_CHUNK_SIZE = 80;
const ASSEMBLY_MS = 60000;
export const HANDSHAKE_FRAME_MS = 500;

export function encodeBase45(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 2) {
    const paired = i + 1 < bytes.length;
    let n = paired ? bytes[i] * 256 + bytes[i + 1] : bytes[i];
    text += ALPHABET[n % 45]; n = Math.floor(n / 45);
    text += ALPHABET[n % 45];
    if (paired) text += ALPHABET[Math.floor(n / 45)];
  }
  return text;
}
export function decodeBase45(text: string): Uint8Array | null {
  if (!text || text.length > MAX_TEXT || text.length % 3 === 1) return null;
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 3) {
    const size = Math.min(3, text.length - i);
    const digits = [...text.slice(i, i + size)].map(c => ALPHABET.indexOf(c));
    if (digits.some(d => d < 0)) return null;
    const n = digits[0] + digits[1] * 45 + (size === 3 ? digits[2] * 2025 : 0);
    if (n > (size === 3 ? 65535 : 255)) return null;
    if (size === 3) bytes.push(n >> 8, n & 255); else bytes.push(n);
  }
  return Uint8Array.from(bytes);
}

function frameDigest(raw: string): string {
  return encodeBase45(sha256(new TextEncoder().encode('signet:handshake:qr-frames:v1:' + raw)));
}
/** Coarse frames fit version 5 at M correction. The handshake requests
 * rotation even for a short code; other callers may retain a static code. */
export function handshakeFrames(raw: string, rotate = false): string[] {
  if (!raw.startsWith(PREFIX) || (!rotate && raw.length <= 154)) return [raw];
  if (raw.length > MAX_TEXT) throw new Error('Handshake code is too long');
  const count = Math.ceil(raw.length / CHUNK_SIZE);
  if (count > MAX_FRAMES) throw new Error('Too many handshake frames');
  const digest = frameDigest(raw);
  return Array.from({ length: count }, (_, index) => `${FRAME_PREFIX}${digest}:${index + 1}:${count}:${raw.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)}`);
}
/** One bounded assembly, no partial code or optical consent. All fragments
 * must match one full SHA-256 digest before the code is parsed. */
export function createHandshakeFrameReader() {
  let session: { digest: string; count: number; started: number; parts: Map<number, string> } | undefined;
  return (raw: string, nowMs: number): string | null => {
    if (!Number.isFinite(nowMs) || nowMs < 0 || raw.length > MAX_TEXT) return null;
    if (!raw.startsWith(FRAME_PREFIX)) { session = undefined; return raw; }
    if (raw.length > 154) return null;
    const digest = raw.slice(5, 53);
    const hash = decodeBase45(digest);
    const match = /^:([1-9]\d{0,2}):([1-9]\d{0,2}):(.+)$/.exec(raw.slice(53));
    if (!hash || hash.length !== 32 || !match) return null;
    const index = Number(match[1]), count = Number(match[2]), part = match[3];
    // Accept the earlier 80-character frames as well. The complete digest,
    // rather than an assumed fragment length, binds the reconstructed invite.
    if (count < 2 || count > MAX_FRAMES || index > count || part.length > MAX_CHUNK_SIZE
      || [...part].some(c => !ALPHABET.includes(c))) return null;
    if (!session || session.digest !== digest || nowMs < session.started || nowMs - session.started >= ASSEMBLY_MS) {
      session = { digest, count, started: nowMs, parts: new Map() };
    }
    if (session.count !== count || (session.parts.has(index) && session.parts.get(index) !== part)) { session = undefined; return null; }
    session.parts.set(index, part);
    if (session.parts.size !== count) return null;
    const joined = Array.from({ length: count }, (_, i) => session!.parts.get(i + 1)).join('');
    session = undefined;
    return joined.length <= MAX_TEXT && joined.startsWith(PREFIX) && frameDigest(joined) === digest ? joined : null;
  };
}
