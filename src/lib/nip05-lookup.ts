/**
 * Shared bits of the NIP-05 "look this person up" flow, used by the Ken form
 * and the New contact page. The resolver itself is kenspeckle's
 * `pinKenFromNip05`; nothing here fetches.
 */
import { NIP05_ADDRESS_INVALID_COPY } from './contacts-v2-copy';
import { canonicalNip05 } from './nip05-check';
import { sanitizeDisplayName } from './text-sanitize';

/** Returns `null` if the text is a `name@domain` or a bare domain, or an error string. */
export function validateNip05Shape(value: string): string | null {
  return canonicalNip05(value) === null ? NIP05_ADDRESS_INVALID_COPY : null;
}

/** Map a kenspeckle throw to calm, human copy — the library's own message
 *  text (an internal field name, an HTTP status) is never shown to the
 *  user. `pinKen`/`pinKenFromNip05` throw "…must not equal ownerPubkeyHex"
 *  when the resolved key turns out to be the owner's own, so that case is
 *  named even though the hex/QR paths already check for it up front. */
export function humaniseKenAddError(e: unknown, ownKeyCopy = "That's your own key — you can't add yourself as a ken."): string {
  const msg = e instanceof Error ? e.message : '';
  if (msg.includes('must not equal ownerPubkeyHex')) {
    return ownKeyCopy;
  }
  if (msg.includes('HTTP')) {
    return 'Could not reach that address right now. Check it is correct and try again.';
  }
  if (msg.includes('response') || msg.includes('did not resolve')) {
    return 'That NIP-05 address did not resolve to a key. Check it is correct and try again.';
  }
  return 'Could not add that key. Check the details and try again.';
}

/** The name an address stands for with no profile: the local part, or the domain for the root name `_`. */
export function nameFromNip05(canonical: string): string {
  const at = canonical.indexOf('@');
  if (at < 0) return sanitizeDisplayName(canonical, 100);
  const local = canonical.slice(0, at);
  return sanitizeDisplayName(local === '_' ? canonical.slice(at + 1) : local, 100);
}

const PROFILE_NAME_PREF_KEY = 'signet.nip05LookupProfileName';

/** Whether "Get their name from their Nostr profile" is ticked. On unless the person turned it off here; on if storage is unreadable. */
export function readProfileNamePref(): boolean {
  try {
    return localStorage.getItem(PROFILE_NAME_PREF_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeProfileNamePref(on: boolean): void {
  try {
    localStorage.setItem(PROFILE_NAME_PREF_KEY, on ? '1' : '0');
  } catch {
    // Storage unavailable: the choice just doesn't persist.
  }
}
