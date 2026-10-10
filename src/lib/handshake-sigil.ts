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
export const SIGIL_OVERHANG = 60;
const COLOURS = ['#ffcd52', '#73dfad', '#65c7ff', '#c2a0ff', '#ff8899', '#f3f3ee', '#ffac63', '#66e1dc'];
const pathD = (x: number, slope: number, bend: number) => {
  const n = (v: number) => Number(v.toFixed(2));
  return `M ${n(x + bend)} ${-SIGIL_OVERHANG} C ${n(x - slope)} 74 ${n(x - slope)} 153 ${n(x)} ${SIGIL_SEAM} S ${n(x + slope)} 326 ${n(x - bend)} ${SIGIL_HEIGHT + SIGIL_OVERHANG}`;
};
function sigilShape(digest: string) {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid sigil');
  const bytes = hexToBytes(digest);
  return Array.from({ length: 8 }, (_, i) => ({
    x: 18 + i * 29 + (bytes[i * 4] % 17), slope: (bytes[i * 4 + 1] % 41) - 20, bend: (bytes[i * 4 + 2] % 61) - 30,
    colour: COLOURS[bytes[i * 4 + 3] % COLOURS.length], width: 5 + bytes[i * 4 + 2] % 6,
  }));
}
/** Eight independent seam crossings, running top to bottom. Position, slope,
 * width and colour vary; both halves draw the SAME full paths, cropped at the
 * seam, so the phones are put top to top and the lines run from one into the other. */
export function sigilPaths(digest: string) {
  return sigilShape(digest).map(l => ({ d: pathD(l.x, l.slope, l.bend), colour: l.colour, width: l.width }));
}
export interface SigilWave { amplitude: number; periodMs: number; phase: number }
/**
 * How each line moves: it drifts along the seam, its slope through the seam
 * sways and its ends bend, each on its own slow rhythm, so the lines flex
 * towards and away from each other. Both phones derive it from the same digest
 * and run it on their own clocks, so a genuine pair moves together. What meets
 * at the seam (position and slope) changes slowly: at most 14 of 256 across
 * over 7 to 11 s, and a slope sway of up to 15 over 9 to 13 s, so clocks a
 * fraction of a second apart still join; the ends, far from the seam, bend
 * more. A different digest differs by whole positions and colours. A badly
 * wrong clock makes a genuine pair look broken: the safe way round. It adds no
 * cryptographic strength.
 */
export function sigilMotion(digest: string): Array<{ drift: SigilWave; slope: SigilWave; bend: SigilWave }> {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid sigil');
  const tag = new TextEncoder().encode('signet:handshake:sigil:motion:v2');
  const input = new Uint8Array(tag.length + 32);
  input.set(tag); input.set(hexToBytes(digest), tag.length);
  const bytes = new Uint8Array([...sha512(input), ...sha256(input)]);
  const phase = (b: number) => (b / 256) * 2 * Math.PI;
  return Array.from({ length: 8 }, (_, i) => {
    const b = bytes.subarray(i * 12, i * 12 + 12);
    return {
      drift: { amplitude: 8 + b[0] % 7, periodMs: 7000 + (b[1] % 5) * 1000, phase: phase(b[2]) },
      slope: { amplitude: 10 + b[3] % 6, periodMs: 9000 + (b[4] % 5) * 1000, phase: phase(b[5]) },
      bend: { amplitude: 18 + b[6] % 10, periodMs: 10000 + (b[7] % 6) * 1000, phase: phase(b[8]) },
    };
  });
}
/** A wave's value at wall-clock time `nowMs`. */
export function sigilWave(w: SigilWave, nowMs: number): number {
  return w.amplitude * Math.sin((2 * Math.PI * (nowMs % w.periodMs)) / w.periodMs + w.phase);
}
/** The paths at wall-clock time `nowMs`, for drawing frame by frame. */
export function sigilAnimator(digest: string): (nowMs: number) => string[] {
  const shape = sigilShape(digest), motion = sigilMotion(digest);
  return nowMs => shape.map((l, i) => pathD(l.x + sigilWave(motion[i].drift, nowMs), l.slope + sigilWave(motion[i].slope, nowMs),
    l.bend + sigilWave(motion[i].bend, nowMs)));
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
