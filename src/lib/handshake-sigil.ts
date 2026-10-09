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
/** Eight independent seam crossings. Position, slope, width and colour vary;
 * both halves draw the SAME full paths, cropped at the centre. */
export function sigilPaths(digest: string) {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid sigil');
  const bytes = hexToBytes(digest);
  const colours = ['#ffcd52', '#73dfad', '#65c7ff', '#c2a0ff', '#ff8899', '#f3f3ee', '#ffac63', '#66e1dc'];
  return Array.from({ length: 8 }, (_, i) => {
    const y = 18 + i * 29 + (bytes[i * 4] % 17);
    const slope = (bytes[i * 4 + 1] % 41) - 20;
    const bend = (bytes[i * 4 + 2] % 61) - 30;
    return { d: `M 0 ${y + bend} C 60 ${y - slope} 98 ${y - slope} 128 ${y} S 196 ${y + slope} 256 ${y - bend}`,
      colour: colours[bytes[i * 4 + 3] % colours.length], width: 5 + bytes[i * 4 + 2] % 6 };
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
