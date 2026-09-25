/**
 * Relay-pool resolver for the sync rails (personas, dependants, contacts,
 * credentials, grants). Reads/writes fan out to the user's whole relay set
 * (2026-06-10 multi-relay manager) rather than the single `relayUrl` a rail
 * historically used — see `AppPreferences.relays`. When the user hasn't
 * edited relays yet (`relays` absent/empty) or every configured relay ends
 * up filtered out, both pools collapse to a fallback: `prefs.relayUrl`
 * (the pre-multi-relay legacy setting) when it's itself a valid relay URL,
 * else the caller-supplied `fallback` (normally `DEFAULT_RELAY_URL`) — so
 * a rail never ends up with an empty pool, and an existing single-relay
 * user's setting is honoured ahead of the app-wide default.
 */

import type { NostrEvent, NostrFilter } from 'signet-protocol';
import { RelayClient } from 'signet-protocol';
import type { AppPreferences } from '../types';
import { isValidRelayUrl } from './relay-url';

function dedupe(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

export function resolveSyncRelays(
  prefs: Pick<AppPreferences, 'relays' | 'relayUrl'>,
  fallback: string,
): { read: string[]; write: string[] } {
  const configured = (prefs.relays ?? []).filter((r) => r.enabled && isValidRelayUrl(r.url));

  const read = dedupe(configured.filter((r) => r.read).map((r) => r.url));
  const write = dedupe(configured.filter((r) => r.write).map((r) => r.url));

  const effectiveFallback = prefs.relayUrl && isValidRelayUrl(prefs.relayUrl) ? prefs.relayUrl : fallback;

  return {
    read: read.length > 0 ? read : [effectiveFallback],
    write: write.length > 0 ? write : [effectiveFallback],
  };
}

/**
 * Publish a signed event to every relay in `relayUrls`, in parallel.
 * `relayUrls` is assumed already validated/deduped by the caller — this
 * helper doesn't filter. Returns true when at least one relay accepts it;
 * a per-relay construct/connect/publish failure doesn't fail the others
 * (`allSettled`). Shared by every sync rail (personas, dependants,
 * contacts, credentials, grants).
 */
export async function publishToRelays(signedEvent: NostrEvent, relayUrls: string[], guard?: {
  beforeSend(): Promise<void>; isCurrent(): boolean;
}): Promise<boolean> {
  if (relayUrls.length === 0) return false;

  const results = await Promise.allSettled(relayUrls.map(async (url) => {
    const relay = new RelayClient(url);
    try {
      await relay.connect();
      if (guard) {
        await guard.beforeSend();
        if (!guard.isCurrent()) throw new Error('Publication session changed');
      }
      const result = await relay.publish(signedEvent);
      return result.ok;
    } finally {
      relay.disconnect();
    }
  }));

  return results.some((r) => r.status === 'fulfilled' && r.value === true);
}

/**
 * Fetch the newest event matching `filter` across every relay in
 * `relayUrls`. Each relay is queried independently (per-relay try/catch);
 * an unreachable relay (construct/connect/fetch throws) doesn't count
 * toward `reachableRelays` and doesn't fail the others. Events are
 * deduped by id across relays and the newest `created_at` wins.
 *
 * `reachableRelays === 0` tells the caller every relay in the pool was
 * unreachable — distinct from "reachable but nothing found"
 * (`event: null, reachableRelays > 0`). Shared by every sync rail.
 *
 * **Author pin.** Every event is checked against `authorPubkey` (defaulting
 * to the filter's own `authors[0]`) and dropped if it doesn't match, BEFORE
 * the newest-wins sort. A relay is free to answer with whatever it likes;
 * without this, one misbehaving relay in the pool could hand back a newer
 * event authored by someone else and win the sort, and the caller would
 * then try to decrypt a stranger's record as its own. The decrypt would
 * fail, but a failed decrypt reads as "nothing usable found", which is
 * exactly the state that suppresses a real record on the other relays.
 * An event with no `pubkey` at all is malformed and dropped too.
 */
export async function fetchNewestFromRelays(
  filter: NostrFilter,
  relayUrls: string[],
  authorPubkey?: string,
): Promise<{ event: NostrEvent | null; reachableRelays: number }> {
  const eventsById = new Map<string, NostrEvent>();
  let reachableRelays = 0;
  const pin = (authorPubkey ?? filter.authors?.[0])?.toLowerCase();

  await Promise.all(relayUrls.map(async (url) => {
    try {
      const relay = new RelayClient(url);
      try {
        await relay.connect();
        const events = await relay.fetch([filter]);
        reachableRelays += 1;
        for (const ev of events) {
          if (pin && ev.pubkey?.toLowerCase() !== pin) continue;
          const existing = eventsById.get(ev.id);
          if (!existing || ev.created_at > existing.created_at) eventsById.set(ev.id, ev);
        }
      } finally {
        relay.disconnect();
      }
    } catch {
      // Unreachable relay (construction, connect, or fetch threw) —
      // doesn't count toward reachableRelays, doesn't fail the whole fetch.
    }
  }));

  if (eventsById.size === 0) return { event: null, reachableRelays };
  const latest = Array.from(eventsById.values()).sort((a, b) => b.created_at - a.created_at)[0];
  return { event: latest, reachableRelays };
}

/**
 * Resolve a sync hook's `relays`/`relayUrl` options into a single
 * `{ read; write }` pair. `relays` wins when present; the deprecated
 * `relayUrl` (kept as a mechanical compatibility alias on the four older
 * rail hooks) maps to both lists otherwise. Neither present resolves to
 * empty pools, which every hook already treats as "don't run".
 */
export function resolveHookRelays(
  relays: { read: string[]; write: string[] } | undefined,
  relayUrl: string | undefined,
): { read: string[]; write: string[] } {
  if (relays) return relays;
  return relayUrl ? { read: [relayUrl], write: [relayUrl] } : { read: [], write: [] };
}
