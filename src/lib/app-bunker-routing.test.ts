import { describe, it, expect } from 'vitest';
import {
  sanitiseAppLabel,
  extractAppOrigin,
  parseConnectMetadata,
  pairingMatches,
} from './app-bunker-routing';
import type { TrustedAppPairing } from '../types';

describe('sanitiseAppLabel', () => {
  it('returns the fallback for non-string input', () => {
    expect(sanitiseAppLabel(undefined)).toBe('App');
    expect(sanitiseAppLabel(null)).toBe('App');
    expect(sanitiseAppLabel(42)).toBe('App');
    expect(sanitiseAppLabel({})).toBe('App');
  });

  it('honours a custom fallback', () => {
    expect(sanitiseAppLabel(undefined, 'Unknown')).toBe('Unknown');
  });

  it('strips control + bidi chars, trims, and caps at 100', () => {
    expect(sanitiseAppLabel('  Fathom  ')).toBe('Fathom');
    expect(sanitiseAppLabel('Fath‎om')).toBe('Fathom');
    expect(sanitiseAppLabel('A'.repeat(150)).length).toBe(100);
    // RTL override is stripped.
    expect(sanitiseAppLabel('app‮')).toBe('app');
  });

  it('falls back when input is empty after sanitising', () => {
    expect(sanitiseAppLabel('   ')).toBe('App');
    expect(sanitiseAppLabel('‮')).toBe('App');
  });
});

describe('extractAppOrigin', () => {
  it('returns the origin for https URLs', () => {
    expect(extractAppOrigin('https://fathom.example/path?q=1')).toBe('https://fathom.example');
  });

  it('accepts http://localhost and 127.0.0.1', () => {
    expect(extractAppOrigin('http://localhost:5174/foo')).toBe('http://localhost:5174');
    expect(extractAppOrigin('http://127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080');
  });

  it('rejects anything else', () => {
    expect(extractAppOrigin('http://example.com')).toBeUndefined();
    expect(extractAppOrigin('javascript:alert(1)')).toBeUndefined();
    expect(extractAppOrigin('not a url')).toBeUndefined();
    expect(extractAppOrigin(undefined)).toBeUndefined();
    expect(extractAppOrigin(123)).toBeUndefined();
  });
});

describe('parseConnectMetadata', () => {
  it('returns the default label when input is empty / non-string', () => {
    expect(parseConnectMetadata(undefined)).toEqual({ label: 'App' });
    expect(parseConnectMetadata('')).toEqual({ label: 'App' });
    expect(parseConnectMetadata(42)).toEqual({ label: 'App' });
  });

  it('returns the default label when input is invalid JSON', () => {
    expect(parseConnectMetadata('{not json')).toEqual({ label: 'App' });
  });

  it('extracts label + origin from a typical metadata blob', () => {
    const blob = JSON.stringify({ name: 'Fathom', url: 'https://fathom.example' });
    expect(parseConnectMetadata(blob)).toEqual({ label: 'Fathom', origin: 'https://fathom.example' });
  });

  it('drops a non-https url silently', () => {
    const blob = JSON.stringify({ name: 'X', url: 'http://attacker.example' });
    expect(parseConnectMetadata(blob)).toEqual({ label: 'X', origin: undefined });
  });

  it('returns the default label for an oversized metadata blob (DoS bound — security audit 2026-06-15)', () => {
    const blob = JSON.stringify({ name: 'Y'.repeat(5000) });
    expect(parseConnectMetadata(blob)).toEqual({ label: 'App' });
  });
});

describe('pairingMatches', () => {
  function pairing(clientPubkey: string): TrustedAppPairing {
    return { clientPubkey, label: 'A', pairedAt: 0 };
  }

  it('returns false for an empty list', () => {
    expect(pairingMatches([], 'aa'.repeat(32))).toBe(false);
  });

  it('returns true on case-insensitive match', () => {
    const pairings = [pairing('aa'.repeat(32))];
    expect(pairingMatches(pairings, 'AA'.repeat(32))).toBe(true);
  });

  it('returns false when no entry matches', () => {
    const pairings = [pairing('aa'.repeat(32))];
    expect(pairingMatches(pairings, 'bb'.repeat(32))).toBe(false);
  });

  it('tolerates malformed entries', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pairings = [{ clientPubkey: undefined } as any, pairing('aa'.repeat(32))];
    expect(pairingMatches(pairings, 'aa'.repeat(32))).toBe(true);
  });
});
