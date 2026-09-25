import { describe, it, expect } from 'vitest';
import { buildAuthFlowBunkerUrl, buildPhoneBunkerUrl } from './bunker-url';

const VALID_PK = 'a'.repeat(64);

describe('buildPhoneBunkerUrl', () => {
  it('builds a standard bunker:// URL with url-encoded relay', () => {
    const url = buildPhoneBunkerUrl(VALID_PK, 'wss://relay.example.com');
    expect(url).toBe(`bunker://${VALID_PK}?relay=wss%3A%2F%2Frelay.example.com`);
  });

  it('lowercases mixed-case pubkey input', () => {
    const mixed = 'A'.repeat(64);
    const url = buildPhoneBunkerUrl(mixed, 'wss://relay.example.com');
    expect(url?.startsWith(`bunker://${VALID_PK}?`)).toBe(true);
  });

  it('returns null when pubkey missing', () => {
    expect(buildPhoneBunkerUrl(null, 'wss://relay.example.com')).toBeNull();
    expect(buildPhoneBunkerUrl(undefined, 'wss://relay.example.com')).toBeNull();
    expect(buildPhoneBunkerUrl('', 'wss://relay.example.com')).toBeNull();
  });

  it('returns null when relay missing', () => {
    expect(buildPhoneBunkerUrl(VALID_PK, null)).toBeNull();
    expect(buildPhoneBunkerUrl(VALID_PK, undefined)).toBeNull();
    expect(buildPhoneBunkerUrl(VALID_PK, '')).toBeNull();
  });

  it('rejects pubkey that is not 64-char hex', () => {
    expect(buildPhoneBunkerUrl('xyz', 'wss://relay.example.com')).toBeNull();
    expect(buildPhoneBunkerUrl('a'.repeat(63), 'wss://relay.example.com')).toBeNull();
    expect(buildPhoneBunkerUrl('a'.repeat(65), 'wss://relay.example.com')).toBeNull();
    // 64 chars but non-hex
    expect(buildPhoneBunkerUrl('z'.repeat(64), 'wss://relay.example.com')).toBeNull();
  });

  it('rejects http/https/file relay schemes', () => {
    expect(buildPhoneBunkerUrl(VALID_PK, 'https://relay.example.com')).toBeNull();
    expect(buildPhoneBunkerUrl(VALID_PK, 'http://relay.example.com')).toBeNull();
    expect(buildPhoneBunkerUrl(VALID_PK, 'file:///etc/passwd')).toBeNull();
  });

  it('accepts ws://localhost and ws://127.0.0.1 for local dev', () => {
    expect(buildPhoneBunkerUrl(VALID_PK, 'ws://localhost:7777')).toBe(`bunker://${VALID_PK}?relay=ws%3A%2F%2Flocalhost%3A7777`);
    expect(buildPhoneBunkerUrl(VALID_PK, 'ws://127.0.0.1:7777')).toBe(`bunker://${VALID_PK}?relay=ws%3A%2F%2F127.0.0.1%3A7777`);
  });

  it('rejects ws:// non-localhost', () => {
    expect(buildPhoneBunkerUrl(VALID_PK, 'ws://relay.example.com')).toBeNull();
  });
});

describe('buildAuthFlowBunkerUrl', () => {
  it('builds an auth-flow bunker URL with all valid relays in order', () => {
    const url = buildAuthFlowBunkerUrl(VALID_PK, [
      'wss://relay.damus.io',
      'wss://relay.trotters.cc',
      'wss://relay.damus.io',
      'https://bad.example.com',
    ], 'pairing-secret');

    expect(url).toBe(`bunker://${VALID_PK}?relay=wss%3A%2F%2Frelay.damus.io&relay=wss%3A%2F%2Frelay.trotters.cc&secret=pairing-secret`);
  });

  it('returns null when no supplied relay is usable', () => {
    expect(buildAuthFlowBunkerUrl(VALID_PK, ['https://bad.example.com'], 'pairing-secret')).toBeNull();
  });
});
