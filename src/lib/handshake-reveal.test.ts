import { describe, expect, it } from 'vitest';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { ContactInvite } from '@forgesworn/signet-contacts';
import type { NostrEvent } from 'signet-protocol';
import { bindingTemplate, createHandshakeSession, mutualRevealProof, openReveal, readSessionQR, sealReveal, sessionDialler,
  sessionQR, verifyRevealBinding, type RevealBody } from './handshake-reveal';
import { encodeBase45 } from './handshake-optical';

const now = 1700000000;
const personaA = hexToBytes('0a'.repeat(32)), personaB = hexToBytes('0b'.repeat(32)), stranger = hexToBytes('0c'.repeat(32));
const invite = (sk: Uint8Array, secret = '5'.repeat(64)): ContactInvite =>
  ({ v: 1, recipient: getPublicKey(sk), secret, relays: ['wss://relay.example/'], expiresAt: now + 120 });
function reveal(persona: Uint8Array, sender: string, receiver: string, inv = invite(persona)): RevealBody {
  return { v: 2, to: receiver, invite: inv, binding: finalizeEvent(bindingTemplate(sender, receiver, inv, now), persona) as NostrEvent };
}

describe('session QR', () => {
  it('round-trips a session key, expiry and relays, and names nobody', () => {
    const s = createHandshakeSession();
    const raw = sessionQR({ publicKey: s.publicKey, expiresAt: now + 120, relays: ['wss://relay.example/', 'wss://other.example'] })!;
    expect(raw.startsWith('SGH2:')).toBe(true);
    expect(readSessionQR(raw, now)).toEqual({ kind: 'session', card: { publicKey: s.publicKey, expiresAt: now + 120,
      relays: ['wss://relay.example/', 'wss://other.example'] } });
    expect(raw).not.toContain(getPublicKey(personaA).slice(0, 8));
  });
  it('refuses expired, long-lived, malformed and outdated codes', () => {
    const s = createHandshakeSession();
    const card = { publicKey: s.publicKey, expiresAt: now + 120, relays: ['wss://relay.example'] };
    expect(readSessionQR(sessionQR(card)!, now + 120)).toBeNull();
    expect(readSessionQR(sessionQR({ ...card, expiresAt: now + 121 })!, now)).toBeNull();
    expect(sessionQR({ ...card, relays: ['ws://relay.example'] })).toBeNull();
    expect(sessionQR({ ...card, relays: [] })).toBeNull();
    expect(readSessionQR(sessionQR(card)! + '00', now)).toBeNull();
    expect(readSessionQR('SGH2:' + encodeBase45(Uint8Array.of(1, ...new Uint8Array(37))), now)).toBeNull();
    expect(readSessionQR('SGH1:ABC', now)).toEqual({ kind: 'outdated' });
    expect(readSessionQR('nostr:npub1x', now)).toBeNull();
    expect(readSessionQR('S'.repeat(9000), now)).toBeNull();
  });
});

describe('sealed reveal', () => {
  it('opens only for the session it was sealed to, and hides the sender', () => {
    const a = createHandshakeSession(), b = createHandshakeSession(), c = createHandshakeSession();
    const body = reveal(personaA, a.publicKey, b.publicKey);
    const sealed = sealReveal(body, b.publicKey, now);
    expect(sealed.pubkey).not.toBe(a.publicKey);
    expect(sealed.pubkey).not.toBe(getPublicKey(personaA));
    expect(JSON.stringify(sealed)).not.toContain(a.publicKey);
    expect(JSON.parse(JSON.stringify(openReveal(sealed, b, now)))).toEqual(JSON.parse(JSON.stringify(body)));
    expect(openReveal(sealed, c, now)).toBeNull();
    expect(openReveal({ ...sealed, content: sealed.content.slice(0, -4) + 'AAAA' }, b, now)).toBeNull();
    expect(openReveal({ ...sealed, tags: [['p', c.publicKey]] }, b, now)).toBeNull();
  });
  it('refuses a reveal for another session, an expired or long-lived invite, or a binding by someone else', () => {
    const a = createHandshakeSession(), b = createHandshakeSession(), c = createHandshakeSession();
    expect(openReveal(sealReveal(reveal(personaA, a.publicKey, c.publicKey), b.publicKey, now), b, now)).toBeNull();
    expect(openReveal(sealReveal(reveal(personaA, a.publicKey, b.publicKey), b.publicKey, now), b, now + 120)).toBeNull();
    const lived = { ...invite(personaA), expiresAt: now + 3600 };
    expect(openReveal(sealReveal(reveal(personaA, a.publicKey, b.publicKey, lived), b.publicKey, now), b, now)).toBeNull();
    const forged = { ...reveal(personaA, a.publicKey, b.publicKey), invite: invite(stranger) };
    expect(openReveal(sealReveal(forged, b.publicKey, now), b, now)).toBeNull();
  });
});

describe('reveal binding and the mutual proof', () => {
  const a = createHandshakeSession(), b = createHandshakeSession(), c = createHandshakeSession();
  const fromA = reveal(personaA, a.publicKey, b.publicKey);
  const proof = { ownSession: b.publicKey, cameraPeerSession: a.publicKey, peerReveal: fromA, counterparty: getPublicKey(personaA),
    readAt: now + 5, sessionStart: now, sessionExpiresAt: now + 120, peerExpiresAt: now + 120 };
  it('verifies only under the session this camera read, naming this session', () => {
    expect(verifyRevealBinding(fromA, a.publicKey, b.publicKey)).toBe(true);
    // A phone that did not scan A has only a guess at A's session.
    expect(verifyRevealBinding(fromA, c.publicKey, b.publicKey)).toBe(false);
    // A reveal A signed for C proves nothing to B.
    expect(verifyRevealBinding(reveal(personaA, a.publicKey, c.publicKey), a.publicKey, b.publicKey)).toBe(false);
    expect(verifyRevealBinding(fromA, a.publicKey, a.publicKey)).toBe(false);
    // The binding must be signed by the persona the invite names.
    const swapped = { ...fromA, binding: finalizeEvent(bindingTemplate(a.publicKey, b.publicKey, fromA.invite, now), stranger) as NostrEvent };
    expect(verifyRevealBinding(swapped, a.publicKey, b.publicKey)).toBe(false);
    const tampered = { ...fromA, invite: { ...fromA.invite, secret: '6'.repeat(64) } };
    expect(verifyRevealBinding(tampered, a.publicKey, b.publicKey)).toBe(false);
  });
  it('is mutual only for the counterparty, inside both sessions, with the return scan proven', () => {
    expect(mutualRevealProof(proof)).toBe(true);
    expect(mutualRevealProof({ ...proof, counterparty: getPublicKey(personaB) })).toBe(false);
    expect(mutualRevealProof({ ...proof, readAt: now - 1 })).toBe(false);
    expect(mutualRevealProof({ ...proof, readAt: now + 120 })).toBe(false);
    expect(mutualRevealProof({ ...proof, peerExpiresAt: now + 5 })).toBe(false);
    expect(mutualRevealProof({ ...proof, cameraPeerSession: c.publicKey })).toBe(false);
    expect(mutualRevealProof({ ...proof, peerReveal: reveal(personaA, a.publicKey, c.publicKey) })).toBe(false);
  });
  it('lets exactly one phone dial', () => {
    expect(sessionDialler(a.publicKey, b.publicKey)).toBe(!sessionDialler(b.publicKey, a.publicKey));
    expect(sessionDialler(a.publicKey, a.publicKey)).toBe(false);
  });
});
