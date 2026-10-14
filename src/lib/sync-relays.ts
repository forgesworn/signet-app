/** Sync reads and writes use the whole configured pool. A fresh install
 * uses the full default pool; an explicit custom single relay stays custom.
 * Disabled/read-only choices never create an implicit write fallback. */

import type { NostrEvent, NostrFilter } from 'signet-protocol';
import { RelayClient } from 'signet-protocol';
import type { AppPreferences } from '../types';
import { isValidRelayUrl } from './relay-url';
import { DEFAULT_RELAY_URL, defaultRelays, migrateRelayPreferences } from './relay-defaults';
import { relayTimeout, anyRelayAccepted } from './relay-operations';

const NETWORK_TIMEOUT_MS = 10_000;

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
  const effective = migrateRelayPreferences(prefs);
  const configured = (effective.relays ?? []).filter(r => isValidRelayUrl(r.url));
  if (configured.length) return {
    read: dedupe(configured.filter(r => r.enabled && r.read).map(r => r.url)),
    write: dedupe(configured.filter(r => r.enabled && r.write).map(r => r.url)),
  };
  const legacy = effective.relayUrl && isValidRelayUrl(effective.relayUrl) ? effective.relayUrl : undefined;
  if (legacy) return { read: [legacy], write: [legacy] };
  if (fallback !== DEFAULT_RELAY_URL) return { read: [fallback], write: [fallback] };
  const defaults = defaultRelays();
  return {
    read: defaults.filter(r => r.enabled && r.read).map(r => r.url),
    write: defaults.filter(r => r.enabled && r.write).map(r => r.url),
  };
}

/**
 * Publish a signed event to every relay in `relayUrls`, in parallel.
 * `relayUrls` is assumed already validated/deduped by the caller — this
 * helper doesn't filter. Returns true when at least one relay accepts it;
 * a per-relay construct/connect/publish failure doesn't fail the others
 * and a first acknowledgement returns immediately. Shared by every sync rail (personas, dependants,
 * contacts, credentials, grants).
 */
export async function publishToRelays(signedEvent: NostrEvent, relayUrls: string[], guard?: {
  beforeSend(): Promise<void>; isCurrent(): boolean;
}): Promise<boolean> {
  if (relayUrls.length === 0) return false;
  return anyRelayAccepted(dedupe(relayUrls).map(async url => {
    const relay = new RelayClient(url, { autoReconnect: false });
    try {
      await relayTimeout(relay.connect(), NETWORK_TIMEOUT_MS);
      if (guard) {
        await guard.beforeSend();
        if (!guard.isCurrent()) throw new Error('Publication session changed');
      }
      const result = await relayTimeout(relay.publish(signedEvent), NETWORK_TIMEOUT_MS);
      return result.ok;
    } finally {
      relay.disconnect();
    }
  }));
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
  opts?: { timeoutMs?: number },
): Promise<{ event: NostrEvent | null; reachableRelays: number }> {
  const eventsById = new Map<string, NostrEvent>();
  let reachableRelays = 0;
  const pin = (authorPubkey ?? filter.authors?.[0])?.toLowerCase();

  const timeoutMs = opts?.timeoutMs ?? NETWORK_TIMEOUT_MS;
  await Promise.all(dedupe(relayUrls).map(async (url) => {
    try {
      const relay = new RelayClient(url, { autoReconnect: false });
      try {
        await relayTimeout(relay.connect(), timeoutMs);
        // A relay that never finishes its read is not evidence of absence.
        // Expire before the SDK's timer can resolve partial/empty results.
        const events = await relayTimeout(relay.fetch([filter], timeoutMs + 100), timeoutMs);
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
