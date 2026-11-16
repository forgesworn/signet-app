import { describe, it, expect } from 'vitest';
import { guardianRailPubkey } from './paired-child-rail';
import { extractEndpointPubkey } from './dependant-status-sync';

const RAIL = 'a'.repeat(64);
const PERSONA = 'b'.repeat(64);
const ENDPOINT = 'e'.repeat(64);

describe('guardianRailPubkey', () => {
  it('a direct record gives its rail key, never the bound persona in bunkerUri', () => {
    expect(guardianRailPubkey({ mode: 'heartwood-direct', railPubkey: RAIL, bunkerUri: `bunker://${PERSONA}?relay=wss%3A%2F%2Fhw.example` })).toBe(RAIL);
  });

  it('a direct record with a missing or malformed rail key gives null, with no bunkerUri fallback', () => {
    const bunkerUri = `bunker://${PERSONA}?relay=wss%3A%2F%2Fhw.example`;
    expect(guardianRailPubkey({ mode: 'heartwood-direct', bunkerUri })).toBeNull();
    expect(guardianRailPubkey({ mode: 'heartwood-direct', railPubkey: 'not-hex', bunkerUri })).toBeNull();
    expect(guardianRailPubkey({ mode: 'heartwood-direct', railPubkey: RAIL.toUpperCase(), bunkerUri })).toBeNull();
  });

  it('a legacy record gives exactly what extractEndpointPubkey gives', () => {
    for (const bunkerUri of [
      `bunker://${ENDPOINT}?relay=wss%3A%2F%2Frelay.example&secret=s`,
      `BUNKER://${ENDPOINT.toUpperCase()}?relay=x`,
      `bunker://${ENDPOINT}`,
      'nostrconnect://x',
      '',
    ]) {
      expect(guardianRailPubkey({ bunkerUri })).toBe(extractEndpointPubkey(bunkerUri));
      expect(guardianRailPubkey({ mode: 'phone', bunkerUri, railPubkey: RAIL })).toBe(extractEndpointPubkey(bunkerUri));
    }
  });
});
