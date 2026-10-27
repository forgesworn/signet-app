import { describe, expect, it } from 'vitest';
import { defaultRelays, migrateRelayPreferences, PRODUCTION_RELAY_URL } from './relay-defaults';
const retired = 'wss://relay.trotters.cc';
const nosLol = 'wss://nos.lol';
const primal = 'wss://relay.primal.net';
const relay = (url: string) => ({ url, enabled: true, read: true, write: true });

describe('retired default relay migration', () => {
  it('uses relay.primal.net as the production relay and first default', () => {
    expect(PRODUCTION_RELAY_URL).toBe(primal);
    expect(defaultRelays().map(r => r.url)).toEqual([primal, 'wss://relay.damus.io', 'wss://relay.ditto.pub']);
    expect(defaultRelays().every(r => r.write)).toBe(true);
  });
  it('replaces an old single-relay install with the full remaining pool', () => {
    const prefs = migrateRelayPreferences({ id: 'current', theme: 'dark', relayUrl: retired });
    expect(prefs).toMatchObject({ id: 'current', theme: 'dark', relayUrl: primal, relays: defaultRelays() });
    expect(migrateRelayPreferences(prefs)).toBe(prefs);
  });
  it('removes Trotters while preserving custom relay flags and all other preferences', () => {
    const custom = { ...relay('wss://custom.example'), write: false };
    const prefs = migrateRelayPreferences({ relayUrl: retired + '/', relays: [relay(retired), custom, relay('wss://relay.damus.io')], fallbackBunkerRelays: [retired, 'wss://backup.example'], bunkerUri: 'encrypted-secret', theme: 'dark' });
    expect(prefs).toMatchObject({ relayUrl: primal, relays: [relay(primal), custom, relay('wss://relay.damus.io')], fallbackBunkerRelays: ['wss://backup.example'], bunkerUri: 'encrypted-secret', theme: 'dark' });
  });
  it('moves a persisted old default pool to primal-first', () => {
    const old = [nosLol, 'wss://relay.damus.io', primal, 'wss://relay.ditto.pub'].map(relay);
    old.push({ ...relay('wss://relay.nostr.band'), write: false });
    const prefs = migrateRelayPreferences({ relayUrl: nosLol, relays: old, fallbackBunkerRelays: [nosLol, 'wss://relay.damus.io'] });
    expect(prefs.relayUrl).toBe(primal);
    expect(prefs.relays!.map(r => r.url)).toEqual([primal, 'wss://relay.damus.io', 'wss://relay.ditto.pub', 'wss://relay.nostr.band']);
    expect(prefs.relays![3]).toMatchObject({ write: false });
    expect(prefs.fallbackBunkerRelays).toEqual(['wss://relay.damus.io']);
  });
  it('prepends primal when the pool lacks it and keeps the rest in order', () => {
    const prefs = migrateRelayPreferences({ relayUrl: nosLol + '/', relays: [relay('wss://a.example'), relay(nosLol), relay('wss://b.example')] });
    expect(prefs.relayUrl).toBe(primal);
    expect(prefs.relays!.map(r => r.url)).toEqual([primal, 'wss://a.example', 'wss://b.example']);
  });
  it('keeps a custom primary and just drops nos.lol from the pool', () => {
    const prefs = migrateRelayPreferences({ relayUrl: 'wss://custom.example', relays: [relay('wss://custom.example'), relay(nosLol), relay(primal)] });
    expect(prefs.relayUrl).toBe('wss://custom.example');
    expect(prefs.relays!.map(r => r.url)).toEqual(['wss://custom.example', primal]);
  });
  it('is idempotent', () => {
    const once = migrateRelayPreferences({ relayUrl: nosLol, relays: [relay(nosLol), relay('wss://relay.damus.io')], fallbackBunkerRelays: [nosLol] });
    expect(migrateRelayPreferences(once)).toBe(once);
  });
  it('does not alter settings with no retired relay', () => {
    for (const prefs of [{}, { relayUrl: 'wss://custom.example' }, { relays: [{ ...relay('wss://nostr.oxtr.dev'), enabled: false }] }]) expect(migrateRelayPreferences(prefs)).toBe(prefs);
  });
});
