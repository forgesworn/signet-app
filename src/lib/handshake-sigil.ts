import { contactMessageHash, contactVerificationWords } from '@forgesworn/signet-contacts';
import type { ContactExchangeState } from '@forgesworn/signet-contacts';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/** Validate commit/reveal, then hash all three canonical message hashes. Cards
 * are excluded by the SDK. Never derive from names, QR secrets or short words. */
export function handshakeSigil(exchange: ContactExchangeState): string {
  if (!exchange.acceptance || !exchange.reveal) throw new Error('Incomplete handshake');
  contactVerificationWords(exchange.request, exchange.acceptance, exchange.reveal, exchange.request.from);
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([
    'signet:handshake:sigil:v1', contactMessageHash(exchange.request),
    contactMessageHash(exchange.acceptance), contactMessageHash(exchange.reveal),
  ]))));
}
/** The whole sigil is SIGIL_WIDTH by SIGIL_HEIGHT; the seam runs across it at SIGIL_SEAM. */
export const SIGIL_WIDTH = 256, SIGIL_HEIGHT = 400, SIGIL_SEAM = 200;
/** The lines run this far beyond the top and bottom, so a half shifted away
 * from the seam (to allow for the phones' status bars) is never left blank. */
export const SIGIL_OVERHANG = 90;
/** Eight strongly different hues on the dark ground; each line gets its own. */
const COLOURS = ['#ffffff', '#ffd400', '#ff8a00', '#ff2d55', '#e040fb', '#2f7bff', '#00e5ff', '#00e676'];
/**
 * One line, top to bottom, snaking: from its top end it swings to one side
 * (turn1), crosses the seam at x with the given slope, swings to the other
 * side (turn2) and bends away to its bottom end. Each join is smooth. The seam
 * crossing depends only on x and slope, so the turns can move freely.
 */
const pathD = (x: number, slope: number, bend: number, turn1: number, turn2: number) => {
  const n = (v: number) => Number(v.toFixed(2));
  const top = -SIGIL_OVERHANG, bottom = SIGIL_HEIGHT + SIGIL_OVERHANG, t1 = x + turn1, t2 = x + turn2;
  return `M ${n(x + bend)} ${top} C ${n(x + bend)} 0 ${n(t1)} 20 ${n(t1)} 70 C ${n(t1)} 120 ${n(x - slope)} 153 ${n(x)} ${SIGIL_SEAM}`
    + ` S ${n(t2)} 280 ${n(t2)} 330 C ${n(t2)} 380 ${n(x - bend)} 400 ${n(x - bend)} ${bottom}`;
};
/** Bytes for what the digest's own 32 cannot all carry: the turns and the motion. */
function motionBytes(digest: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid sigil');
  const hash = (label: string) => {
    const tag = new TextEncoder().encode(label);
    const input = new Uint8Array(tag.length + 32);
    input.set(tag); input.set(hexToBytes(digest), tag.length);
    return sha512(input);
  };
  return new Uint8Array([...hash('signet:handshake:sigil:motion:v3:a'), ...hash('signet:handshake:sigil:motion:v3:b')]);
}
function sigilShape(digest: string) {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid sigil');
  const bytes = hexToBytes(digest), extra = motionBytes(digest);
  // The digest deals the colours out, so no two lines share one.
  const colours = [...COLOURS];
  for (let i = colours.length - 1; i > 0; i--) {
    const j = bytes[(colours.length - 1 - i) * 4 + 3] % (i + 1);
    [colours[i], colours[j]] = [colours[j], colours[i]];
  }
  return Array.from({ length: 8 }, (_, i) => {
    const e = extra.subarray(i * 16, i * 16 + 16);
    // The two turns go opposite ways, so the line snakes through the seam.
    const side = e[12] & 1 ? 1 : -1;
    return {
      x: 18 + i * 29 + (bytes[i * 4] % 17), slope: (bytes[i * 4 + 1] % 41) - 20, bend: (bytes[i * 4 + 2] % 111) - 55,
      turn1: side * (18 + e[13] % 23), turn2: -side * (18 + e[14] % 23),
      colour: colours[i], width: 5 + bytes[i * 4 + 2] % 6,
    };
  });
}
/** Eight independent seam crossings, running top to bottom. Position, slope,
 * width and colour vary; both halves draw the SAME full paths, cropped at the
 * seam, so the phones are put top to top and the lines run from one into the other. */
