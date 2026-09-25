import { describe, it, expect } from 'vitest';
import { parseHeartwoodIdentities, pickOwnerIdentities, purposeIs } from './heartwood-identities';

const MASTER = 'da'.repeat(32);
const NP = '2e'.repeat(32);
const PERSONA = '3f'.repeat(32);
const DEP = '35'.repeat(32);

const LIST = JSON.stringify([
  { npub: 'npub1x', pubkey: MASTER, purpose: 'master', index: 0 },
  { npub: 'npub1y', pubkey: NP.toUpperCase(), purpose: 'nostr:persona:natural-person', index: 0, personaName: 'natural-person' },
  { npub: 'npub1z', pubkey: PERSONA, purpose: 'nostr:persona:persona', index: 0 },
  { npub: 'npub1w', pubkey: DEP, purpose: 'nostr:persona:dependant-0-np', index: 0 },
  { pubkey: 'nothex', purpose: 'nostr:persona:persona', index: 1 },
  { pubkey: PERSONA, purpose: 42 },
]);

describe('parseHeartwoodIdentities', () => {
  it('parses rows, lowercases pubkeys, drops malformed', () => {
    const rows = parseHeartwoodIdentities(LIST);
    expect(rows.map(r => r.purpose)).toEqual(['master', 'nostr:persona:natural-person', 'nostr:persona:persona', 'nostr:persona:dependant-0-np']);
    expect(rows[1].pubkey).toBe(NP);
    expect(rows[1].personaName).toBe('natural-person');
  });
  it('accepts the { identities: [...] } wrapper (heartwood_recover shape)', () => {
    expect(parseHeartwoodIdentities(JSON.stringify({ recovered: 1, identities: [{ pubkey: NP, purpose: 'nostr:persona:natural-person', index: 0 }] }))).toHaveLength(1);
  });
  it('returns [] on garbage', () => {
    expect(parseHeartwoodIdentities('nope')).toEqual([]);
    expect(parseHeartwoodIdentities('{}')).toEqual([]);
  });
});

describe('pickOwnerIdentities', () => {
  it('picks natural-person + persona (index 0), ignores dependants and the master', () => {
    expect(pickOwnerIdentities(parseHeartwoodIdentities(LIST))).toEqual({ naturalPerson: NP, persona: PERSONA });
  });
  it('is empty on a device serving no personas', () => {
    expect(pickOwnerIdentities([{ pubkey: MASTER, purpose: 'master', index: 0 }])).toEqual({});
  });
  it('prefers index 0 when several exist', () => {
    const list = [
      { pubkey: DEP, purpose: 'nostr:persona:persona', index: 2 },
      { pubkey: PERSONA, purpose: 'nostr:persona:persona', index: 0 },
    ];
    expect(pickOwnerIdentities(list).persona).toBe(PERSONA);
  });
  it('purposeIs matches bare and prefixed names but not suffix-of-other-name', () => {
    expect(purposeIs('nostr:persona:natural-person', 'natural-person')).toBe(true);
    expect(purposeIs('natural-person', 'natural-person')).toBe(true);
    expect(purposeIs('nostr:persona:dependant-0-persona', 'persona')).toBe(false);
  });
});
