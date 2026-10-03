/**
 * What a contact is CALLED on screen.
 *
 * A contact created from a key alone (a scanned invite, an old build that
 * labelled it with a slice of the key) can carry a stored name that is just a
 * hex prefix — `66dd41aa…`. That reads as noise, so display resolves it to the
 * short npub of one of the contact's own keys instead. Stored records are never
 * rewritten: a rename or a later real name simply replaces what is stored.
 */
import { nip19 } from 'nostr-tools';
import type { ContactRecord } from '../types';
import { shortNpub } from './nostr-follows';

const HEX_LABEL_RE = /^([0-9a-f]{6,64})(?:…|\.\.\.)?$/i;

/** The full `npub1…` form of a hex key, or '' when it is not a key. */
export function fullNpub(pubkey: string): string {
  try { return nip19.npubEncode(pubkey.toLowerCase()); } catch { return ''; }
}

/** True when `name` is just the leading hex of one of `pubkeys` (optionally with an ellipsis). */
export function isHexPrefixLabel(name: string, pubkeys: string[]): boolean {
  const match = HEX_LABEL_RE.exec(name.trim());
  if (!match) return false;
  const prefix = match[1].toLowerCase();
  return pubkeys.some(k => k.toLowerCase().startsWith(prefix));
}

export function contactDisplayName(contact: Pick<ContactRecord, 'displayName' | 'identities'>): string {
  const name = contact.displayName ?? '';
  const keys = (contact.identities ?? []).map(i => i.pubkey);
  if (name.trim() === '') return keys.length > 0 ? shortNpub(keys[0]) : name;
  if (isHexPrefixLabel(name, keys)) {
    const own = keys.find(k => k.toLowerCase().startsWith(HEX_LABEL_RE.exec(name.trim())![1].toLowerCase()));
    return shortNpub(own ?? keys[0]);
  }
  return name;
}
