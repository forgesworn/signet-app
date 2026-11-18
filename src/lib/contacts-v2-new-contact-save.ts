/**
 * Saving the New contact form: the contact, its methods and, when a NIP-05
 * lookup found a key, that key as an identity (plus a "NIP-05" origin).
 *
 * Takes the slice of `useContactsV2` it needs so it can be driven without
 * React. The ops are stamped by whatever scope actor the hook already holds
 * (child mode is the child); nothing here changes that.
 */
import type { AddContactValue, AddIdentityValue, AddMethodValue } from '../types';
import type { ContactOrigin } from './contact-origins';
import { newContactId } from './contacts-v2-ids';

export interface NewContactSaveOps {
  addContact(v: AddContactValue): Promise<string>;
  addContactMethod(contactId: string, v: Omit<AddMethodValue, 'itemId'>): Promise<string>;
  addIdentity(contactId: string, v: Omit<AddIdentityValue, 'itemId'>, opts?: { refuseMerge?: boolean }): Promise<string>;
  /** Absent when the hook is not scoped to one identity list (the "all" view). */
  recordOrigin?: (contactId: string, origin: Omit<ContactOrigin, 'ownerIdentityPubkey'>) => Promise<void>;
}

export async function saveNewContact(
  ops: NewContactSaveOps,
  ownerIdentityPubkey: string,
  contact: AddContactValue,
  methods: Omit<AddMethodValue, 'itemId'>[],
  key?: { pubkey: string; nip05: string },
  now: () => number = Date.now,
): Promise<string> {
  const contactId = await ops.addContact({ ...contact, ownerIdentityPubkey });
  for (const m of methods) await ops.addContactMethod(contactId, m);
  if (key) {
    // refuseMerge: a key another contact already holds must never silently
    // fold two people together (the page offers "Open" for the usual case).
    await ops.addIdentity(contactId, { pubkey: key.pubkey, provenance: 'direct', verification: 'unverified' }, { refuseMerge: true });
    if (ops.recordOrigin) await ops.recordOrigin(contactId, { id: newContactId(), method: 'nip05', addedAt: now() });
  }
  return contactId;
}
