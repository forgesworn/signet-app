/**
 * Who holds, or once held, a key — and the guard that stops "Confirm it's
 * them" from merging two people.
 *
 * The reducer groups records that hold the same key (`applyOperations`), and a
 * deleted or archived contact keeps its keys. So adding a scanned key to one
 * contact can silently fold it into another — including a tombstone, which
 * makes the contact being confirmed vanish. The confirm flow refuses that up
 * front (`decideScan`, from the history below) and again, authoritatively,
 * inside the queued write (`confirmMergeRefusal`).
 *
 * Kept apart from `contacts-v2-confirm.ts` so the contacts hook can import it
 * without pulling in the QR parsers.
 */
import type { AddIdentityValue, ContactOperation, ContactRecord } from '../types';
import { applyOperations, validateOperation } from './contacts-v2-reducer';
import { contactDisplayName } from './contacts-v2-name';

/** How the other contact relates to the key: it holds it now, or the key was taken off it. */
export type OtherContactState = 'active' | 'deleted' | 'archived' | 'removed-key';

export interface ConfirmRefusal {
  contactId: string;
  displayName: string;
  state: OtherContactState;
}

/** A thrown refusal from the queued write: nothing was written. */
export class ConfirmMergeRefusedError extends Error {
  readonly refusal: ConfirmRefusal;
  constructor(refusal: ConfirmRefusal) {
    super('contacts: that key belongs to another contact');
    this.name = 'ConfirmMergeRefusedError';
    this.refusal = refusal;
  }
}

/** A contact's own state: deleted and archived records keep their keys. */
export function contactRecordState(record: Pick<ContactRecord, 'lifecycle' | 'archived'>): 'active' | 'deleted' | 'archived' {
  if (record.lifecycle !== 'removed') return 'active';
  return record.archived ? 'archived' : 'deleted';
}

/**
 * Every contact id an add-identity or key-link ever put `pubkey` on, in log
 * order, whether or not the key is still there. Ids are the ids the
 * operations were written against; a caller maps them to records through
 * `contactId` or `mergedContactIds`.
 */
export function keyHolderIds(ops: ContactOperation[], pubkey: string): string[] {
  const key = pubkey.toLowerCase();
  const ids: string[] = [];
  for (const op of ops) {
    if (op.action !== 'add-identity' && op.action !== 'key-link') continue;
    if (!validateOperation(op) || (op.value as AddIdentityValue).pubkey !== key) continue;
    if (!ids.includes(op.contactId)) ids.push(op.contactId);
  }
  return ids;
}

function findRecord(map: Map<string, ContactRecord>, contactId: string): ContactRecord | undefined {
  for (const record of map.values()) {
    if (record.contactId === contactId || record.mergedContactIds?.includes(contactId)) return record;
  }
  return undefined;
}

const groupIds = (record: ContactRecord) => [record.contactId, ...(record.mergedContactIds ?? [])];

/**
 * Would appending `planned` to `current` pull any other contact into
 * `contactId`'s group (or fold `contactId` into someone else's)? Compares the
 * group before and after rather than asking "is it grouped at all", so a
 * contact that is ALREADY a legitimate merge (the same npub created on two
 * devices) can still be confirmed. Returns the contact it would merge with,
 * or null when the write is safe.
 */
export function confirmMergeRefusal(
  current: ContactOperation[],
  planned: ContactOperation[],
  contactId: string,
): ConfirmRefusal | null {
  const before = applyOperations(current);
  const target = findRecord(before, contactId);
  if (!target) return null;
  const after = findRecord(applyOperations([...current, ...planned]), contactId);
  const known = new Set(groupIds(target));
  const newcomers = after ? groupIds(after).filter(id => !known.has(id)) : [];
  if (after && after.contactId === target.contactId && newcomers.length === 0) return null;
  const other = newcomers.map(id => findRecord(before, id)).find(Boolean);
  if (!other) return { contactId: after?.contactId ?? contactId, displayName: after ? contactDisplayName(after) : '', state: 'active' };
  return { contactId: other.contactId, displayName: contactDisplayName(other), state: contactRecordState(other) };
}
