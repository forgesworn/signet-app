import { vaultContentHash } from 'signet-protocol/experimental';
import type { ContactRecord } from '../types';
/** Only brand-new app connections can be undone by removing the whole record.
 * Reusing a pre-existing contact must not expose a destructive Undo shortcut. */
export function uncheckedAppConnection(contact: ContactRecord, own: string) {
  if (contact.lifecycle === 'removed') return null;
  const origin = contact.origins?.find(o => o.method === 'app' && o.appName && o.ownerIdentityPubkey === own);
  if (!origin || contact.checks?.some(c => c.ownerIdentityPubkey === own && c.method === 'words'
    && contact.identities.some(i => i.pubkey === c.identityPubkey))) return null;
  const createdId = vaultContentHash(`contact-exchange:${contact.directoryId}:${origin.id}:contact`).slice(0, 32);
  return { appName: origin.appName!, canUndo: contact.contactId === createdId };
}
