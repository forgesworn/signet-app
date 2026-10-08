import { parseContactInvite, type ContactInvite } from '@forgesworn/signet-contacts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

// RFC 9285 Base45 uses QR's alphanumeric mode. This is an optical wrapper;
// decoding reconstructs the unchanged SDK v1 invite before any proof is used.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const PREFIX = 'SGH1:';
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

export function compactHandshakeInvite(value: ContactInvite): string | null {
  const invite = parseContactInvite(JSON.stringify(value));
  if (!invite || invite.caption !== undefined || invite.expiresAt === undefined || invite.expiresAt > 0xffffffff) return null;
  const relays = invite.relays.map(url => new TextEncoder().encode(url.slice('wss://'.length)));
  const size = 70 + relays.reduce((n, relay) => n + 2 + relay.length, 0);
  if (size > 5460 || relays.some(relay => relay.length > 65535)) return null;
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
  bytes[0] = 1; bytes.set(hexToBytes(invite.recipient), 1); bytes.set(hexToBytes(invite.secret), 33);
  view.setUint32(65, invite.expiresAt); bytes[69] = relays.length;
  let offset = 70;
  for (const relay of relays) { view.setUint16(offset, relay.length); bytes.set(relay, offset + 2); offset += 2 + relay.length; }
  const raw = PREFIX + encodeBase45(bytes);
  return raw.length <= MAX_TEXT ? raw : null;
}
export function readCompactHandshakeInvite(raw: string): ContactInvite | null {
  if (!raw.startsWith(PREFIX)) return null;
  const bytes = decodeBase45(raw.slice(PREFIX.length));
  if (!bytes || bytes.length < 73 || bytes[0] !== 1 || bytes[69] < 1 || bytes[69] > 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), relays: string[] = [];
  let offset = 70;
  try {
    for (let i = 0; i < bytes[69]; i++) {
      if (offset + 2 > bytes.length) return null;
      const size = view.getUint16(offset); offset += 2;
      if (!size || offset + size > bytes.length) return null;
      relays.push('wss://' + new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + size)));
      offset += size;
    }
    if (offset !== bytes.length) return null;
    return parseContactInvite(JSON.stringify({ v: 1, recipient: bytesToHex(bytes.subarray(1, 33)),
      secret: bytesToHex(bytes.subarray(33, 65)), expiresAt: view.getUint32(65), relays }));
  } catch { return null; }
}
function frameDigest(raw: string): string {
  return encodeBase45(sha256(new TextEncoder().encode('signet:handshake:qr-frames:v1:' + raw)));
}
/** Coarse frames fit version 5 at M correction. The handshake requests
 * rotation even for a short invite; other callers may retain a static code. */
export function handshakeFrames(raw: string, rotate = false): string[] {
  if (!raw.startsWith(PREFIX) || (!rotate && raw.length <= 154)) return [raw];
  if (raw.length > MAX_TEXT) throw new Error('Handshake invite is too long');
  const count = Math.ceil(raw.length / CHUNK_SIZE);
  if (count > MAX_FRAMES) throw new Error('Too many handshake frames');
  const digest = frameDigest(raw);
  return Array.from({ length: count }, (_, index) => `${FRAME_PREFIX}${digest}:${index + 1}:${count}:${raw.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)}`);
}
/** One bounded assembly, no partial invite or optical consent. All fragments
 * must match one full SHA-256 digest before the SDK validates the invite. */
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
