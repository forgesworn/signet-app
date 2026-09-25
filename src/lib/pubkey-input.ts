import { decodeNpub, bytesToHex, isValidHexKey } from './signet';

const INVALID = 'Enter a public address starting with npub1.';

/**
 * Accepts a Nostr npub (bech32) OR a 64-character hex public key and returns
 * the normalised lowercase hex on success, or a human-readable error.
 *
 * Shared by the contact-add (KenAdd) manual-paste and QR-scan flows so a user
 * can paste whichever form they have. npub is the user-facing form; hex is the
 * app's internal representation.
 */
export function parsePubkeyInput(raw: string): { hex: string } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: INVALID };

  // Bare hex key (case-insensitive — normalise to lowercase).
  const lower = trimmed.toLowerCase();
  if (isValidHexKey(lower)) return { hex: lower };

  // Nostr npub (bech32). decodeNpub rejects other bech32 types (e.g. nsec).
  if (/^npub1/i.test(trimmed)) {
    try {
      const decoded = decodeNpub(trimmed);
      if (decoded && decoded.length === 32) {
        const hex = bytesToHex(decoded);
        if (isValidHexKey(hex)) return { hex };
      }
    } catch {
      /* fall through to the npub-specific error */
    }
    return { error: 'That npub could not be decoded — check it was copied in full.' };
  }

  return { error: INVALID };
}
