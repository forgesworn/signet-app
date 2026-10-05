/**
 * Read a Nostr key's follow list (kind 3) so Signet can offer it as contacts.
 *
 * Read only, Nostr -> Signet. Signet NEVER publishes a kind 3: who an account
 * follows on Nostr is that account's own business, and a Signet-side change
 * must never rewrite it.
 *
 * Trust: same rules as the profile lookup (`existing-profile.ts`, whose
 * multi-relay fan-out this reuses) — the author is pinned, the signature is
 * verified, the newest event wins. Profiles are fetched as kind-0 TEXT: the
 * name, and the `picture` URL as a string. Nothing inside a profile (picture,
 * banner, links) is ever loaded here. The picture URL is downloaded only by
 * `contact-pictures.ts`, and only after the user has agreed to the "Download
 * their profile pictures?" step for that run — never in the background.
 */

import type { NostrEvent, NostrFilter } from 'signet-protocol';
import { nip19 } from 'nostr-tools';
import type { ContactRecord } from '../types';
import { isValidRelayUrl } from './relay-url';
import { sanitizeDisplayName } from './text-sanitize';
import { contactBelongsToList } from './contacts-v2-membership';
import { gatherAuthoredEvents, pickNewestVerified } from './existing-profile';
import { parseKindZeroContent } from './public-profile-publish';

const HEX64 = /^[0-9a-f]{64}$/;

/** Most `p` tags read from one kind 3 (the LAST ones — Nostr clients append). */
export const MAX_FOLLOW_TAGS = 5000;
/** Most follows imported per run (the most recent). */
export const MAX_FOLLOWS_PER_IMPORT = 1000;
/** Authors per kind-0 name request. */
export const NAME_CHUNK = 200;
/** The caption every imported follow carries on its `import` origin. */
export const FOLLOWS_ORIGIN_CAPTION = 'Nostr follows';

const FOLLOWS_TIMEOUT_MS = 6000;
const NAMES_BUDGET_MS = 6000;
/** Name-lookup REQs carry a few chunks each, well under the usual relay filter cap. */
const FILTERS_PER_REQ = 5;

export interface Follow {
  /** Lowercase 64-hex pubkey. */
  pubkey: string;
  /** The follower's own label for it (`p` tag position 3), sanitised. */
  petname?: string;
  /** Relay hint (`p` tag position 2), only when it is a valid relay URL. */
  relay?: string;
}

export interface FollowList {
  eventId: string;
  /** Unix seconds — the kind-3 event's `created_at`. */
  createdAt: number;
  /** In tag order (oldest first); the most recent follow is LAST. */
  follows: Follow[];
  /**
   * How many accounts the list follows, for the user-facing count. When the
   * event carried more than `MAX_FOLLOW_TAGS` `p` tags only the last
   * `MAX_FOLLOW_TAGS` are read, and this is the raw `p` tag count instead.
   */
  total: number;
  /** True when `p` tags beyond `MAX_FOLLOW_TAGS` were not read. */
  truncated: boolean;
}

/**
 * Parse the `p` tags of a kind-3 event.
 *
 * Only a lowercase 64-hex pubkey is a follow (anything else is dropped, never
 * repaired); duplicates collapse to their LAST occurrence (so "most recent"
 * keeps meaning "latest in the tag order"); the author itself is dropped. At
 * most `MAX_FOLLOW_TAGS` `p` tags are read, taken from the END of the list.
 */
