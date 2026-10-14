import type { AppPreferences, RelayConfig } from '../types';
import { isNativeApp } from './native';
import { isValidRelayUrl } from './relay-url';

export const PRODUCTION_RELAY_URL = 'wss://nos.lol';
// Capacitor also serves from localhost; only a browser dev server uses this.
export const DEFAULT_RELAY_URL = typeof window !== 'undefined' && window.location?.hostname === 'localhost' && !isNativeApp()
  ? 'ws://localhost:7777' : PRODUCTION_RELAY_URL;

/** Public defaults; the indexer remains read-only. */
export function defaultRelays(): RelayConfig[] {
  const urls = [PRODUCTION_RELAY_URL, 'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://relay.ditto.pub', 'wss://relay.nostr.band'];
  if (DEFAULT_RELAY_URL !== PRODUCTION_RELAY_URL) urls.unshift(DEFAULT_RELAY_URL);
  return urls.map(url => ({ url, enabled: true, read: true, write: url !== 'wss://relay.nostr.band' }));
}

export function primaryRelayUrl(relays: RelayConfig[]): string {
  return relays.find(r => r.enabled && r.write)?.url ?? relays.find(r => r.enabled)?.url ?? DEFAULT_RELAY_URL;
}

function isRetiredRelay(url: string | undefined): boolean {
  try { return new URL(url ?? '').hostname.toLowerCase().replace(/\.$/, '') === 'relay.trotters.cc'; }
  catch { return false; }
}

/** Retire the old app default, preserving other relay choices and settings.
 * Historical event locations and already-paired device endpoints are separate. */
export function migrateRelayPreferences<T extends Pick<AppPreferences, 'relays' | 'relayUrl' | 'fallbackBunkerRelays'>>(prefs: T): T {
  const retiredPrimary = isRetiredRelay(prefs.relayUrl);
  const retiredPool = prefs.relays?.some(r => isRetiredRelay(r.url));
  const retiredFallback = prefs.fallbackBunkerRelays?.some(isRetiredRelay);
  if (!retiredPrimary && !retiredPool && !retiredFallback) return prefs;
  const next = { ...prefs };
  if (retiredPrimary || retiredPool) {
    const remaining = prefs.relays?.filter(r => !isRetiredRelay(r.url));
    const legacy = !retiredPrimary && prefs.relayUrl && isValidRelayUrl(prefs.relayUrl) ? prefs.relayUrl : undefined;
    next.relays = remaining?.length ? remaining : legacy ? [{ url: legacy, enabled: true, read: true, write: true }] : defaultRelays();
    next.relayUrl = primaryRelayUrl(next.relays);
  }
  if (retiredFallback) next.fallbackBunkerRelays = prefs.fallbackBunkerRelays!.filter(url => !isRetiredRelay(url));
  return next;
}
