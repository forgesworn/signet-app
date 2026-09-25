import { describe, it, expect } from 'vitest';
import {
  CHARTER_CONSUMERS,
  getCharterConsumer,
  getCharterConsumerByPubkey,
  isRegisteredCharterConsumer,
} from './charter-consumer-registry';

const AXENSTAX_PUBKEY = 'bf15b55e730208dc7e149b9b79908c8d81d675c745063c0204b6428d8c6399c1';

describe('Charter consumer registry', () => {
  it('exposes the AxeNStax alpha entry', () => {
    const axe = getCharterConsumer('axenstax');
    expect(axe).not.toBeNull();
    expect(axe!.pubkey).toBe(AXENSTAX_PUBKEY);
    expect(axe!.label).toMatch(/AxeNStax/);
  });

  it('every registered pubkey is a 64-char lowercase hex string', () => {
    const HEX64 = /^[0-9a-f]{64}$/;
    for (const c of CHARTER_CONSUMERS) {
      expect(c.pubkey).toMatch(HEX64);
    }
  });

  it('every entry has a unique stable name', () => {
    const names = CHARTER_CONSUMERS.map((c) => c.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('every entry has a unique pubkey', () => {
    const keys = CHARTER_CONSUMERS.map((c) => c.pubkey);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it('returns null for unknown names', () => {
    expect(getCharterConsumer('not-a-consumer')).toBeNull();
  });

  it('reverse-lookup matches the AxeNStax pubkey case-insensitively', () => {
    const axe = getCharterConsumerByPubkey(AXENSTAX_PUBKEY);
    expect(axe).not.toBeNull();
    expect(axe!.name).toBe('axenstax');

    const upper = getCharterConsumerByPubkey(AXENSTAX_PUBKEY.toUpperCase());
    expect(upper).not.toBeNull();
    expect(upper!.name).toBe('axenstax');
  });

  it('reverse-lookup returns null for non-registered keys', () => {
    expect(getCharterConsumerByPubkey('a'.repeat(64))).toBeNull();
  });

  it('isRegisteredCharterConsumer is true for AxeNStax, false otherwise', () => {
    expect(isRegisteredCharterConsumer(AXENSTAX_PUBKEY)).toBe(true);
    expect(isRegisteredCharterConsumer('a'.repeat(64))).toBe(false);
  });
});