export function parseFollowList(event: Pick<NostrEvent, 'id' | 'pubkey' | 'created_at' | 'tags'>): FollowList {
  const self = typeof event.pubkey === 'string' ? event.pubkey.toLowerCase() : '';
  const pTags: string[][] = [];
  if (Array.isArray(event.tags)) {
    for (const tag of event.tags) {
      if (Array.isArray(tag) && tag[0] === 'p') pTags.push(tag as string[]);
    }
  }
  const truncated = pTags.length > MAX_FOLLOW_TAGS;
  const window = truncated ? pTags.slice(pTags.length - MAX_FOLLOW_TAGS) : pTags;

  // Walk backwards so a duplicate keeps its LAST position, then restore order.
  const seen = new Set<string>();
  const reversed: Follow[] = [];
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const tag = window[i];
    if (typeof tag[1] !== 'string' || !HEX64.test(tag[1]) || tag[1] === self || seen.has(tag[1])) continue;
    seen.add(tag[1]);
    const follow: Follow = { pubkey: tag[1] };
    if (typeof tag[3] === 'string') {
      const petname = sanitizeDisplayName(tag[3], 100);
      if (petname) follow.petname = petname;
    }
    if (typeof tag[2] === 'string' && tag[2] !== '' && isValidRelayUrl(tag[2])) follow.relay = tag[2];
    reversed.push(follow);
  }
  const follows = reversed.reverse();
  return {
    eventId: event.id,
    createdAt: event.created_at,
    follows,
    total: truncated ? pTags.length : follows.length,
    truncated,
  };
}

/**
 * Find the newest valid kind 3 for `pubkey` across the caller's relays plus
 * the public lookup relays. `null` = at least one relay answered and none has
 * a follow list; `'unreachable'` = no relay answered at all.
 */
export async function fetchFollowList(
  pubkey: string,
  relays: string[],
  timeoutMs: number = FOLLOWS_TIMEOUT_MS,
): Promise<FollowList | null | 'unreachable'> {
  if (typeof pubkey !== 'string' || !HEX64.test(pubkey.toLowerCase())) return null;
  const author = pubkey.toLowerCase();
  const filter = { kinds: [3], authors: [author], limit: 5 } as NostrFilter;
  const gathered = await gatherAuthoredEvents({
    filters: [filter], kinds: [3], authors: new Set([author]), relays, timeoutMs,
  });
  if (!gathered) return 'unreachable';
  const winner = pickNewestVerified(gathered.events, author);
  if (!winner) return null;
  return parseFollowList(winner.event);
}

/** `npub1abcdef…uvwxyz` — the fallback label when a follow has no name. */
export function shortNpub(pubkey: string): string {
  try {
    const npub = nip19.npubEncode(pubkey);
    return `${npub.slice(0, 10)}…${npub.slice(-6)}`;
  } catch {
    return pubkey.slice(0, 8);
  }
}

/** What one kind-0 profile contributes: its name and its picture URL (text only). */
export interface Kind0Profile {
  displayName?: string;
  /** The `picture` URL as published (already length-capped and scheme-checked by the parser). Never fetched here. */
  pictureUrl?: string;
}

/**
 * Batch-fetch kind-0 profiles for `pubkeys` (authors in chunks of `NAME_CHUNK`,
 * a few chunks per request, one shared 6 s budget across every relay). Only an
 * author with a verified newest kind 0 is in the map — absence means "could
 * not be fetched", which is different from "fetched, no picture".
 */
