import { describe, it, expect, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bindHeartwoodKey, parseHeartwoodKeyUri, HEARTWOOD_KEY_CHECK_KIND, HeartwoodKeyMismatchError } from './heartwood-key-persona';
import type { BunkerSigningBackend, DecryptingSigningBackend } from './signing-backend';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const uriFor = (pubkey: string, extra = '&secret=abc123') => `bunker://${pubkey}?relay=wss://relay.primal.net${extra}`;

function binder(answersAs: string) {
  const b = {
    activePublicKeyHex: '',
    connect: vi.fn(async () => { b.activePublicKeyHex = answersAs; }),
    destroy: vi.fn(),
  };
  return b;
}

function route(signWith: Uint8Array = sk) {
  return {
    signEvent: vi.fn(async (e: UnsignedEvent) => finalizeEvent({ kind: e.kind, created_at: e.created_at, tags: e.tags, content: e.content }, signWith) as unknown as NostrEvent),
  };
}

describe('parseHeartwoodKeyUri', () => {
  it('needs an endpoint, a wss relay and a pairing secret', () => {
    expect(parseHeartwoodKeyUri(uriFor(pk))).toEqual({ pubkey: pk, relays: ['wss://relay.primal.net'] });
    expect(parseHeartwoodKeyUri(uriFor(pk, ''))).toBeNull();
    expect(parseHeartwoodKeyUri(`bunker://${pk}?secret=x`)).toBeNull();
    expect(parseHeartwoodKeyUri('nostrconnect://abc')).toBeNull();
    expect(parseHeartwoodKeyUri(uriFor(pk.toUpperCase()))?.pubkey).toBe(pk);
  });
});

describe('bindHeartwoodKey', () => {
  it('binds with connect, then signs a check through the route the app uses', async () => {
    const b = binder(pk);
    const r = route();
    const got = await bindHeartwoodKey(uriFor(pk), {
      makeBinder: () => b as unknown as BunkerSigningBackend,
      routeFor: (p) => (p === pk ? r as unknown as DecryptingSigningBackend : null),
      timeoutMs: 1000,
    });
    expect(got).toBe(pk);
    expect(b.connect).toHaveBeenCalledWith(uriFor(pk), 1000);
    expect(b.destroy).toHaveBeenCalled();
    const sent = r.signEvent.mock.calls[0][0];
    expect(sent.kind).toBe(HEARTWOOD_KEY_CHECK_KIND);
    expect(sent.tags[0]).toEqual(['relay', 'wss://heartwood-check.invalid']);
  });

  it('refuses when the device answers as another key, and never signs', async () => {
    const b = binder('f'.repeat(64));
    const r = route();
    await expect(bindHeartwoodKey(uriFor(pk), {
      makeBinder: () => b as unknown as BunkerSigningBackend,
      routeFor: () => r as unknown as DecryptingSigningBackend,
      timeoutMs: 1000,
    })).rejects.toBeInstanceOf(HeartwoodKeyMismatchError);
    expect(b.destroy).toHaveBeenCalled();
    expect(r.signEvent).not.toHaveBeenCalled();
  });

  it('refuses a check signed by a different key', async () => {
    await expect(bindHeartwoodKey(uriFor(pk), {
      makeBinder: () => binder(pk) as unknown as BunkerSigningBackend,
      routeFor: () => route(generateSecretKey()) as unknown as DecryptingSigningBackend,
      timeoutMs: 1000,
    })).rejects.toBeInstanceOf(HeartwoodKeyMismatchError);
  });

  it('tears the binder down when connect fails', async () => {
    const b = binder(pk);
    b.connect.mockRejectedValueOnce(new Error('Connection timed out'));
    await expect(bindHeartwoodKey(uriFor(pk), {
      makeBinder: () => b as unknown as BunkerSigningBackend,
      routeFor: () => route() as unknown as DecryptingSigningBackend,
      timeoutMs: 1000,
    })).rejects.toThrow('Connection timed out');
    expect(b.destroy).toHaveBeenCalled();
  });
});
