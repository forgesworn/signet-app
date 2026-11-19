/**
 * Saving the New contact form, and spotting a key that is already a contact.
 *
 * Takes the slice of `useContactsV2` it needs so it can be driven without
 * React. The operations are stamped by whatever scope actor the hook already
 * holds (child mode is the child); nothing here changes that.
 */
import type { AddContactValue, AddMethodValue, ContactRecord } from '../types';
import type { CreateContactInput } from '../hooks/useContactsV2';
import { contactRecordState } from './contacts-v2-key-holders';
import { contactDisplayName } from './contacts-v2-name';

export interface NewContactSaveOps {
  createContact(v: CreateContactInput): Promise<string>;
}

/**
 * ONE atomic write: the contact, its methods and, when a NIP-05 lookup found a
 * key, that key as an unverified direct identity, plus exactly one origin
 * (NIP-05 with a key, "Added manually" without). A refusal or failure leaves
 * nothing behind.
 */
export function saveNewContact(
  ops: NewContactSaveOps,
  ownerIdentityPubkey: string,
  contact: AddContactValue,
  methods: Omit<AddMethodValue, 'itemId'>[],
  key?: { pubkey: string },
): Promise<string> {
  return ops.createContact({
    ownerIdentityPubkey,
    contact,
    methods,
    ...(key ? { identity: { pubkey: key.pubkey, provenance: 'direct', verification: 'unverified' } } : {}),
  });
}

export interface ExistingContact {
  contactId: string;
  displayName: string;
  /** `deleted` and `archived` contacts still hold their keys. */
  state: 'active' | 'deleted' | 'archived';
}

/**
 * The contact in this directory whose CURRENT identities include `pubkey`.
 * Deleted and archived records count (they keep their keys), and an active
 * holder wins over a removed one. Keys once taken off a contact do not count.
 */
export function findContactHoldingKey(records: readonly ContactRecord[], pubkey: string): ExistingContact | null {
  const key = pubkey.toLowerCase();
  const held = records.filter(r => r.identities.some(i => i.pubkey.toLowerCase() === key));
  const record = held.find(r => r.lifecycle !== 'removed') ?? held[0];
  return record
    ? { contactId: record.contactId, displayName: contactDisplayName(record), state: contactRecordState(record) }
    : null;
}
