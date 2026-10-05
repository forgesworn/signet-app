/**
 * One run of "import who this account follows", for the screens that offer it
 * (a persona's Advanced page, the end of a Personas nsec import).
 *
 * Read Nostr -> write contacts. Nothing here ever publishes: Signet does not
 * touch anyone's kind 3. The pieces are injected so the whole sequence can be
 * tested without a relay or a database.
 */

import type { ContactRecord } from '../types';
import {
  FOLLOWS_ORIGIN_CAPTION,
  MAX_FOLLOWS_PER_IMPORT,
  computeUnfollows,
  fetchFollowList,
  fetchKind0Profiles,
  fetchFollowNames,
  followsTrimmedCopy,
  nameFollows,
  takeMostRecent,
  type FollowList,
  type Kind0Profile,
} from './nostr-follows';
import type { PictureRunResult } from './contact-pictures';
import type { FollowImportEntry, FollowsImportResult } from './contacts-v2-follows-import';

export interface FollowsImportDeps {
  personaPubkey: string;
  personaName: string;
  /** The directory's records as they stand BEFORE the import (for the unfollow check). */
  records: ContactRecord[];
  fetchList?: (pubkey: string) => Promise<FollowList | null | 'unreachable'>;
  fetchNames?: (pubkeys: string[]) => Promise<Map<string, string>>;
  /**
   * Profile pictures, ONLY when the user agreed to the download step for this
   * run (`pictures: true`). Then the one kind-0 fetch supplies names and
   * picture URLs, and `syncPictures` downloads what changed for the follows
   * this run covered. Without consent the import is names only, as before.
   */
  pictures?: boolean;
  fetchProfiles?: (pubkeys: string[]) => Promise<Map<string, Kind0Profile>>;
  syncPictures?: (pubkeys: string[], profiles: Map<string, Kind0Profile>) => Promise<PictureRunResult>;
  recogniseContacts: (entries: FollowImportEntry[], owner: string, method: 'import', caption: string) => Promise<FollowsImportResult>;
  /** Persist the device-local "last import" record. Only called when something was covered. */
  recordImport: (state: { eventId: string; createdAt: number; importedAt: number; count: number }) => Promise<void>;
  now?: () => number;
}

/** What a screen needs to offer the import for one persona. */
export interface FollowsImportOptions {
  /** The user agreed to "Download their profile pictures?" for this run. */
  pictures: boolean;
}

export interface FollowsHandlers {
  onImportFollows: (opts: FollowsImportOptions) => Promise<FollowsImportOutcome>;
  /** Whether this install may download pictures at all (never on a paired-child install). */
  picturesAvailable?: boolean;
  onUnlinkFollows: (contactIds: string[]) => Promise<number>;
}

export interface UnfollowedContact {
  contactId: string;
  name: string;
}

export type FollowsImportOutcome =
  | { status: 'unreachable' }
  /** A kind 3 was found with nobody in it, or none was found at all. */
  | { status: 'empty'; found: boolean }
  | {
      status: 'done';
      /** How many accounts the newest kind 3 follows. */
      total: number;
      /** Unix seconds of that kind 3. */
      createdAt: number;
      added: number;
      linked: number;
      unchanged: number;
      /** Follows left alone because the user had removed that contact. */
      skippedRemoved: number;
      /** How many of the most recent follows were covered. */
      covered: number;
      /** Plain-English line to show when not every follow could be imported; `null` when all were. */
      trimmedNotice: string | null;
      /** Contacts from an earlier import that are no longer followed and may be taken off the list. */
      unfollowed: UnfollowedContact[];
      /** Unfollowed contacts whose only list this is — kept, since taking them off would remove them. */
      unfollowedKept: number;
      /** Only when pictures were agreed to: how many downloaded / couldn't be. */
      pictures?: { downloaded: number; failed: number };
    };

export async function runFollowsImport(deps: FollowsImportDeps): Promise<FollowsImportOutcome> {
  const fetchList = deps.fetchList ?? ((pubkey: string) => fetchFollowList(pubkey, []));
  const fetchNames = deps.fetchNames ?? ((pubkeys: string[]) => fetchFollowNames(pubkeys, []));
  const now = deps.now ?? Date.now;

  const list = await fetchList(deps.personaPubkey);
  if (list === 'unreachable') return { status: 'unreachable' };
  if (!list) return { status: 'empty', found: false };
  if (list.follows.length === 0) return { status: 'empty', found: true };

  // Rule 1: at most 1000 per run, the most recent (the end of the tag order).
  const chosen = takeMostRecent(list.follows, MAX_FOLLOWS_PER_IMPORT);
  const withPictures = deps.pictures === true && !!deps.syncPictures;
  let profiles: Map<string, Kind0Profile> | null = null;
  let names: Map<string, string>;
  if (withPictures) {
    profiles = await (deps.fetchProfiles ?? ((pubkeys: string[]) => fetchKind0Profiles(pubkeys, [])))(chosen.map(f => f.pubkey));
    names = new Map();
    for (const [pubkey, profile] of profiles) if (profile.displayName) names.set(pubkey, profile.displayName);
  } else {
    names = await fetchNames(chosen.map(f => f.pubkey));
  }
  const entries = nameFollows(chosen, names);

  // The unfollow check runs on the records as they were before this import —
  // the import only adds follows, so it cannot change who is NOT followed. A
  // kind 3 whose tail was not read cannot say who is missing from it.
  const unfollow = list.truncated
    ? { removable: [], onlyOnThisList: [] }
    : computeUnfollows(deps.records, deps.personaPubkey, new Set(list.follows.map(f => f.pubkey)));

  // Rule 2 (the size line) is the hook's: it trims to what the backup can carry.
  const summary = await deps.recogniseContacts(entries, deps.personaPubkey, 'import', FOLLOWS_ORIGIN_CAPTION);

  const covered = summary.trimmed ? summary.covered : chosen.length;
  if (covered > 0) {
    await deps.recordImport({ eventId: list.eventId, createdAt: list.createdAt, importedAt: now(), count: list.total });
  }
  const notAll = summary.trimmed || chosen.length < list.follows.length;

  // Pictures only for the follows this run actually filed (the most recent `covered`).
  let pictures: { downloaded: number; failed: number } | undefined;
  if (withPictures && profiles && deps.syncPictures) {
    const filed = covered > 0 ? chosen.slice(chosen.length - covered).map(f => f.pubkey) : [];
    try {
      const r = filed.length > 0 ? await deps.syncPictures(filed, profiles) : { downloaded: 0, failed: 0 };
      pictures = { downloaded: r.downloaded, failed: r.failed };
    } catch {
      pictures = { downloaded: 0, failed: filed.filter(p => profiles?.get(p)?.pictureUrl).length };
    }
  }
  return {
    status: 'done',
    total: list.total,
    createdAt: list.createdAt,
    added: summary.added,
    linked: summary.linked,
    unchanged: summary.unchanged,
    skippedRemoved: summary.skippedRemoved,
    covered,
    trimmedNotice: notAll
      ? (covered === 0
        ? `${deps.personaName} follows ${list.total} ${list.total === 1 ? 'account' : 'accounts'}, but there's no room left in your contacts backup to add ${list.total === 1 ? 'it' : 'them'}.`
        : followsTrimmedCopy(deps.personaName, list.total, covered))
      : null,
    unfollowed: unfollow.removable.map(r => ({ contactId: r.contactId, name: r.displayName })),
    unfollowedKept: unfollow.onlyOnThisList.length,
    ...(pictures ? { pictures } : {}),
  };
}
