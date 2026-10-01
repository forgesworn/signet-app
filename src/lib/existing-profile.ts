/**
 * Look up the kind-0 a Nostr key already has public, across several relays.
 *
 * Used when an nsec is imported (so Signet can offer to "match" a profile that
 * is already public), by "Check Nostr for an existing profile" on a persona's
 * Advanced page, and by the lossless publish path (which needs the relay's
 * CURRENT kind-0 to merge onto).
 *
 * One relay is not enough: a key's profile often lives only on the big public
 * indexers, not on the relay Signet is configured for. So the lookup fans out
 * to the caller's relays plus `PROFILE_LOOKUP_RELAYS`.
 *
 * Trust: a relay is free to answer with anything, so every event is dropped
 * unless its `pubkey` is the one asked for AND its signature verifies, BEFORE
 * the newest-wins sort — a bad-signature or stranger-authored event can never
 * win and hide the real record. Nothing is ever fetched from a URL inside the
 * profile (no images).
 *
 * Each relay uses its own short-lived `RelayClient`, not the app's persistent
 * relay pool: the indexers are queried once and must not linger in that pool.
 */

import type { NostrEvent, NostrFilter } from 'signet-protocol';
import { RelayClient } from 'signet-protocol';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { PersonaPublicProfile, PublicProfileBase, PublicProfileConfig } from '../types';
import { isValidRelayUrl } from './relay-url';
import { verifiedAuthoredEvents } from './event-verify';
import { parseKindZeroContent, toPublicProfileBase } from './public-profile-publish';

/** Public relays that commonly carry profiles for keys that never touched ours. */
export const PROFILE_LOOKUP_RELAYS: readonly string[] = [
  'wss://purplepag.es',
  'wss://relay.damus.io',
  'wss://nos.lol',
];

const DEFAULT_TIMEOUT_MS = 4000;
const HEX64 = /^[0-9a-f]{64}$/i;

export interface ExistingProfile {
  /** The winning kind-0, signature verified and author pinned. */
  event: NostrEvent;
  /** Its content, parsed and validated (invalid fields dropped, never the whole profile). */
  profile: Partial<PublicProfileConfig>;
  /** The event as a device-local base; `undefined` when it is too big to store. */
  base: PublicProfileBase | undefined;
  /** A relay the winning event was seen on (a caller-supplied relay is preferred over a lookup relay). */
  relay: string;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Query one relay; `null` means it could not be reached (or timed out). */
async function queryRelay(url: string, filter: NostrFilter, timeoutMs: number): Promise<NostrEvent[] | null> {
  let relay: RelayClient | null = null;
  try {
    relay = new RelayClient(url);
    await withTimeout(relay.connect(), timeoutMs);
    return await withTimeout(relay.fetch([filter], timeoutMs), timeoutMs);
  } catch {
    return null;
  } finally {
    try { relay?.disconnect(); } catch { /* already gone */ }
  }
}

/**
 * Find the newest valid kind-0 for `pubkey`.
 *
 * Returns `null` when at least one relay answered and none had a usable
 * profile, `'unreachable'` when no relay could be reached at all (so callers
 * can say "couldn't check" rather than "nothing there"), else the profile.
 *
 * `relays` are the caller's own (the user's read relays; onboarding has none
 * and passes the default relay). `includeLookupRelays: false` restricts the
 * lookup to exactly `relays` (the dev-relay onboarding branch).
 */
export async function fetchExistingProfile(
  pubkey: string,
  relays: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  opts?: { includeLookupRelays?: boolean },
): Promise<ExistingProfile | null | 'unreachable'> {
  if (typeof pubkey !== 'string' || !HEX64.test(pubkey)) return null;
  const author = pubkey.toLowerCase();

  const callerRelays: string[] = [];
  const all: string[] = [];
  const add = (url: string, caller: boolean) => {
    if (typeof url !== 'string' || !isValidRelayUrl(url) || all.includes(url)) return;
    all.push(url);
    if (caller) callerRelays.push(url);
  };
  for (const url of relays) add(url, true);
  if (opts?.includeLookupRelays !== false) for (const url of PROFILE_LOOKUP_RELAYS) add(url, false);
  if (all.length === 0) return 'unreachable';

  const filter = { kinds: [0], authors: [author], limit: 5 } as NostrFilter;
  const results = await Promise.all(all.map(async (url) => ({ url, events: await queryRelay(url, filter, timeoutMs) })));

  const reached = results.filter(r => r.events !== null);
  if (reached.length === 0) return 'unreachable';

  // Dedupe by id across relays, remembering where each id was seen.
  const byId = new Map<string, { event: NostrEvent; seenOn: string[] }>();
  for (const { url, events } of reached) {
    for (const ev of events ?? []) {
      if (!ev || typeof ev.id !== 'string' || ev.kind !== 0) continue;
      if (typeof ev.pubkey !== 'string' || ev.pubkey.toLowerCase() !== author) continue;
      const existing = byId.get(ev.id);
      if (existing) existing.seenOn.push(url);
      else byId.set(ev.id, { event: ev, seenOn: [url] });
    }
  }

  // Signature check AFTER the author pin and BEFORE the sort, so a forged
  // event can never be the "newest" that hides the genuine one.
  const candidates = Array.from(byId.values()).filter(c => {
    try { return verifiedAuthoredEvents([c.event], author).length === 1; } catch { return false; }
  });
  if (candidates.length === 0) return null;

  // Newest created_at wins; tie: lowest id.
  candidates.sort((a, b) =>
    b.event.created_at - a.event.created_at || (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0),
  );
  const winner = candidates[0];
  const profile = parseKindZeroContent(winner.event.content);
  if (!profile) return null;

  const relay = winner.seenOn.find(u => callerRelays.includes(u)) ?? winner.seenOn[0];
  return { event: winner.event, profile, base: toPublicProfileBase(winner.event), relay };
}

/**
 * What "Match it in Signet" writes to a slot: the profile's values as the
 * card, the publication state of the event that is ALREADY on the relay (so
 * nothing is published), and the event itself as the device-local base the
 * lossless publish merges against. `displayName` is the name the user settled
 * on (prefilled from the profile, editable).
 *
 * `lastPublishedContentHash` is the hash of the event's own content, so a
 * Republish with nothing edited short-circuits instead of minting a duplicate.
 * `lastPublishedRelay` is a relay the event was actually seen on — the only
 * place a later kind-5 retraction is sent.
 */
export function buildMatchSeed(found: ExistingProfile, displayName: string): {
  config: PublicProfileConfig;
  state: PersonaPublicProfile;
  base: PublicProfileBase | undefined;
} {
  const p = found.profile;
  return {
    config: {
      displayName: displayName.trim(),
      about: p.about,
      pictureUrl: p.pictureUrl,
      bannerUrl: p.bannerUrl,
      nip05: p.nip05,
      lud16: p.lud16,
      website: p.website,
    },
    state: {
      enabled: true,
      lastEventId: found.event.id,
      lastPublishedAt: found.event.created_at,
      lastPublishedRelay: found.relay,
      lastPublishedContentHash: bytesToHex(sha256(new TextEncoder().encode(found.event.content))),
    },
    base: found.base ? { ...found.base, matched: true } : undefined,
  };
}
