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
  fetchFollowNames,
  followsTrimmedCopy,
  nameFollows,
  takeMostRecent,
  type FollowList,
} from './nostr-follows';
import type { FollowImportEntry, FollowsImportResult } from './contacts-v2-follows-import';

export interface FollowsImportDeps {
  personaPubkey: string;
  personaName: string;
  /** The directory's records as they stand BEFORE the import (for the unfollow check). */
  records: ContactRecord[];
  fetchList?: (pubkey: string) => Promise<FollowList | null | 'unreachable'>;
  fetchNames?: (pubkeys: string[]) => Promise<Map<string, string>>;
  recogniseContacts: (entries: FollowImportEntry[], owner: string, method: 'import', caption: string) => Promise<FollowsImportResult>;
  /** Persist the device-local "last import" record. Only called when something was covered. */
  recordImport: (state: { eventId: string; createdAt: number; importedAt: number; count: number }) => Promise<void>;
  now?: () => number;
}

/** What a screen needs to offer the import for one persona. */
export interface FollowsHandlers {
  onImportFollows: () => Promise<FollowsImportOutcome>;
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
      /** How many of the most recent follows were covered. */
      covered: number;
      /** Plain-English line to show when not every follow could be imported; `null` when all were. */
      trimmedNotice: string | null;
      /** Contacts from an earlier import that are no longer followed and may be taken off the list. */
      unfollowed: UnfollowedContact[];
      /** Unfollowed contacts whose only list this is — kept, since taking them off would remove them. */
      unfollowedKept: number;
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
  const names = await fetchNames(chosen.map(f => f.pubkey));
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
  return {
    status: 'done',
    total: list.total,
    createdAt: list.createdAt,
    added: summary.added,
    linked: summary.linked,
    unchanged: summary.unchanged,
    covered,
    trimmedNotice: notAll
      ? (covered === 0
        ? `${deps.personaName} follows ${list.total} accounts. Signet couldn't import any of them — that's all it can back up alongside your other contacts.`
        : followsTrimmedCopy(deps.personaName, list.total, covered))
      : null,
    unfollowed: unfollow.removable.map(r => ({ contactId: r.contactId, name: r.displayName })),
    unfollowedKept: unfollow.onlyOnThisList.length,
  };
}
