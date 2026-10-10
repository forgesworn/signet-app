import { describe, expect, it } from 'vitest';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { ContactInvite } from '@forgesworn/signet-contacts';
import type { NostrEvent } from 'signet-protocol';
import { bindingTemplate, createHandshakeSession, handshakeRelays, isPublicRelayHost, mutualRevealProof, openReveal, readSessionQR, revealDigest, revealProof, sealReveal, sessionDialler,
  sessionQR, verifyRevealBinding, REVEAL_BINDING_KIND, type HandshakeSession, type RevealBody } from './handshake-reveal';
import { encodeBase45 } from './handshake-optical';

const now = 1700000000;
const personaA = hexToBytes('0a'.repeat(32)), personaB = hexToBytes('0b'.repeat(32)), stranger = hexToBytes('0c'.repeat(32));
const invite = (sk: Uint8Array, secret = '5'.repeat(64)): ContactInvite =>
  ({ v: 1, recipient: getPublicKey(sk), secret, relays: ['wss://relay.example/'], expiresAt: now + 120 });
function reveal(persona: Uint8Array, sender: HandshakeSession, receiver: string, inv = invite(persona)): RevealBody {
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
  it('takes only public relay hosts from the other phone: no LAN names, IP literals or single labels (review L1)', () => {
    for (const host of ['relay.example', 'nos.lol', 'Relay.Example.', 'a.b.c.example']) expect(isPublicRelayHost(host)).toBe(true);
    for (const host of ['nas', 'printer.local', 'router.lan', 'metadata.google.internal', 'box.home.arpa', 'x.localhost', 'nas.home', 'git.corp', 'fritz.box', 'myrouter.fritz.box',
      '8.8.8.8', '224.0.0.1', '255.255.255.255', '192.168.1.1', '[2001:db8::1]', '2001:db8::1', 'localhost', '127.0.0.1.', '']) {
      expect(isPublicRelayHost(host)).toBe(false);
    }
    expect(handshakeRelays(['wss://relay.example', 'wss://nas', 'ws://relay.example', 'wss://u:p@relay.example', 'nonsense', 'wss://8.8.8.8:443']))
      .toEqual(['wss://relay.example']);
  });
  it('drops relays on private, loopback or link-local hosts, and refuses a code with no other (NFC review M1)', () => {
    const s = createHandshakeSession();
    const card = { publicKey: s.publicKey, expiresAt: now + 120 };
    const read = (relays: string[]) => readSessionQR(sessionQR({ ...card, relays })!, now);
    expect(read(['wss://192.168.1.10', 'wss://relay.example/', 'wss://[::1]:7777'])).toEqual({ kind: 'session',
      card: { ...card, relays: ['wss://relay.example/'] } });
    for (const host of ['wss://localhost', 'wss://127.0.0.1:4869', 'wss://10.0.0.2', 'wss://169.254.169.254', 'wss://[fe80::1]', 'wss://0x7f000001']) {
      expect(read([host])).toBeNull();
    }
  });
});

describe('sealed reveal', () => {
  it('opens only for the session it was sealed to, and hides the sender', () => {
    const a = createHandshakeSession(), b = createHandshakeSession(), c = createHandshakeSession();
    const body = reveal(personaA, a, b.publicKey);
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
    expect(openReveal(sealReveal(reveal(personaA, a, c.publicKey), b.publicKey, now), b, now)).toBeNull();
    expect(openReveal(sealReveal(reveal(personaA, a, b.publicKey), b.publicKey, now), b, now + 120)).toBeNull();
    const lived = { ...invite(personaA), expiresAt: now + 3600 };
    expect(openReveal(sealReveal(reveal(personaA, a, b.publicKey, lived), b.publicKey, now), b, now)).toBeNull();
    const forged = { ...reveal(personaA, a, b.publicKey), invite: invite(stranger) };
    expect(openReveal(sealReveal(forged, b.publicKey, now), b, now)).toBeNull();
  });
});

describe('reveal binding and the mutual proof', () => {
  const a = createHandshakeSession(), b = createHandshakeSession(), c = createHandshakeSession();
  const fromA = reveal(personaA, a, b.publicKey);
  const proof = { ownSession: b, cameraPeerSession: a.publicKey, peerReveal: fromA, counterparty: getPublicKey(personaA),
    readAt: now + 5, sessionStart: now, sessionExpiresAt: now + 120, peerExpiresAt: now + 120 };
  it('verifies only under the session this camera read, naming this session', () => {
    expect(verifyRevealBinding(fromA, a.publicKey, b)).toBe(true);
    // A phone that did not scan A has only a guess at A's session.
    expect(verifyRevealBinding(fromA, c.publicKey, b)).toBe(false);
    // A reveal A signed for C proves nothing to B.
    expect(verifyRevealBinding(reveal(personaA, a, c.publicKey), a.publicKey, b)).toBe(false);
    expect(verifyRevealBinding(fromA, a.publicKey, a)).toBe(false);
    // The binding must be signed by the persona the invite names.
    const swapped = { ...fromA, binding: finalizeEvent(bindingTemplate(a, b.publicKey, fromA.invite, now), stranger) as NostrEvent };
    expect(verifyRevealBinding(swapped, a.publicKey, b)).toBe(false);
    const tampered = { ...fromA, invite: { ...fromA.invite, secret: '6'.repeat(64) } };
    expect(verifyRevealBinding(tampered, a.publicKey, b)).toBe(false);
  });
  it('is mutual only for the counterparty, inside both sessions, with the return scan proven', () => {
    expect(mutualRevealProof(proof)).toBe(true);
    expect(mutualRevealProof({ ...proof, counterparty: getPublicKey(personaB) })).toBe(false);
    expect(mutualRevealProof({ ...proof, readAt: now - 1 })).toBe(false);
    expect(mutualRevealProof({ ...proof, readAt: now + 120 })).toBe(false);
    expect(mutualRevealProof({ ...proof, peerExpiresAt: now + 5 })).toBe(false);
    expect(mutualRevealProof({ ...proof, cameraPeerSession: c.publicKey })).toBe(false);
    expect(mutualRevealProof({ ...proof, peerReveal: reveal(personaA, a, c.publicKey) })).toBe(false);
  });
  it('refuses a reveal forged by someone who knows both public session keys (review C1)', () => {
    // Mallory read both screens (or a relay, or Bluetooth) and signs with her own persona,
    // claiming A's session. She cannot compute the proof A's session secret would give.
    const invite_ = invite(stranger);
    const guess = revealProof(c.secret, b.publicKey);
    const forged: RevealBody = { v: 2, to: b.publicKey, invite: invite_, binding: finalizeEvent({ kind: REVEAL_BINDING_KIND, created_at: now, tags: [],
      content: revealDigest(a.publicKey, b.publicKey, guess, invite_) }, stranger) as NostrEvent };
    expect(verifyRevealBinding(forged, a.publicKey, b)).toBe(false);
    expect(mutualRevealProof({ ...proof, peerReveal: forged, counterparty: getPublicKey(stranger) })).toBe(false);
    // The proof is the same from either end, and only from the two sessions.
    expect(revealProof(a.secret, b.publicKey)).toBe(revealProof(b.secret, a.publicKey));
    expect(revealProof(c.secret, b.publicKey)).not.toBe(revealProof(a.secret, b.publicKey));
  });
  it('lets exactly one phone dial', () => {
    expect(sessionDialler(a.publicKey, b.publicKey)).toBe(!sessionDialler(b.publicKey, a.publicKey));
    expect(sessionDialler(a.publicKey, a.publicKey)).toBe(false);
  });
});
