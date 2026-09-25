/**
 * Shared display-name / display-text sanitiser.
 *
 * Strips control characters and bidi / invisible Unicode (the same character
 * class used everywhere attacker-controlled strings reach a display surface —
 * URL auth params, NIP-46 metadata, contact QR names, kind-0 profile fields),
 * then trims, then caps at `maxLen`.
 *
 * Order matters: strip -> trim -> slice (trim BEFORE slice). This is the
 * dominant order across the codebase. Call sites that strip-then-slice-then-
 * trim (slice BEFORE trim) can differ by a few trailing chars and are NOT
 * migrated to this helper — see the O2 notes for the parity exceptions.
 *
 * Character class (matches url-auth.ts / contact-qr.ts):
 *   U+0000-001F C0 controls; U+007F-009F DEL + C1 controls;
 *   U+200B-200F zero-width + LRM/RLM; U+2028-202E separators + bidi
 *   embedding/override; U+2066-2069 bidi isolates.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_BIDI = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

/**
 * Cap at `maxLen` CODE POINTS, never mid-surrogate-pair.
 *
 * `String.prototype.slice` counts UTF-16 code units, so a cap that lands
 * between the two halves of an astral character (an emoji, most of CJK Ext-B,
 * a musical symbol) leaves a LONE SURROGATE in the stored string. That is not
 * valid UTF-8, it renders as a replacement character, and it is the exact
 * disagreement the SDK's `sanitizeWireText` — which slices with
 * `Array.from` — would produce over the same input, which is what makes a
 * producer and a parser hand each other different bytes for one string (R-6).
 *
 * Output is byte-identical to the old `.slice` for any BMP-only input, which
 * is every fixture and vector this codebase has.
 */
function capCodePoints(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;  // code units ≥ code points
  return Array.from(value).slice(0, maxLen).join('');
}

/** Strip control + bidi/invisible chars, then trim, then cap at maxLen. */
export function sanitizeDisplayName(raw: string, maxLen: number): string {
  return capCodePoints(raw.replace(CONTROL_BIDI, '').trim(), maxLen);
}

/**
 * The same class MINUS `\n` (U+000A) and `\t` (U+0009).
 *
 * `\r` (U+000D) is still stripped: a CRLF paste becomes LF rather than keeping
 * a lone carriage return, and nothing downstream wants one. U+2028/U+2029 stay
 * stripped too — they are line separators no user typed, and they are part of
 * the bidi/invisible class this file exists to remove.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_BIDI_MULTILINE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

/**
 * Multi-line free text (a private note). Same guarantees as
 * `sanitizeDisplayName` but line breaks and tabs SURVIVE: a note is something
 * a person wrote for themselves in a textarea, and running it through the
 * display-name sanitiser silently glued its lines together.
 */
export function sanitizeNote(raw: string, maxLen: number): string {
  return capCodePoints(raw.replace(CONTROL_BIDI_MULTILINE, '').trim(), maxLen);
}
