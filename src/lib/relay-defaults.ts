import type { AppPreferences, RelayConfig } from '../types';
import { isNativeApp } from './native';
import { isValidRelayUrl } from './relay-url';

export const PRODUCTION_RELAY_URL = 'wss://relay.primal.net';
// Capacitor also serves from localhost; only a browser dev server uses this.
export const DEFAULT_RELAY_URL = typeof window !== 'undefined' && window.location?.hostname === 'localhost' && !isNativeApp()
  ? 'ws://localhost:7777' : PRODUCTION_RELAY_URL;

/** Public defaults. Kept short: a private-backup read needs every write relay to answer. */
export function defaultRelays(): RelayConfig[] {
  const urls = [PRODUCTION_RELAY_URL, 'wss://relay.damus.io', 'wss://relay.ditto.pub'];
  if (DEFAULT_RELAY_URL !== PRODUCTION_RELAY_URL) urls.unshift(DEFAULT_RELAY_URL);
  return urls.map(url => ({ url, enabled: true, read: true, write: true }));
}

export function primaryRelayUrl(relays: RelayConfig[]): string {
  return relays.find(r => r.enabled && r.write)?.url ?? relays.find(r => r.enabled)?.url ?? DEFAULT_RELAY_URL;
}

const RETIRED_RELAY_HOSTS = new Set(['relay.trotters.cc', 'nos.lol']);

function isRetiredRelay(url: string | undefined): boolean {
  try { return RETIRED_RELAY_HOSTS.has(new URL(url ?? '').hostname.toLowerCase().replace(/\.$/, '')); }
  catch { return false; }
}

function sameRelay(a: string, b: string): boolean {
  try { return new URL(a).href === new URL(b).href; }
  catch { return a === b; }
}

/** Retire old app defaults (relay.trotters.cc, nos.lol), preserving other relay
 * choices and settings. Retired relays leave the pool and the fallback list.
 * When the retired relay was the primary (`relayUrl`), DEFAULT_RELAY_URL (the
 * production relay, or the local relay on a browser dev server) becomes the
 * primary: it is prepended to the pool if absent, or moved to the
 * front (and enabled for read and write) if present, and the rest of the pool
 * keeps its order. A person whose primary was something else keeps it.
 * Pure and idempotent. Historical event locations and already-paired device
 * endpoints are separate. */
export function migrateRelayPreferences<T extends Pick<AppPreferences, 'relays' | 'relayUrl' | 'fallbackBunkerRelays'>>(prefs: T): T {
  const retiredPrimary = isRetiredRelay(prefs.relayUrl);
  const retiredPool = prefs.relays?.some(r => isRetiredRelay(r.url));
  const retiredFallback = prefs.fallbackBunkerRelays?.some(isRetiredRelay);
  if (!retiredPrimary && !retiredPool && !retiredFallback) return prefs;
  const next = { ...prefs };
  if (retiredPrimary || retiredPool) {
    const remaining = prefs.relays?.filter(r => !isRetiredRelay(r.url));
    if (retiredPrimary) {
      if (remaining?.length) {
        const rest = remaining.filter(r => !sameRelay(r.url, DEFAULT_RELAY_URL));
        const existing = remaining.find(r => sameRelay(r.url, DEFAULT_RELAY_URL));
        next.relays = [{ ...existing, url: existing?.url ?? DEFAULT_RELAY_URL, enabled: true, read: true, write: true }, ...rest];
      } else {
        next.relays = defaultRelays();
      }
      next.relayUrl = DEFAULT_RELAY_URL;
    } else {
      const legacy = prefs.relayUrl && isValidRelayUrl(prefs.relayUrl) ? prefs.relayUrl : undefined;
      next.relays = remaining?.length ? remaining : legacy ? [{ url: legacy, enabled: true, read: true, write: true }] : defaultRelays();
      next.relayUrl = legacy ?? primaryRelayUrl(next.relays);
    }
  }
  if (retiredFallback) next.fallbackBunkerRelays = prefs.fallbackBunkerRelays!.filter(url => !isRetiredRelay(url));
  return next;
}
