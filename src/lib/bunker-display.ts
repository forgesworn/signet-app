/**
 * Display helpers shared between the bunker approval surfaces
 * (BunkerApprovalModal single-modal flow and the BunkerPanel pending
 * queue). The surfaces have different layouts but the same
 * security-sensitive sanitisation rules — keep the rules here so they
 * can never drift apart.
 */

/** Truncate a 64-char hex pubkey for display ("a1b2c3d4e5…7890ab"). */
export function shortPubkey(hex: string): string {
  if (hex.length <= 16) return hex;
  return hex.slice(0, 10) + '…' + hex.slice(-6);
}

/**
 * Sanitise an app-supplied display name: strip control + bidi characters
 * (anti-spoofing) and cap length at 100 chars. Display only — never
 * trusted in security-sensitive comparisons.
 *
 * Built from a string of escape sequences so the bidi characters in the
 * range don't break the TS parser the way a literal regex does.
 */
const CONTROL_BIDI_REGEX = new RegExp(
  '[\\x00-\\x1f\\x7f-\\x9f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]',
  'g',
);

export function safeAppName(name: string): string {
  return name.replace(CONTROL_BIDI_REGEX, '').slice(0, 100);
}

/** The name a queued request carries when there is no saved client and no pairing label. */
export const UNKNOWN_APP_NAME = 'Unknown app';

/**
 * The origin of an app's URL plus the first 40 characters of its path, for
 * display. Null when there is no URL or it does not parse. Plain text only:
 * the result is never turned into a link.
 */
export function safeUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.origin + u.pathname.slice(0, 40);
  } catch {
    return null;
  }
}
