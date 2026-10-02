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
async function queryRelay(url: string, filter: NostrFilter | NostrFilter[], timeoutMs: number): Promise<NostrEvent[] | null> {
  let relay: RelayClient | null = null;
  try {
    relay = new RelayClient(url);
    await withTimeout(relay.connect(), timeoutMs);
    return await withTimeout(relay.fetch(Array.isArray(filter) ? filter : [filter], timeoutMs), timeoutMs);
  } catch {
    return null;
  } finally {
    try { relay?.disconnect(); } catch { /* already gone */ }
  }
}

/**
 * The relay set for a lookup: the caller's own relays plus the public lookup
 * relays, validated and deduped. `callerRelays` is the subset the caller
 * supplied, so a result can prefer a relay the user actually uses.
 */
export function resolveLookupRelays(
  relays: string[],
  includeLookupRelays: boolean = true,
): { all: string[]; callerRelays: string[] } {
  const callerRelays: string[] = [];
  const all: string[] = [];
  const add = (url: string, caller: boolean) => {
    if (typeof url !== 'string' || !isValidRelayUrl(url) || all.includes(url)) return;
    all.push(url);
    if (caller) callerRelays.push(url);
  };
  for (const url of relays) add(url, true);
  if (includeLookupRelays) for (const url of PROFILE_LOOKUP_RELAYS) add(url, false);
  return { all, callerRelays };
}

/** One event seen on the relays, with where it was seen. */
export interface GatheredEvent {
  event: NostrEvent;
  seenOn: string[];
}

/**
 * The shared multi-relay fan-out behind every "what does Nostr say about
 * these keys" lookup (a profile, a follow list, a batch of names).
 *
 * Queries every relay in the lookup set with `filters`, then keeps only
 * events of one of `kinds` whose `pubkey` is in `authors` (the author pin —
 * a relay may answer with anything), deduped by id with the relays each was
 * seen on. It does NOT verify signatures: callers pick a winner per author
 * with `pickNewestVerified`, so a signature is checked only on the events
 * that could actually win.
 *
 * `null` means no relay could be reached at all; an empty result means at
 * least one answered and none had anything usable.
 *
 * `budgetMs` (optional) caps each relay's WHOLE exchange (connect + fetch) —
 * a relay still working when it expires counts as unreachable and its
 * partial answer is dropped, while relays that finished keep theirs.
 */
export async function gatherAuthoredEvents(args: {
  filters: NostrFilter[];
  kinds: readonly number[];
  authors: ReadonlySet<string>;
  relays: string[];
  timeoutMs: number;
  includeLookupRelays?: boolean;
  budgetMs?: number;
}): Promise<{ events: GatheredEvent[]; callerRelays: string[] } | null> {
  const { all, callerRelays } = resolveLookupRelays(args.relays, args.includeLookupRelays !== false);
  if (all.length === 0) return null;

  const results = await Promise.all(all.map(async (url) => {
    const query = queryRelay(url, args.filters, args.timeoutMs);
    if (args.budgetMs === undefined) return { url, events: await query };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), args.budgetMs); });
    try {
      return { url, events: await Promise.race([query, expired]) };
    } finally {
      clearTimeout(timer);
    }
  }));

  const reached = results.filter(r => r.events !== null);
  if (reached.length === 0) return null;

  // Dedupe by id across relays, remembering where each id was seen.
  const byId = new Map<string, GatheredEvent>();
  for (const { url, events } of reached) {
    for (const ev of events ?? []) {
      if (!ev || typeof ev.id !== 'string' || !args.kinds.includes(ev.kind)) continue;
      if (typeof ev.pubkey !== 'string' || !args.authors.has(ev.pubkey.toLowerCase())) continue;
      const existing = byId.get(ev.id);
      if (existing) existing.seenOn.push(url);
      else byId.set(ev.id, { event: ev, seenOn: [url] });
    }
  }
  return { events: Array.from(byId.values()), callerRelays };
}

/**
 * The newest SIGNATURE-VALID event among `candidates` (all by `author`):
 * newest `created_at` wins, tie: lowest id. Candidates are tried newest-first
 * and only until one verifies, so a forged event can never be the "newest"
 * that hides the genuine one, and a batch of authors costs about one
 * signature check each rather than one per event seen.
 */
export function pickNewestVerified(candidates: GatheredEvent[], author: string): GatheredEvent | null {
  const ordered = [...candidates].sort((a, b) =>
    b.event.created_at - a.event.created_at || (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0),
  );
  for (const c of ordered) {
    try { if (verifiedAuthoredEvents([c.event], author).length === 1) return c; } catch { /* unverifiable: skip */ }
  }
  return null;
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

  const filter = { kinds: [0], authors: [author], limit: 5 } as NostrFilter;
  const gathered = await gatherAuthoredEvents({
    filters: [filter], kinds: [0], authors: new Set([author]), relays, timeoutMs,
    includeLookupRelays: opts?.includeLookupRelays,
  });
  if (!gathered) return 'unreachable';

  // Signature check AFTER the author pin and BEFORE the sort's winner is
  // taken, so a forged event can never be the "newest" that hides the genuine one.
  const winner = pickNewestVerified(gathered.events, author);
  if (!winner) return null;
  const profile = parseKindZeroContent(winner.event.content);
  if (!profile) return null;

  const relay = winner.seenOn.find(u => gathered.callerRelays.includes(u)) ?? winner.seenOn[0];
  return { event: winner.event, profile, base: toPublicProfileBase(winner.event), relay };
}

/**
 * What "Match it in My Signet" writes to a slot: the profile's values as the
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
