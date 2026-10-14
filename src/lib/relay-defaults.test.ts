import { describe, expect, it } from 'vitest';
import { defaultRelays, migrateRelayPreferences } from './relay-defaults';
const retired = 'wss://relay.trotters.cc';
const relay = (url: string) => ({ url, enabled: true, read: true, write: true });

describe('retired default relay migration', () => {
  it('replaces an old single-relay install with the full remaining pool', () => {
    const prefs = migrateRelayPreferences({ id: 'current', theme: 'dark', relayUrl: retired });
    expect(prefs).toMatchObject({ id: 'current', theme: 'dark', relayUrl: 'wss://nos.lol', relays: defaultRelays() });
    expect(migrateRelayPreferences(prefs)).toBe(prefs);
  });
  it('removes Trotters while preserving custom relay flags and all other preferences', () => {
    const custom = { ...relay('wss://custom.example'), write: false };
    const prefs = migrateRelayPreferences({ relayUrl: retired + '/', relays: [relay(retired), custom, relay('wss://nos.lol')], fallbackBunkerRelays: [retired, 'wss://backup.example'], bunkerUri: 'encrypted-secret', theme: 'dark' });
    expect(prefs).toMatchObject({ relayUrl: 'wss://nos.lol', relays: [custom, relay('wss://nos.lol')], fallbackBunkerRelays: ['wss://backup.example'], bunkerUri: 'encrypted-secret', theme: 'dark' });
  });
  it('does not alter settings with no retired relay', () => {
    for (const prefs of [{}, { relayUrl: 'wss://custom.example' }, { relays: [{ ...relay('wss://nos.lol'), enabled: false }] }]) expect(migrateRelayPreferences(prefs)).toBe(prefs);
  });
});
