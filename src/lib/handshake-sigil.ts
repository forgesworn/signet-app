import { contactMessageHash, contactVerificationWords } from '@forgesworn/signet-contacts';
import type { ContactExchangeState } from '@forgesworn/signet-contacts';
import { sha256 } from '@noble/hashes/sha2.js';
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
/** Eight independent seam crossings, running top to bottom. Position, slope,
 * width and colour vary; both halves draw the SAME full paths, cropped at the
 * seam, so the phones are put top to top and the lines run from one into the other. */
export function sigilPaths(digest: string) {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid sigil');
  const bytes = hexToBytes(digest);
  const colours = ['#ffcd52', '#73dfad', '#65c7ff', '#c2a0ff', '#ff8899', '#f3f3ee', '#ffac63', '#66e1dc'];
  return Array.from({ length: 8 }, (_, i) => {
    const x = 18 + i * 29 + (bytes[i * 4] % 17);
    const slope = (bytes[i * 4 + 1] % 41) - 20;
    const bend = (bytes[i * 4 + 2] % 61) - 30;
    return { d: `M ${x + bend} 0 C ${x - slope} 94 ${x - slope} 153 ${x} ${SIGIL_SEAM} S ${x + slope} 306 ${x - bend} ${SIGIL_HEIGHT}`,
      colour: colours[bytes[i * 4 + 3] % colours.length], width: 5 + bytes[i * 4 + 2] % 6 };
  });
}
/**
 * How each line drifts along the seam. Both phones derive it from the same
 * digest and run it on their own clocks, so a genuine pair moves together;
 * the swing is small and slow (at most 14 of 256 across, over 7 to 11 s), so
 * clocks a fraction of a second apart still join, while a different digest
 * differs by whole positions and colours. A badly wrong clock makes a genuine
 * pair look broken: the safe way round. It adds no cryptographic strength.
 */
export function sigilMotion(digest: string) {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid sigil');
  const tag = new TextEncoder().encode('signet:handshake:sigil:motion:v1');
  const input = new Uint8Array(tag.length + 32);
  input.set(tag); input.set(hexToBytes(digest), tag.length);
  const bytes = sha256(input);
  return Array.from({ length: 8 }, (_, i) => ({
    amplitude: 8 + bytes[i * 4] % 7,
    periodMs: 7000 + (bytes[i * 4 + 1] % 5) * 1000,
    phase: (bytes[i * 4 + 2] / 256) * 2 * Math.PI,
  }));
}
/** A line's sideways offset at wall-clock time `nowMs`. */
export function sigilOffset(motion: { amplitude: number; periodMs: number; phase: number }, nowMs: number): number {
  return motion.amplitude * Math.sin((2 * Math.PI * (nowMs % motion.periodMs)) / motion.periodMs + motion.phase);
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
