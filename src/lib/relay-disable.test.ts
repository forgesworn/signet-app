import { describe, expect, it } from 'vitest';
import { relayListWithDisabled } from './relay-disable';
import { defaultRelays } from './relay-defaults';
import type { RelayConfig } from '../types';

const r = (url: string, over: Partial<RelayConfig> = {}): RelayConfig => ({ url, enabled: true, read: true, write: true, ...over });
const A = 'wss://a.example', B = 'wss://b.example', C = 'wss://c.example';

describe('relayListWithDisabled', () => {
  it('switches the relay off without removing it or touching the others', () => {
    const relays = [r(A), r(B, { write: false }), r(C)];
    expect(relayListWithDisabled({ relays }, C)).toEqual([r(A), r(B, { write: false }), r(C, { enabled: false })]);
    expect(relays[2].enabled).toBe(true);
  });
  it('refuses the last enabled write relay', () => {
    expect(relayListWithDisabled({ relays: [r(A), r(B, { write: false })] }, A)).toBeNull();
    expect(relayListWithDisabled({ relays: [r(A), r(B, { enabled: false })] }, A)).toBeNull();
  });
  it('refuses a relay that is not in the list or is already off', () => {
    expect(relayListWithDisabled({ relays: [r(A), r(B)] }, C)).toBeNull();
    expect(relayListWithDisabled({ relays: [r(A), r(B, { enabled: false })] }, B)).toBeNull();
  });
  it('materialises the defaults when no list is stored', () => {
    const damus = 'wss://relay.damus.io';
    const next = relayListWithDisabled({}, damus)!;
    expect(next.map(x => x.url)).toEqual(defaultRelays().map(x => x.url));
    expect(next.find(x => x.url === damus)).toMatchObject({ enabled: false });
    expect(next.filter(x => x.enabled)).toHaveLength(defaultRelays().length - 1);
    expect(relayListWithDisabled({ relays: [] }, damus)).not.toBeNull();
  });
  it('leaves a legacy single-relay install alone, even when its relay is also a default', () => {
    expect(relayListWithDisabled({ relayUrl: 'wss://relay.damus.io' }, 'wss://relay.damus.io')).toBeNull();
  });
  it('works from the migrated list, so a retired relay never counts', () => {
    const next = relayListWithDisabled({ relayUrl: 'wss://nos.lol', relays: [r('wss://nos.lol'), r(A), r(B)] }, A);
    expect(next?.some(x => x.url === 'wss://nos.lol')).toBe(false);
    expect(next?.find(x => x.url === A)).toMatchObject({ enabled: false });
  });
});
