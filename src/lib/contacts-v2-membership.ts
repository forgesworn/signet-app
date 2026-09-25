import type { ContactListMembership, ContactRecord } from '../types';

const HEX64 = /^[0-9a-f]{64}$/;

/** Old records have unknown list ownership, never implicit access to every list. */
export function contactBelongsToList(record: ContactRecord, ownerIdentityPubkey: string): boolean {
  return record.listMemberships?.some(m => m.ownerIdentityPubkey === ownerIdentityPubkey
    && m.removedAt === undefined) ?? false;
}

export function validContactLists(raw: Record<string, unknown>): boolean {
  if (raw.listMemberships === undefined) return raw.primaryIdentityPubkey === undefined;
  if (!Array.isArray(raw.listMemberships)) return false;
  const seen = new Set<string>();
  const active: string[] = [];
  for (const m of raw.listMemberships) {
    if (!m || typeof m !== 'object' || typeof m.ownerIdentityPubkey !== 'string'
      || !HEX64.test(m.ownerIdentityPubkey) || seen.has(m.ownerIdentityPubkey)
      || !Number.isFinite(m.addedAt) || m.addedAt < 0
      || (m.removedAt !== undefined && (!Number.isFinite(m.removedAt) || m.removedAt < 0))) return false;
    seen.add(m.ownerIdentityPubkey);
    if (m.removedAt === undefined) active.push(m.ownerIdentityPubkey);
  }
  return active.length === 0 ? raw.primaryIdentityPubkey === undefined
    : typeof raw.primaryIdentityPubkey === 'string' && active.includes(raw.primaryIdentityPubkey);
}

export function linkContactList(record: ContactRecord, ownerIdentityPubkey: string, at: number): ContactRecord {
  if (contactBelongsToList(record, ownerIdentityPubkey)) return record;
  const memberships = (record.listMemberships ?? []).filter(m => m.ownerIdentityPubkey !== ownerIdentityPubkey);
  return {
    ...record,
    listMemberships: [...memberships, { ownerIdentityPubkey, addedAt: at }],
    primaryIdentityPubkey: record.primaryIdentityPubkey ?? ownerIdentityPubkey,
    updatedAt: at,
    createdAt: Math.min(record.createdAt, at),
  };
}

function oldest(memberships: ContactListMembership[]): string | undefined {
  return memberships.filter(m => m.removedAt === undefined).sort((a, b) =>
    a.addedAt - b.addedAt || (a.ownerIdentityPubkey < b.ownerIdentityPubkey ? -1 : 1),
  )[0]?.ownerIdentityPubkey;
}

export function unlinkContactList(record: ContactRecord, ownerIdentityPubkey: string, at: number): ContactRecord {
  if (!contactBelongsToList(record, ownerIdentityPubkey)) return record;
  const listMemberships = record.listMemberships!.map(m => m.ownerIdentityPubkey === ownerIdentityPubkey
    ? { ...m, removedAt: at } : m);
  const primaryIdentityPubkey = record.primaryIdentityPubkey === ownerIdentityPubkey
    ? oldest(listMemberships) : record.primaryIdentityPubkey;
  return {
    ...record, listMemberships, primaryIdentityPubkey, updatedAt: at,
    ...(primaryIdentityPubkey === undefined ? { lifecycle: 'removed', removedAt: at } : {}),
  };
}

/** Removing everywhere preserves both block facts and past membership. */
export function removeContactLists(record: ContactRecord, at: number): ContactRecord {
  if (!record.listMemberships) return record;
  return {
    ...record, primaryIdentityPubkey: undefined,
    listMemberships: record.listMemberships.map(m => m.removedAt === undefined ? { ...m, removedAt: at } : m),
  };
}