export async function fetchKind0Profiles(
  pubkeys: string[],
  relays: string[],
  budgetMs: number = NAMES_BUDGET_MS,
): Promise<Map<string, Kind0Profile>> {
  const profiles = new Map<string, Kind0Profile>();
  const wanted = Array.from(new Set(pubkeys.filter(p => HEX64.test(p))));
  if (wanted.length === 0) return profiles;

  const filters: NostrFilter[] = [];
  for (let i = 0; i < wanted.length; i += NAME_CHUNK) {
    const authors = wanted.slice(i, i + NAME_CHUNK);
    filters.push({ kinds: [0], authors, limit: authors.length * 2 } as NostrFilter);
  }
  // `fetch` takes several filters, but a relay caps filters per REQ — send a
  // few chunks at a time, all of them inside the one budget.
  const gatherers: Promise<Awaited<ReturnType<typeof gatherAuthoredEvents>>>[] = [];
  const authorSet = new Set(wanted);
  for (let i = 0; i < filters.length; i += FILTERS_PER_REQ) {
    gatherers.push(gatherAuthoredEvents({
      filters: filters.slice(i, i + FILTERS_PER_REQ), kinds: [0], authors: authorSet,
      relays, timeoutMs: budgetMs, budgetMs,
    }));
  }
  const gathered = await Promise.all(gatherers);

  const byAuthor = new Map<string, import('./existing-profile').GatheredEvent[]>();
  const seenIds = new Set<string>();
  for (const g of gathered) {
    for (const item of g?.events ?? []) {
      if (seenIds.has(item.event.id)) continue;
      seenIds.add(item.event.id);
      const author = item.event.pubkey.toLowerCase();
      const list = byAuthor.get(author);
      if (list) list.push(item); else byAuthor.set(author, [item]);
    }
  }

  let checked = 0;
  for (const [author, candidates] of byAuthor) {
    const winner = pickNewestVerified(candidates, author);
    if (winner) {
      // An unparseable profile is "couldn't fetch", not "no picture": leaving
      // it out of the map keeps any stored thumbnail on a refresh.
      const parsed = parseKindZeroContent(winner.event.content);
      if (parsed) {
        const profile: Kind0Profile = {};
        if (parsed.displayName) profile.displayName = sanitizeDisplayName(parsed.displayName, 100);
        if (parsed.pictureUrl) profile.pictureUrl = parsed.pictureUrl;
        profiles.set(author, profile);
      }
    }
    // Signature checks are synchronous: hand the thread back now and then so
    // a large list never freezes the screen.
    checked += 1;
    if (checked % 40 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return profiles;
}

/** Names only, from `fetchKind0Profiles`. A follow nobody could name is absent from the map. */
export async function fetchFollowNames(
  pubkeys: string[],
  relays: string[],
  budgetMs: number = NAMES_BUDGET_MS,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const [pubkey, profile] of await fetchKind0Profiles(pubkeys, relays, budgetMs)) {
    if (profile.displayName) names.set(pubkey, profile.displayName);
  }
  return names;
}

/** What the batch import takes: one pubkey and the name to file it under. */
export interface FollowEntry {
  pubkey: string;
  displayName: string;
}

/** Petname first (the follower's own label), then the profile name, then a short npub. */
export function nameFollows(follows: Follow[], names: Map<string, string>): FollowEntry[] {
  return follows.map(f => ({
    pubkey: f.pubkey,
    displayName: f.petname || names.get(f.pubkey) || shortNpub(f.pubkey),
  }));
}

/** The `max` most recent follows (the LAST ones in tag order), still in tag order. */
export function takeMostRecent<T>(follows: T[], max: number = MAX_FOLLOWS_PER_IMPORT): T[] {
  return follows.length > max ? follows.slice(follows.length - max) : follows;
}

/**
 * Contacts that came from an earlier follows import for `persona` but are no
 * longer followed.
 *
 * A candidate is an active member of the persona's list that carries an
 * `import` origin captioned "Nostr follows" for THIS persona and none of whose
 * identity keys is in `current` (the newest kind-3 pubkeys).
 *
 * `onlyOnThisList` are those whose list membership is their ONLY one:
 * removing them from it would remove the contact altogether (that is what
 * `unlink-list` does to a contact's last list), and this import must never
 * remove a contact — so they are reported but never offered for removal.
 */
export function computeUnfollows(
  records: ContactRecord[],
  persona: string,
  current: ReadonlySet<string>,
): { removable: ContactRecord[]; onlyOnThisList: ContactRecord[] } {
  const removable: ContactRecord[] = [];
  const onlyOnThisList: ContactRecord[] = [];
  for (const record of records) {
    if (record.lifecycle === 'removed') continue;
    if (!contactBelongsToList(record, persona)) continue;
    const fromFollows = record.origins?.some(o => o.method === 'import'
      && o.caption === FOLLOWS_ORIGIN_CAPTION && o.ownerIdentityPubkey === persona);
    if (!fromFollows) continue;
    if (record.identities.length === 0 || record.identities.some(i => current.has(i.pubkey))) continue;
    const otherLists = record.listMemberships?.some(m => m.removedAt === undefined
      && m.ownerIdentityPubkey !== persona) ?? false;
    (otherLists ? removable : onlyOnThisList).push(record);
  }
  return { removable, onlyOnThisList };
}

/**
 * The user-facing line when an import was trimmed to fit the backup.
 * `personaName` is the persona's display name.
 */
export function followsTrimmedCopy(personaName: string, total: number, imported: number): string {
  return `${personaName} follows ${total} accounts. Signet imported the ${imported} most recent — that's all it can back up alongside your other contacts.`;
}