export function sigilPaths(digest: string) {
  return sigilShape(digest).map(l => ({ d: pathD(l.x, l.slope, l.bend, l.turn1, l.turn2), colour: l.colour, width: l.width }));
}
export interface SigilWave { amplitude: number; periodMs: number; phase: number }
export interface SigilLineMotion { drift: SigilWave; slope: SigilWave; bend: SigilWave; turn1: SigilWave; turn2: SigilWave }
/**
 * How each line moves: it drifts along the seam, its slope through the seam
 * sways, its two turns swing and its ends bend, each on its own slow rhythm,
 * so the lines snake and flex towards and away from each other. Both phones
 * derive it from the same digest and run it on their own clocks, so a genuine
 * pair moves together. What meets at the seam (position and slope) changes
 * slowly: at most 14 of 256 across over 7 to 11 s, and a slope sway of up to
 * 15 over 9 to 13 s, so clocks a fraction of a second apart still join; the
 * turns and the ends, away from the seam, move much more. A different digest
 * differs by whole positions and colours. A badly wrong clock makes a genuine
 * pair look broken: the safe way round. It adds no cryptographic strength.
 * Both phones must run the same build: a change here changes the picture.
 */
export function sigilMotion(digest: string): SigilLineMotion[] {
  const bytes = motionBytes(digest);
  const phase = (b: number) => (b / 256) * 2 * Math.PI;
  return Array.from({ length: 8 }, (_, i) => {
    const b = bytes.subarray(i * 16, i * 16 + 16);
    return {
      drift: { amplitude: 8 + b[0] % 7, periodMs: 7000 + (b[1] % 5) * 1000, phase: phase(b[2]) },
      slope: { amplitude: 10 + b[3] % 6, periodMs: 9000 + (b[4] % 5) * 1000, phase: phase(b[5]) },
      bend: { amplitude: 30 + b[6] % 15, periodMs: 10000 + (b[7] % 6) * 1000, phase: phase(b[8]) },
      turn1: { amplitude: 14 + b[9] % 12, periodMs: 8000 + (b[10] % 5) * 1000, phase: phase(b[11]) },
      turn2: { amplitude: 14 + b[15] % 12, periodMs: 8500 + (b[10] >> 4) % 5 * 1000, phase: phase(b[15] ^ b[11]) },
    };
  });
}
/** A wave's value at wall-clock time `nowMs`. */
export function sigilWave(w: SigilWave, nowMs: number): number {
  return w.amplitude * Math.sin((2 * Math.PI * (nowMs % w.periodMs)) / w.periodMs + w.phase);
}
/** The paths at wall-clock time `nowMs`, for drawing frame by frame.
 * `seamOnly` (reduced motion): only what meets at the seam keeps moving,
 * gently, so a pair still joins when the other phone animates in full; the
 * turns and ends, which only this phone shows, stay still. */
export function sigilAnimator(digest: string, options: { seamOnly?: boolean } = {}): (nowMs: number) => string[] {
  const shape = sigilShape(digest), motion = sigilMotion(digest);
  return nowMs => shape.map((l, i) => {
    const m = motion[i], at = (w: SigilWave) => sigilWave(w, nowMs), free = (w: SigilWave) => options.seamOnly ? 0 : at(w);
    return pathD(l.x + at(m.drift), l.slope + at(m.slope), l.bend + free(m.bend), l.turn1 + free(m.turn1), l.turn2 + free(m.turn2));
  });
}
/** `mutual`: both screens read by camera. `tapped`: both sessions crossed by
 * an NFC tap (quicker, one rung lower). `proven`: a one-way seam check. */
export type HandshakeStrength = 'mutual' | 'tapped' | 'proven';
export function handshakeEvidence(strength: HandshakeStrength, sigil: string) {
  if (!/^[0-9a-f]{64}$/.test(sigil)) throw new Error('Invalid sigil');
  return `signet:handshake:v1:${strength}:${sigil}`;
}
export function readHandshakeEvidence(evidence?: string): { strength: HandshakeStrength; sigil: string } | null {
  const match = /^signet:handshake:v1:(mutual|tapped|proven):([0-9a-f]{64})$/.exec(evidence ?? '');
  return match ? { strength: match[1] as HandshakeStrength, sigil: match[2] } : null;
}
