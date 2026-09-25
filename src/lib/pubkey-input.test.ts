import { describe, it, expect } from 'vitest';
import { parsePubkeyInput } from './pubkey-input';
import { encodeNpub, hexToBytes } from './signet';

const HEX = 'a'.repeat(64);
const NPUB = encodeNpub(hexToBytes(HEX));

describe('parsePubkeyInput', () => {
  it('accepts a 64-char lowercase hex key', () => {
    expect(parsePubkeyInput(HEX)).toEqual({ hex: HEX });
  });

  it('normalises uppercase hex to lowercase', () => {
    expect(parsePubkeyInput('A'.repeat(64))).toEqual({ hex: HEX });
  });

  it('trims whitespace around hex', () => {
    expect(parsePubkeyInput(`  ${HEX}\n`)).toEqual({ hex: HEX });
  });

  it('accepts an npub and returns its hex', () => {
    expect(NPUB.startsWith('npub1')).toBe(true);
    expect(parsePubkeyInput(NPUB)).toEqual({ hex: HEX });
  });

  it('trims whitespace around an npub', () => {
    expect(parsePubkeyInput(`  ${NPUB}  `)).toEqual({ hex: HEX });
  });

  it('rejects a malformed npub with an error', () => {
    const r = parsePubkeyInput('npub1notavalidnpubatall');
    expect('error' in r).toBe(true);
  });

  it('rejects an nsec (wrong bech32 type) with an error', () => {
    // An nsec decodes but is not a 32-byte pubkey path — must not be accepted.
    const r = parsePubkeyInput('nsec1' + 'q'.repeat(58));
    expect('error' in r).toBe(true);
  });

  it('rejects empty / whitespace input', () => {
    expect('error' in parsePubkeyInput('   ')).toBe(true);
  });

  it('rejects too-short hex', () => {
    expect('error' in parsePubkeyInput('abcdef')).toBe(true);
  });

  it('rejects 64 chars that are not hex', () => {
    expect('error' in parsePubkeyInput('z'.repeat(64))).toBe(true);
  });
});
