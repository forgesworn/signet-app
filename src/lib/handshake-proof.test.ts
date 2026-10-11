import { describe, expect, it } from 'vitest';
import { createContactRequest, encodeContactInvite } from '@forgesworn/signet-contacts';
import type { ContactInvite } from '@forgesworn/signet-contacts';
import { handshakeRole, mayAutoAcceptHandshake, readHandshakeCode } from './handshake-proof';
import { sessionQR } from './handshake-reveal';
const low = '1'.repeat(64), high = '2'.repeat(64), now = 1700000000;
const invite = (recipient: string, secret = '3'.repeat(64)): ContactInvite => ({ v: 1, recipient, secret, relays: ['wss://relay.example/'], expiresAt: now + 120 });
const own = invite(high), peer = invite(low, '4'.repeat(64));
const request = createContactRequest({ id: '5'.repeat(32), from: low, to: high, nonce: '6'.repeat(64), reply: { secret: '7'.repeat(64), relays: own.relays }, now: now + 1, expiresAt: now + 120 });
const proof = { own, scanned: { invite: peer }, request, now: now + 2, receivedOnOwnInvite: true };
describe('handshake proof', () => {
  it('assigns exactly one sender, refusing self and malformed keys', () => {
    expect(handshakeRole(low, high)).toBe('requester'); expect(handshakeRole(high, low)).toBe('recipient');
    expect(handshakeRole(low, low)).toBeNull(); expect(handshakeRole('npub', high)).toBeNull();
  });
  it('requires our single-use invitation AND the signature-verified request from the camera-bound key', () => {
    expect(mayAutoAcceptHandshake(proof)).toBe(true);
    expect(mayAutoAcceptHandshake({ ...proof, receivedOnOwnInvite: false })).toBe(false);
    expect(mayAutoAcceptHandshake({ ...proof, request: { ...request, from: '8'.repeat(64) } })).toBe(false);
    expect(mayAutoAcceptHandshake({ ...proof, request: { ...request, to: low } })).toBe(false);
    expect(mayAutoAcceptHandshake({ ...proof, own: peer, scanned: { invite: own } })).toBe(false);
  });
  it('expires at the boundary', () => {
    expect(mayAutoAcceptHandshake({ ...proof, now: now + 120 })).toBe(false);
    expect(mayAutoAcceptHandshake({ ...proof, request: { ...request, createdAt: now + 3 } })).toBe(false);
  });
});
describe('what the handshake camera read', () => {
  it('reads a session code, which names no one', () => {
    const raw = sessionQR({ publicKey: '9'.repeat(64), expiresAt: now + 120, relays: ['wss://relay.example/'] })!;
    expect(readHandshakeCode(raw, now)).toEqual({ kind: 'session', card: { publicKey: '9'.repeat(64), expiresAt: now + 120, relays: ['wss://relay.example/'] } });
  });
  it('refuses a code from an older build, which would show a persona key', () => {
    expect(readHandshakeCode('SGH1:ABCDEF', now)).toEqual({ kind: 'outdated' });
    expect(readHandshakeCode(JSON.stringify({ handshake: 1, invite: peer }), now)).toEqual({ kind: 'outdated' });
  });
  it('takes a plain invite link only for the one-way check, and nothing malformed or unbounded', () => {
    expect(readHandshakeCode(encodeContactInvite(peer), now)).toEqual({ kind: 'invite', invite: peer });
    expect(readHandshakeCode('x'.repeat(8193), now)).toBeNull();
    expect(readHandshakeCode('not a code', now)).toBeNull();
  });
});
