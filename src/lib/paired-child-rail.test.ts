import { describe, it, expect } from 'vitest';
import { childRailRelay, childRailExtraRelays, guardianRailPubkey, guardianToChildRelays, publishesToChildOn } from './paired-child-rail';
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

describe('A56: guardian→child relays', () => {
  const direct = (railRelay?: string) => ({ childDevice: { mode: 'heartwood-direct' as const, railRelay } });

  it('childRailRelay: a direct dependant\'s valid rail relay, else null', () => {
    expect(childRailRelay(direct('wss://rail.example'))).toBe('wss://rail.example');
    expect(childRailRelay(direct())).toBeNull();
    expect(childRailRelay(direct('http://evil.example'))).toBeNull();
    expect(childRailRelay({})).toBeNull();
  });

  it('adds the rail relay to what the publisher uses today, once', () => {
    expect(guardianToChildRelays(direct('wss://rail.example'), ['wss://a.example'])).toEqual(['wss://a.example', 'wss://rail.example']);
    expect(guardianToChildRelays(direct('wss://a.example'), ['wss://a.example'])).toEqual(['wss://a.example']);
  });

  it('a legacy dependant, or an older direct record with no rail relay, keeps exactly today\'s relays', () => {
    expect(guardianToChildRelays({}, ['wss://a.example', 'wss://b.example'])).toEqual(['wss://a.example', 'wss://b.example']);
    expect(guardianToChildRelays(direct(), ['wss://a.example'])).toEqual(['wss://a.example']);
  });
});

describe('A56: one connection per relay, per-dependant routing', () => {
  const direct = (railRelay?: string) => ({ childDevice: { mode: 'heartwood-direct' as const, railRelay } });
  const BASE = 'wss://a.example';

  it('childRailExtraRelays: the distinct rail relays not already the base relay', () => {
    expect(childRailExtraRelays([direct('wss://r1.example'), direct(BASE), {}, direct('wss://r1.example'), direct('wss://r2.example')], BASE))
      .toEqual(['wss://r1.example', 'wss://r2.example']);
  });

  it('publishesToChildOn: every dependant on the base relay; on a rail relay only the children that read there', () => {
    expect(publishesToChildOn({}, BASE, BASE)).toBe(true);
    expect(publishesToChildOn(direct('wss://r1.example'), BASE, BASE)).toBe(true);
    expect(publishesToChildOn(direct('wss://r1.example'), 'wss://r1.example', BASE)).toBe(true);
    expect(publishesToChildOn({}, 'wss://r1.example', BASE)).toBe(false);
    expect(publishesToChildOn(direct('wss://r2.example'), 'wss://r1.example', BASE)).toBe(false);
  });
});
