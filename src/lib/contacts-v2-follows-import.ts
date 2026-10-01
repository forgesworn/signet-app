/**
 * The operations a Nostr-follows import writes — pure, so the batch write in
 * `useContactsV2.recogniseContacts` is one read, one plan, one save.
 *
 * Per follow (in the order given, oldest first):
 *   - a contact that already carries the key and is not removed: `link-list`
 *     to the persona's list only if it is not already an active member
 *     (otherwise nothing at all). Tier, name and notes are never touched.
 *   - a removed contact carrying the key: revived the way `recogniseContact`
 *     revives it — an `add` that reuses its own name and tier.
 *   - no contact: `add` (tier `ken`) + `add-identity` (`direct`, `unverified`).
 *   Plus a `record-origin` (`import`, captioned) only for a contact that got a
 *   new `add` or `link-list`, and only while it has room for another origin
 *   (the cap is 64; a full contact skips the origin, never throws).
 *
 * Size: the whole contacts log must fit ONE checkpoint, so the plan is
 * trimmed — keeping the MOST RECENT follows (the end of the list) — until the
 * checkpoint it would produce is under `CHECKPOINT_IMPORT_LINE_BYTES` and
 * `CHECKPOINT_IMPORT_LINE_OPS`, measured with the rail's own chunking rule.
 */

import type { ContactOperation, ContactRecord } from '../types';
import type { ContactOrigin } from './contact-origins';
import { contactBelongsToList } from './contacts-v2-membership';
import { buildOperation, type MutationActor } from './contacts-v2-mutations';
import { newContactId, newOperationId } from './contacts-v2-ids';
import { sanitizeDisplayName } from './text-sanitize';
import {
  CHECKPOINT_IMPORT_LINE_BYTES,
  CHECKPOINT_IMPORT_LINE_OPS,
  operationWireBytes,
  projectCheckpointFromSizes,
} from './contacts-v2-sync';

const HEX64 = /^[0-9a-f]{64}$/;

export interface FollowImportEntry {
  pubkey: string;
  displayName: string;
}

export interface FollowImportPlan {
  /** Stamped, contiguous clocks, ready to validate and save. Empty = nothing to do. */
  ops: ContactOperation[];
  /** New contacts created (a revived contact counts here). */
  added: number;
  /** Existing contacts newly linked to the list. */
  linked: number;
  /** Follows that needed nothing (already in the list). */
  unchanged: number;
  /** Follows the plan covers (after any trim). Fewer than the input means the size line cut the oldest. */
  covered: number;
  /** True when the size line trimmed the plan. */
  trimmed: boolean;
}

/** What a batch import did, for the screen that asked for it. */
export type FollowsImportResult = Pick<FollowImportPlan, 'added' | 'linked' | 'unchanged' | 'covered' | 'trimmed'> & {
  /** Follows handed in, before the size line. */
  requested: number;
};

interface Group {
  kind: 'added' | 'linked';
  /** Index of the entry in the deduped input. */
  entryIndex: number;
  ops: ContactOperation[];
}

