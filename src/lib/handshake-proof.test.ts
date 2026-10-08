import { describe, expect, it } from 'vitest';
import { createContactRequest } from '@forgesworn/signet-contacts';
import type { ContactInvite } from '@forgesworn/signet-contacts';
import { handshakeQR, handshakeRole, inviteFingerprint, mayAutoAcceptHandshake, readHandshakeQR, validHandshakeScan } from './handshake-proof';
const low = '1'.repeat(64), high = '2'.repeat(64), now = 1700000000;
const invite = (recipient: string, secret = '3'.repeat(64)): ContactInvite => ({ v: 1, recipient, secret, relays: ['wss://relay.example/'], expiresAt: now + 120 });
const own = invite(high), peer = invite(low, '4'.repeat(64));
const request = createContactRequest({ id: '5'.repeat(32), from: low, to: high, nonce: '6'.repeat(64), reply: { secret: '7'.repeat(64), relays: own.relays }, now: now + 1, expiresAt: now + 120 });
const proof = { own, scanned: { invite: peer, echo: inviteFingerprint(own) }, request, now: now + 2, receivedOnOwnInvite: true };
describe('optical handshake proof', () => {
  it('assigns exactly one sender, refusing self and malformed keys', () => {
    expect(handshakeRole(low, high)).toBe('requester'); expect(handshakeRole(high, low)).toBe('recipient');
    expect(handshakeRole(low, low)).toBeNull(); expect(handshakeRole('npub', high)).toBeNull();
  });
  it('requires our optical mailbox AND the signature-verified request from the camera key', () => {
    expect(mayAutoAcceptHandshake(proof)).toBe(true);
    expect(mayAutoAcceptHandshake({ ...proof, receivedOnOwnInvite: false })).toBe(false);
    expect(mayAutoAcceptHandshake({ ...proof, scanned: { invite: peer } })).toBe(true);
    expect(mayAutoAcceptHandshake({ ...proof, request: { ...request, from: '8'.repeat(64) } })).toBe(false);
    expect(mayAutoAcceptHandshake({ ...proof, request: { ...request, to: low } })).toBe(false);
    expect(mayAutoAcceptHandshake({ ...proof, own: peer, scanned: { invite: own, echo: inviteFingerprint(peer) } })).toBe(false);
  });
  it('binds the optional echo to this single-use session and expires at the boundary', () => {
    expect(inviteFingerprint(invite(high, '9'.repeat(64)))).not.toBe(inviteFingerprint(own));
    expect(mayAutoAcceptHandshake({ ...proof, now: now + 120 })).toBe(false);
    expect(mayAutoAcceptHandshake({ ...proof, request: { ...request, createdAt: now + 3 } })).toBe(false);
    expect(validHandshakeScan(own, proof.scanned, now + 120)).toBe(false);
  });
  it('round trips a caption-free envelope, rejecting malformed, long-lived and expired input', () => {
    expect(readHandshakeQR(handshakeQR(peer, own), now + 2)).toEqual(proof.scanned);
    expect(readHandshakeQR(handshakeQR({ ...peer, caption: 'Private name' }), now)).toBeNull();
    expect(readHandshakeQR(handshakeQR({ ...peer, expiresAt: now + 121 }), now)).toBeNull();
    expect(readHandshakeQR(handshakeQR(peer), now + 120)).toBeNull();
    expect(readHandshakeQR(JSON.stringify({ handshake: 1, invite: peer, echo: 42 }), now)).toBeNull();
    expect(readHandshakeQR('x'.repeat(8193), now)).toBeNull();
    expect(readHandshakeQR('{"handshake":1,"invite":null}', now)).toBeNull();
  });
});
