/**
 * The home scanner's "scan an npub → add it to this persona's contacts" step,
 * as a plan.
 *
 * Only a bare Nostr key (`npub1…`, `nprofile1…`, optionally `nostr:`-prefixed)
 * is handled here. Everything else returns `null` so the caller's existing QR
 * routing runs unchanged — in particular a My Signet contact card, which
 * carries a name and avatar key this path would drop.
 */
import { routeQR } from './qr-router';
import { scannedKeyToHex } from './contacts-v2-confirm';
import { SCAN_CONTACT_INVALID_COPY, SCAN_CONTACT_OWN_KEY_COPY, SCAN_CONTACT_WRONG_CARD_COPY } from './contacts-v2-copy';

export type ScannedContactPlan =
  | { ok: true; pubkey: string; ownerIdentityPubkey: string }
  | { ok: false; error: string };

export function planScannedContact(data: string, args: {
  /** The identity on the carousel card the scan was made from. */
  ownerIdentityPubkey: string;
  /** The contact lists the current contacts scope can file into. */
  ownerLists: string[];
  /** Every key this install holds for the user (and, in child mode, the dependant). */
  ownPubkeys: string[];
}): ScannedContactPlan | null {
  const raw = data.trim().replace(/^nostr:/i, '');
  if (routeQR(raw).type !== 'contact') return null;
  const pubkey = scannedKeyToHex(raw);
  if (!pubkey) return { ok: false, error: SCAN_CONTACT_INVALID_COPY };
  if (args.ownPubkeys.some(k => k.toLowerCase() === pubkey)) return { ok: false, error: SCAN_CONTACT_OWN_KEY_COPY };
  const owner = args.ownerIdentityPubkey.toLowerCase();
  if (!args.ownerLists.some(k => k.toLowerCase() === owner)) return { ok: false, error: SCAN_CONTACT_WRONG_CARD_COPY };
  return { ok: true, pubkey, ownerIdentityPubkey: owner };
}
