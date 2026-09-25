/**
 * The Contacts screen's list model: filter, search, sort.
 *
 * "Blocked" is a filter beside the three tiers rather than a fourth tier —
 * spec section 7.9 is explicit that Blocked is a status a Kin, Kith or Ken can
 * independently carry. A blocked contact therefore keeps its tier but is
 * withheld from the tier filters and sorted to the end of All, so the ordinary
 * browsing view never hands somebody a blocked contact as if nothing happened.
 */
import type { ContactRecord, EffectiveContact } from '../types';

export type ContactsFilter = 'all' | 'kin' | 'kith' | 'ken' | 'blocked';

export const CONTACT_FILTERS: readonly ContactsFilter[] = ['all', 'kin', 'kith', 'ken', 'blocked'];

const FILTER_LABELS: Record<ContactsFilter, string> = {
  all: 'All', kin: 'Kin', kith: 'Kith', ken: 'Ken', blocked: 'Blocked',
};

export function filterLabel(filter: ContactsFilter): string {
  return FILTER_LABELS[filter];
}

/**
 * The identity a row's avatar and QR are keyed on: the newest proven or mutual
 * identity, else the earliest identity, else null for a keyless contact.
 */
export function primaryIdentityPubkey(record: Pick<ContactRecord, 'identities'>): string | null {
  if (record.identities.length === 0) return null;
  const proven = record.identities.filter(i => i.verification !== 'unverified');
  if (proven.length > 0) {
    return proven.reduce((best, i) => (i.addedAt > best.addedAt ? i : best)).pubkey;
  }
  return record.identities.reduce((best, i) => (i.addedAt < best.addedAt ? i : best)).pubkey;
}

export function isKeyless(record: Pick<ContactRecord, 'identities'>): boolean {
  return record.identities.length === 0;
}

export function isVisibleContact(record: Pick<ContactRecord, 'lifecycle' | 'archived'>): boolean {
  return record.lifecycle !== 'removed' && record.archived !== true;
}

function haystack(c: EffectiveContact): string {
  return [c.displayName, ...c.roles, ...c.identities.map(i => i.pubkey)].join(' ').toLowerCase();
}

export function arrangeContactsV2(
  list: EffectiveContact[],
  opts: { filter: ContactsFilter; query: string },
): EffectiveContact[] {
  const q = opts.query.trim().toLowerCase();
  const filtered = list
    .filter(isVisibleContact)
    .filter(c => {
      if (opts.filter === 'all') return true;
      if (opts.filter === 'blocked') return c.blocked;
      return !c.blocked && c.effectiveTier === opts.filter;
    })
    .filter(c => !q || haystack(c).includes(q));

  // P6: `Array.prototype.sort` is stable (ES2019+), so a tie (equal blocked
  // status AND equal display name) keeps the incoming order rather than
  // reordering unpredictably.
  return filtered.sort((a, b) => {
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    return a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase());
  });
}