export function planFollowsImport(args: {
  entries: FollowImportEntry[];
  ownerIdentityPubkey: string;
  originMethod: ContactOrigin['method'];
  caption: string;
  directoryId: string;
  /** The directory's reduced records (every state, removed included). */
  records: ContactRecord[];
  actor: MutationActor;
  /** Highest Lamport clock in the log; the plan's first op is `baseClock + 1`. */
  baseClock: number;
  now: number;
  /** The WHOLE log (every directory) — it is what the rail checkpoints. */
  wholeLog: readonly ContactOperation[];
  newId?: () => string;
  lineBytes?: number;
  lineOps?: number;
}): FollowImportPlan {
  const newId = args.newId ?? newContactId;
  const lineBytes = args.lineBytes ?? CHECKPOINT_IMPORT_LINE_BYTES;
  const lineOps = args.lineOps ?? CHECKPOINT_IMPORT_LINE_OPS;
  const owner = args.ownerIdentityPubkey;

  // Index the directory's records by identity key, preferring a live record.
  const byKey = new Map<string, ContactRecord>();
  for (const record of args.records) {
    for (const identity of record.identities) {
      const held = byKey.get(identity.pubkey);
      if (!held || (held.lifecycle === 'removed' && record.lifecycle !== 'removed')) byKey.set(identity.pubkey, record);
    }
  }

  // Dedupe entries by key AND by the contact they resolve to (two keys of one
  // contact are one contact's worth of work).
  const seenKeys = new Set<string>();
  const seenContacts = new Set<string>();
  const entries: FollowImportEntry[] = [];
  for (const entry of args.entries) {
    const key = entry.pubkey.toLowerCase();
    if (!HEX64.test(key) || seenKeys.has(key)) continue;
    seenKeys.add(key);
    const existing = byKey.get(key);
    if (existing) {
      if (seenContacts.has(existing.contactId)) continue;
      seenContacts.add(existing.contactId);
    }
    entries.push({ pubkey: key, displayName: sanitizeDisplayName(entry.displayName ?? '', 100) || 'Unnamed' });
  }

  // Drafts carry placeholder clocks; the survivors are stamped afterwards.
  const make = (contactId: string, action: ContactOperation['action'], value: unknown): ContactOperation => buildOperation({
    directoryId: args.directoryId, contactId, action, value, clock: 1, actor: args.actor, now: args.now,
    operationId: newOperationId(),
  });
  const origin = (contactId: string): ContactOperation => ({
    ...make(contactId, 'record-origin', {
      id: newId(), ownerIdentityPubkey: owner, method: args.originMethod, addedAt: args.now, caption: args.caption,
    }),
    ownerIdentityPubkey: owner,
  });

  let unchanged = 0;
  const groups: Group[] = [];
  entries.forEach((entry, entryIndex) => {
    const existing = byKey.get(entry.pubkey);
    let ops: ContactOperation[];
    let kind: Group['kind'];
    if (existing && existing.lifecycle !== 'removed') {
      if (contactBelongsToList(existing, owner)) { unchanged += 1; return; }
      ops = [make(existing.contactId, 'link-list', { ownerIdentityPubkey: owner })];
      kind = 'linked';
      if ((existing.origins?.length ?? 0) < 64) ops.push(origin(existing.contactId));
    } else if (existing) {
      ops = [make(existing.contactId, 'add', {
        type: existing.type, displayName: existing.displayName, tier: existing.tier ?? 'ken', ownerIdentityPubkey: owner,
      })];
      kind = 'added';
      if ((existing.origins?.length ?? 0) < 64) ops.push(origin(existing.contactId));
    } else {
      const contactId = newId();
      ops = [
        make(contactId, 'add', { type: 'person', displayName: entry.displayName, tier: 'ken', ownerIdentityPubkey: owner }),
        make(contactId, 'add-identity', { itemId: newId(), pubkey: entry.pubkey, provenance: 'direct', verification: 'unverified' }),
        origin(contactId),
      ];
      kind = 'added';
    }
    groups.push({ kind, entryIndex, ops });
  });

  const stamp = (from: number): ContactOperation[] => {
    let clock = args.baseClock;
    const out: ContactOperation[] = [];
    for (let g = from; g < groups.length; g += 1) {
      for (const op of groups[g].ops) { clock += 1; out.push({ ...op, logicalClock: clock }); }
    }
    return out;
  };

  const existingSizes = args.wholeLog.map(operationWireBytes);
  const fitsFrom = (from: number): boolean => {
    const added = stamp(from);
    if (existingSizes.length + added.length > lineOps) return false;
    const projection = projectCheckpointFromSizes([...existingSizes, ...added.map(operationWireBytes)]);
    return projection.fits && projection.bytes <= lineBytes;
  };

  // The largest suffix of groups (the MOST RECENT follows) that fits. Cost only
  // grows as the suffix does, so a binary search finds it in a few projections.
  let from = 0;
  if (groups.length > 0 && !fitsFrom(0)) {
    // Search the START index of the kept suffix. Invariant: starting at `hi`
    // fits (`groups.length` is the empty suffix, taken as fitting) and
    // starting at `lo` does not; find the smallest start that fits.
    let lo = 0;
    let hi = groups.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (fitsFrom(mid)) hi = mid; else lo = mid;
    }
    from = hi;
  }
  const trimmed = from > 0;
  const kept = groups.slice(from);
  const ops = stamp(from);
  const firstKeptEntry = kept.length > 0 ? kept[0].entryIndex : entries.length;
  return {
    ops,
    added: kept.filter(g => g.kind === 'added').length,
    linked: kept.filter(g => g.kind === 'linked').length,
    unchanged: trimmed ? countUnchangedFrom(entries, groups, firstKeptEntry) : unchanged,
    covered: trimmed ? entries.length - firstKeptEntry : entries.length,
    trimmed,
  };
}

/** Unchanged follows that sit inside the covered (most recent) part of the list. */
function countUnchangedFrom(entries: FollowImportEntry[], groups: Group[], firstKeptEntry: number): number {
  const withOps = new Set(groups.map(g => g.entryIndex));
  let n = 0;
  for (let i = firstKeptEntry; i < entries.length; i += 1) if (!withOps.has(i)) n += 1;
  return n;
}
