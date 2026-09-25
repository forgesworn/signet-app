/**
 * Spec section 7.10: removing a dependant offers Delete contacts or Archive
 * contacts, and the guardian must choose before removal proceeds. Delete
 * writes durable tombstones (`remove`); Archive keeps an encrypted read-only
 * snapshot (`archive`). Neither can promise a relay or an app that already
 * decrypted a projection forgets anything, which is why the copy in
 * `contacts-v2-copy.ts` says so out loud.
 */
import type { ContactRecord } from '../types';
import { isVisibleContact } from './contacts-v2-list';

export type DependantContactsChoice = 'delete' | 'archive';

export interface RemovalPlan {
  choice: DependantContactsChoice;
  directoryId: string;
  action: 'remove' | 'archive';
  contactIds: string[];
}

export function planDependantContactRemoval(
  directoryId: string,
  contacts: ContactRecord[],
  choice: DependantContactsChoice,
): RemovalPlan {
  return {
    choice,
    directoryId,
    action: choice === 'delete' ? 'remove' : 'archive',
    contactIds: contacts
      .filter(c => c.directoryId === directoryId && isVisibleContact(c))
      .map(c => c.contactId),
  };
}
