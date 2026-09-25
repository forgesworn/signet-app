/**
 * Per-rail "last relay record we saw" marker, one row per (author, d-tag) in the
 * `syncSeen` IDB store (DB v22). Lets a rail's fetch result distinguish
 * "there's genuinely nothing on the relay yet" from "there used to be a
 * record here and now the relay can't produce it" — the latter is worth
 * surfacing as a possible lost backup, the former isn't.
 *
 * Its own store rather than a field on `AppPreferences`: five rails write
 * this on every successful fetch, and a read-modify-write of the whole
 * preferences record per rail is a lost-update race between them. Rows are
 * unencrypted routing metadata (event id + timestamp) — see the store's
 * comment in `db.ts`.
 */

import * as db from './db';

export type SyncRemoteState = 'present' | 'never-seen' | 'missing-after-seen' | 'unreachable';

/** Legacy rows used the bare d-tag and cannot be attributed to an author.
 * Keep them for old clients, but never use them for a shared rail. Contacts v2
 * callers may explicitly migrate their already author-derived tags, preserving
 * checkpoint sequence high-water marks across this upgrade. */
function markerKey(authorPubkey: string, dTag: string): string {
  if (!/^[0-9a-f]{64}$/i.test(authorPubkey)) throw new Error('Invalid sync author');
  return JSON.stringify([authorPubkey.toLowerCase(), dTag]);
}

/** Last relay read for this author and rail, or null if never recorded. */
export async function getSyncSeen(authorPubkey: string, dTag: string, options?: { legacyAuthorScopedTag: true }): Promise<{ eventId: string; createdAt: number; seq?: number } | null> {
  const key = markerKey(authorPubkey, dTag);
  let row = await db.getSyncSeen(key);
  if (!row && options?.legacyAuthorScopedTag) {
    row = await db.getSyncSeen(dTag);
    if (row) await db.putSyncSeen({ ...row, dTag: key });
  }
  if (!row) return null;
  return row.seq === undefined
    ? { eventId: row.eventId, createdAt: row.createdAt }
    : { eventId: row.eventId, createdAt: row.createdAt, seq: row.seq };
}

/** Record a relay read scoped to its author and d-tag. */
export async function setSyncSeen(
  authorPubkey: string,
  dTag: string,
  seen: { eventId: string; createdAt: number; seq?: number },
): Promise<void> {
  await db.putSyncSeen({
    dTag: markerKey(authorPubkey, dTag),
    eventId: seen.eventId,
    createdAt: seen.createdAt,
    ...(seen.seq === undefined ? {} : { seq: seen.seq }),
  });
}

/**
 * Classify a rail's fetch attempt into a state the UI can render.
 * `found` wins outright; otherwise an unreachable pool is reported as
 * such regardless of history, and only then does "did we see a record
 * here before" distinguish never-seen from missing-after-seen.
 */
export function classifyFetchOutcome(args: {
  found: boolean;
  reachableRelays: number;
  seenBefore: boolean;
}): SyncRemoteState {
  if (args.found) return 'present';
  if (args.reachableRelays === 0) return 'unreachable';
  return args.seenBefore ? 'missing-after-seen' : 'never-seen';
}
