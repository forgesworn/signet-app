/**
 * The family manager's table model.
 *
 * Membership is keyed by `(directoryId, contactId)`, so the same real person
 * genuinely has independent records per directory; the table's job is to show
 * them side by side WITHOUT merging them. Grouping is therefore by exact
 * identity-pubkey overlap and nothing else — never by display name, phone or
 * email (spec section 7.10: those indexes support lookup but are never record
 * identity or automatic merge evidence). A keyless record can never be shown
 * as "the same person" as anything, so it gets its own row.
 *
 * Overlap is transitive: two records that share one of several pubkeys are the
 * same row, resolved by a small union-find over the pubkeys.
 */
import type { ContactCeilingTier, ContactTierSource, EffectiveContact } from '../types';
import { isVisibleContact } from './contacts-v2-list';
import { activeBlocks } from './contacts-v2-rights';

export interface ManagerDirectory {
  directoryId: string;
  /** "You", or the dependant's display name. */
  label: string;
  isOwner: boolean;
  contacts: EffectiveContact[];
}

export interface ManagerCell {
  directoryId: string;
  present: boolean;
  contactId: string | null;
  /** The local name used in that directory — never copied between them. */
  localName: string | null;
  effectiveTier: ContactCeilingTier | null;
  tierSource: ContactTierSource | null;
  blocked: boolean;
  /** True when every active block on that record was applied by this actor. */
  blockedByActor: boolean;
  /** Most restrictive active ceiling on that record, from ANY guardian, or null. */
  ceilingMaxTier: ContactCeilingTier | null;
  /**
   * R-CEILING-DISPLAY: THIS actor's own active ceiling on the record, or
   * null. The manager's editable `<select>` must show and edit only this —
   * never `ceilingMaxTier`, which can be a co-guardian's cap the acting
   * guardian has no authority to change (the reducer's `ceiling`/
   * `revoke-ceiling` actions require `guardianPubkey === actorPubkey`).
   */
  actorCeilingMaxTier: ContactCeilingTier | null;
}

export interface ManagerRow {
  rowKey: string;
  /** The canonical pubkey the row groups on; null for a keyless row. */
  groupPubkey: string | null;
  displayName: string;
  identityPubkeys: string[];
  cells: ManagerCell[];
}

const CEILING_RANK: Record<ContactCeilingTier, number> = { none: 0, ken: 1, kith: 2, kin: 3 };

function mostRestrictiveCeiling(record: EffectiveContact): ContactCeilingTier | null {
  const active = record.ceilings.filter(c => !c.revokedByOperationId);
  if (active.length === 0) return null;
  return active.reduce((lowest, c) =>
    CEILING_RANK[c.maxTier] < CEILING_RANK[lowest] ? c.maxTier : lowest, active[0].maxTier);
}

/** This actor's own active ceiling on the record, or null. */
function actorCeiling(record: EffectiveContact, actorPubkey: string): ContactCeilingTier | null {
  const mine = record.ceilings.find(c => !c.revokedByOperationId && c.guardianPubkey.toLowerCase() === actorPubkey);
  return mine ? mine.maxTier : null;
}

/**
 * R-CEILING-DISPLAY: true when the most restrictive ceiling on the cell
 * (from any guardian) is STRICTER than what the acting guardian set
 * themselves — either a co-guardian's cap outranks the actor's own, or the
 * actor has none at all while a co-guardian does. Never true when the
 * actor's own ceiling IS the binding one, even if it happens to equal the
 * most restrictive value.
 */
export function coGuardianCeilingIsStricter(
  cell: Pick<ManagerCell, 'ceilingMaxTier' | 'actorCeilingMaxTier'>,
): boolean {
  if (cell.ceilingMaxTier === null) return false;
  if (cell.actorCeilingMaxTier === null) return true;
  return CEILING_RANK[cell.ceilingMaxTier] < CEILING_RANK[cell.actorCeilingMaxTier];
}

