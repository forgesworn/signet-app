// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  normaliseLeadPubkeys,
  generateSignetJson,
} from './signet-json';

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);

describe('normaliseLeadPubkeys', () => {
  it('returns a 1-element array when headPubkey (string) is set', () => {
    expect(normaliseLeadPubkeys({ headPubkey: PUBKEY_A })).toEqual([PUBKEY_A]);
  });

  it('returns the array when headPubkeys (array) is set', () => {
    expect(normaliseLeadPubkeys({ headPubkeys: [PUBKEY_A, PUBKEY_B] })).toEqual([PUBKEY_A, PUBKEY_B]);
  });

  it('returns union when both headPubkey and headPubkeys are present', () => {
    const result = normaliseLeadPubkeys({ headPubkey: PUBKEY_A, headPubkeys: [PUBKEY_B] });
    expect(result).toContain(PUBKEY_A);
    expect(result).toContain(PUBKEY_B);
    expect(result.length).toBe(2);
  });

  it('deduplicates when headPubkey appears in headPubkeys', () => {
    const result = normaliseLeadPubkeys({ headPubkey: PUBKEY_A, headPubkeys: [PUBKEY_A, PUBKEY_B] });
    expect(result.filter(p => p === PUBKEY_A).length).toBe(1);
  });

  it('throws when both fields are absent', () => {
    expect(() => normaliseLeadPubkeys({})).toThrow();
  });

  it('throws when headPubkeys is empty', () => {
    expect(() => normaliseLeadPubkeys({ headPubkeys: [] })).toThrow();
  });

  it('throws when headPubkeys has more than 10 entries (sanity cap)', () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => String(i).repeat(64).slice(0, 64));
    expect(() => normaliseLeadPubkeys({ headPubkeys: tooMany })).toThrow();
  });
});

describe('generateSignetJson — multi-lead emit', () => {
  const baseOpts = {
    professionKind: 'school' as const,
    entityName: 'Springfield School',
    identifier: '100000',
    identifierKind: 'URN' as const,
    canonicalDomain: 'springfield-school.example',
    relays: ['wss://relay.forgesworn.dev'],
    publishedAt: '2026-09-01T00:00:00Z',
  };

  it('emits headPubkey (singular string) when leadPubkeyNpubs has 1 entry', () => {
    const json = generateSignetJson({ ...baseOpts, leadPubkeyNpubs: ['npub1' + 'a'.repeat(59)] });
    const parsed = JSON.parse(json);
    expect(typeof parsed.headPubkey).toBe('string');
    expect(parsed.headPubkeys).toBeUndefined();
  });

  it('emits headPubkeys (array) when leadPubkeyNpubs has 2+ entries', () => {
    const json = generateSignetJson({
      ...baseOpts,
      leadPubkeyNpubs: ['npub1' + 'a'.repeat(59), 'npub1' + 'b'.repeat(59)],
    });
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed.headPubkeys)).toBe(true);
    expect(parsed.headPubkey).toBeUndefined();
  });
});
