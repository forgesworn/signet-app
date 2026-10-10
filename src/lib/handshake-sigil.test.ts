import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { expect, it } from 'vitest';
import { createContactRequest, beginContactExchange, acceptContactExchange, receiveContactAcceptance, receiveContactReveal, confirmContactRevealSent } from '@forgesworn/signet-contacts';
import { handshakeSigil, sigilPaths, handshakeEvidence, readHandshakeEvidence } from './handshake-sigil';
function transcript(seed = '4') {
  const request = createContactRequest({ id: '5'.repeat(32), from: '1'.repeat(64), to: '2'.repeat(64), nonce: seed.repeat(64),
    reply: { secret: '6'.repeat(64), relays: ['wss://relay.example'] }, now: 100 });
  const b = acceptContactExchange(request, '7'.repeat(64), 101);
  const a = receiveContactAcceptance(beginContactExchange(request, seed.repeat(64)), b.acceptance!, 102);
  return { a: confirmContactRevealSent(a), b: receiveContactReveal(b, a.reveal!, 103) };
}
it('derives the same mark on both verified transcripts and changes with fresh nonces', () => {
  const { a, b } = transcript();
  expect(handshakeSigil(a)).toBe(handshakeSigil(b));
  expect(handshakeSigil(a)).toMatch(/^[0-9a-f]{64}$/);
  expect(handshakeSigil(transcript('8').a)).not.toBe(handshakeSigil(a));
  expect(handshakeSigil({ ...a, request: { ...a.request, card: { name: 'Self-declared' } } })).toBe(handshakeSigil(a));
});
it('refuses absent or inconsistent commit/reveal transcripts', () => {
  const { a } = transcript();
  expect(() => handshakeSigil({ ...a, reveal: undefined })).toThrow();
  expect(() => handshakeSigil({ ...a, reveal: { ...a.reveal!, nonce: '9'.repeat(64) } })).toThrow();
  expect(() => handshakeSigil({ ...a, acceptance: { ...a.acceptance!, from: 'a'.repeat(64) } })).toThrow();
});
it('gives each half identical seam geometry; independently varied transcripts change the seam', () => {
  const { a, b } = transcript();
  expect(sigilPaths(handshakeSigil(a))).toEqual(sigilPaths(handshakeSigil(b)));
  expect(sigilPaths(handshakeSigil(a))).toHaveLength(8);
  const variants = Array.from({ length: 20 }, (_, i) => sigilPaths(bytesToHex(sha256(new TextEncoder().encode(`fixture:${i}`)))));
  expect(new Set(variants.map(v => JSON.stringify(v))).size).toBe(20);
  expect(() => sigilPaths('bad')).toThrow();
  // Every line has its own colour, and the digest decides which.
  for (const v of variants) expect(new Set(v.map(p => p.colour)).size).toBe(8);
  expect(new Set(variants.map(v => v.map(p => p.colour).join())).size).toBeGreaterThan(15);
});
it('round trips private check evidence without introducing any contact method', () => {
  const sigil = handshakeSigil(transcript().a);
  expect(readHandshakeEvidence(handshakeEvidence('mutual', sigil))).toEqual({ strength: 'mutual', sigil });
  expect(readHandshakeEvidence('ordinary private note')).toBeNull();
  expect(readHandshakeEvidence('signet:handshake:v1:mutual:bad')).toBeNull();
});