/** Union-find over identity pubkeys, so shared-key records land in one row. */
class Groups {
  private parent = new Map<string, string>();
  find(key: string): string {
    const seen = this.parent.get(key);
    if (seen === undefined) { this.parent.set(key, key); return key; }
    if (seen === key) return key;
    const root = this.find(seen);
    this.parent.set(key, root);
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // Lexicographically smallest root keeps the grouping deterministic.
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
}

function emptyCell(directoryId: string): ManagerCell {
  return {
    directoryId, present: false, contactId: null, localName: null,
    effectiveTier: null, tierSource: null, blocked: false,
    blockedByActor: false, ceilingMaxTier: null, actorCeilingMaxTier: null,
  };
}

export function buildManagerRows(
  directories: ManagerDirectory[],
  opts: { actorPubkey: string },
): ManagerRow[] {
  const actor = opts.actorPubkey.toLowerCase();
  const groups = new Groups();

  interface Entry { directoryId: string; record: EffectiveContact; pubkeys: string[] }
  const entries: Entry[] = [];

  for (const dir of directories) {
    for (const record of dir.contacts) {
      if (!isVisibleContact(record)) continue;
      const pubkeys = record.identities.map(i => i.pubkey.toLowerCase());
      for (let i = 1; i < pubkeys.length; i++) groups.union(pubkeys[0], pubkeys[i]);
      if (pubkeys.length > 0) groups.find(pubkeys[0]);
      entries.push({ directoryId: dir.directoryId, record, pubkeys });
    }
  }

  const rows = new Map<string, ManagerRow>();

  for (const entry of entries) {
    const keyed = entry.pubkeys.length > 0;
    const groupPubkey = keyed ? groups.find(entry.pubkeys[0]) : null;
    const baseRowKey = keyed
      ? `pk:${groupPubkey}`
      : `keyless:${entry.directoryId}/${entry.record.contactId}`;
    const index = directories.findIndex(d => d.directoryId === entry.directoryId);

    // P5: two DISTINCT records that both land in this directory can still
    // group onto the same `baseRowKey` (each shares a pubkey with a third
    // record elsewhere, or with each other directly) — but a row has only
    // ONE cell per directory. Without this check the second record's cell
    // assignment below would silently clobber the first's, dropping a real
    // record rather than just mis-grouping it. Give the second (and any
    // further) collision its own row instead, keyed off the exact
    // directory+contactId so it's stable across a re-run of this function.
    let rowKey = baseRowKey;
    let existing = rows.get(baseRowKey);
    if (existing && existing.cells[index].present && existing.cells[index].contactId !== entry.record.contactId) {
      rowKey = `${baseRowKey}#${entry.directoryId}/${entry.record.contactId}`;
      existing = rows.get(rowKey);
    }

    let row = existing;
    if (!row) {
      row = {
        rowKey,
        groupPubkey,
        displayName: entry.record.displayName,
        identityPubkeys: [],
        cells: directories.map(d => emptyCell(d.directoryId)),
      };
      rows.set(rowKey, row);
    }

    for (const pk of entry.pubkeys) {
      if (!row.identityPubkeys.includes(pk)) row.identityPubkeys.push(pk);
    }

    const dir = directories.find(d => d.directoryId === entry.directoryId);
    // The owner's own local name labels the row when the owner has a record;
    // otherwise the first directory to supply one wins.
    if (dir?.isOwner) row.displayName = entry.record.displayName;

    const blocks = activeBlocks(entry.record);
    row.cells[index] = {
      directoryId: entry.directoryId,
      present: true,
      contactId: entry.record.contactId,
      localName: entry.record.displayName,
      effectiveTier: entry.record.effectiveTier,
      tierSource: entry.record.tierSource,
      blocked: entry.record.blocked,
      blockedByActor: blocks.length > 0 && blocks.every(b => b.blockedBy.toLowerCase() === actor),
      ceilingMaxTier: mostRestrictiveCeiling(entry.record),
      actorCeilingMaxTier: actorCeiling(entry.record, actor),
    };
  }

  return [...rows.values()].sort((a, b) =>
    a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
}
