import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { type ContactInvite } from '@forgesworn/signet-contacts';
import { compactHandshakeInvite, createHandshakeFrameReader, decodeBase45, encodeBase45, handshakeFrames, readCompactHandshakeInvite } from './handshake-optical';
import { readHandshakeQR } from './handshake-proof';

const now = 1700000000;
const invite: ContactInvite = { v: 1, recipient: 'a1'.repeat(32), secret: 'b2'.repeat(32),
  relays: ['wss://relay.example/'], expiresAt: now + 120 };
const large = { ...invite, relays: ['wss://first.example/a', 'wss://second.example/b', 'wss://third.example/c'] };
describe('compact optical invite', () => {
  it('matches RFC 9285 vectors and rejects overflows, invalid characters and impossible lengths', () => {
    for (const [text, encoded] of [['AB', 'BB8'], ['Hello!!', '%69 VD92EX0'], ['base-45', 'UJCLQE7W581']] as const) {
      expect(encodeBase45(new TextEncoder().encode(text))).toBe(encoded);
      expect(new TextDecoder().decode(decodeBase45(encoded)!)).toBe(text);
    }
    for (const invalid of ['A', 'AAAa', ':::', '::', 'aaa', 'A'.repeat(8193)]) expect(decodeBase45(invalid)).toBeNull();
    for (let size = 1; size <= 256; size++) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 137 + size) % 256);
      expect(decodeBase45(encodeBase45(bytes))).toEqual(bytes);
    }
  });
  it('preserves all SDK fields and enforces the original short-lived proof boundary', () => {
    const compact = compactHandshakeInvite(invite)!;
    expect(readCompactHandshakeInvite(compact)).toEqual(invite);
    expect(readHandshakeQR(compact, now + 1)).toEqual({ invite });
    expect(readHandshakeQR(compact, now + 120)).toBeNull();
    expect(readHandshakeQR(compact, now - 1)).toBeNull();
    expect(compactHandshakeInvite({ ...invite, caption: 'Private name' })).toBeNull();
    expect(compactHandshakeInvite({ ...invite, relays: ['https://relay.example/'] })).toBeNull();
  });
  it('stays coarse for a single relay, with larger modules than the JSON envelope', () => {
    const compact = compactHandshakeInvite(invite)!;
    expect(handshakeFrames(compact)).toEqual([compact]);
    const json = JSON.stringify({ handshake: 1, invite });
    expect(QRCode.create(compact, { errorCorrectionLevel: 'M' }).modules.size).toBeLessThanOrEqual(41);
    expect(QRCode.create(compact).modules.size).toBeLessThan(QRCode.create(json).modules.size);
  });
  it('rejects truncated, trailing, invalid-version and invalid-UTF8 packets', () => {
    const raw = compactHandshakeInvite(invite)!, bytes = decodeBase45(raw.slice(5))!;
    expect(readCompactHandshakeInvite('SGH1:' + encodeBase45(bytes.subarray(0, bytes.length - 1)))).toBeNull();
    expect(readCompactHandshakeInvite('SGH1:' + encodeBase45(Uint8Array.from([...bytes, 0])))).toBeNull();
    for (const [index, value] of [[0, 2], [69, 9], [72, 255]] as const) {
      const broken = bytes.slice(); broken[index] = value;
      expect(readCompactHandshakeInvite('SGH1:' + encodeBase45(broken))).toBeNull();
    }
  });
});
describe('rotating coarse frames', () => {
  it('makes a normal invitation coarser by rotating it without omitting fields', () => {
    const payload = compactHandshakeInvite(invite)!, frames = handshakeFrames(payload, true), read = createHandshakeFrameReader();
    expect(frames.length).toBeGreaterThan(1);
    let restored: string | null = null;
    for (const frame of frames) {
      expect(QRCode.create(frame).modules.size).toBeLessThanOrEqual(37);
      restored = read(frame, 0);
    }
    expect(restored).toBe(payload);
    expect(readHandshakeQR(restored!, now)).toEqual({ invite });
  });
  it('assembles out of order with duplicates, verifying the full digest and retaining every relay', () => {
    const compact = compactHandshakeInvite(large)!, frames = handshakeFrames(compact), read = createHandshakeFrameReader();
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) expect(QRCode.create(frame).modules.size).toBeLessThanOrEqual(41);
    const reversed = [...frames].reverse();
    expect(read(reversed[0], 0)).toBeNull(); expect(read(reversed[0], 1)).toBeNull();
    for (const frame of reversed.slice(1, -1)) expect(read(frame, 2)).toBeNull();
    const result = read(reversed.at(-1)!, 3);
    expect(result).toBe(compact); expect(readHandshakeQR(result!, now)).toEqual({ invite: large });
  });
  it('reconstructs an invite from actual QR pixels decoded by the camera library', () => {
    const payload = compactHandshakeInvite(large)!, read = createHandshakeFrameReader();
    let result: string | null = null;
    for (const frame of handshakeFrames(payload)) {
      const qr = QRCode.create(frame).modules, size = (qr.size + 8) * 4;
      const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const mx = Math.floor(x / 4) - 4, my = Math.floor(y / 4) - 4;
        if (mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.data[my * qr.size + mx]) {
          const offset = (y * size + x) * 4; pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
        }
      }
      const decoded = jsQR(pixels, size, size);
      expect(decoded?.data).toBe(frame);
      result = read(decoded!.data, 0);
    }
    expect(readHandshakeQR(result!, now)).toEqual({ invite: large });
  });
  it('cannot stitch together fragments from different phones, altered payloads or inconsistent totals', () => {
    const first = handshakeFrames(compactHandshakeInvite(large)!);
    const second = handshakeFrames(compactHandshakeInvite({ ...large, secret: 'c3'.repeat(32) })!);
    const read = createHandshakeFrameReader();
    expect(read(first[0], 0)).toBeNull();
    for (const frame of second.slice(1)) expect(read(frame, 1)).toBeNull();
    const corrupt = createHandshakeFrameReader();
    for (const frame of first.slice(0, -1)) expect(corrupt(frame, 0)).toBeNull();
    const last = first.at(-1)!;
    expect(corrupt(last.slice(0, -1) + (last.at(-1) === 'A' ? 'B' : 'A'), 1)).toBeNull();
    const totals = createHandshakeFrameReader();
    expect(totals(first[0], 0)).toBeNull();
    expect(totals(first[1].slice(0, 53) + first[1].slice(53).replace(`:${first.length}:`, ':127:'), 1)).toBeNull();
  });
  it('expires partial assemblies and refuses oversized counts and unbounded input', () => {
    const frames = handshakeFrames(compactHandshakeInvite(large)!), read = createHandshakeFrameReader();
    expect(read(frames[0], 0)).toBeNull();
    for (const frame of frames.slice(1)) expect(read(frame, 60000)).toBeNull();
    expect(read(frames[0].slice(0, 53) + ':1:999:ABC', 60001)).toBeNull();
    expect(read('SGF1:' + 'A'.repeat(8192), 60001)).toBeNull();
    expect(read(frames[0], NaN)).toBeNull();
  });
});
