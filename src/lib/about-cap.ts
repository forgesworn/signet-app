/**
 * The one definition of the kind-0 `about` length cap, shared by the kind-0
 * parser (`public-profile-publish.ts`) and both private sync rails
 * (`personas-sync.ts`, `persona-inventory-sync.ts`).
 *
 * The unit is CODE POINTS, not UTF-16 units: a 2000-emoji bio is 4000 units
 * and must round-trip through every rail. On the receive side an over-long
 * value is TRUNCATED (`clampAbout`), never dropped — dropping reads as "the
 * field was cleared" and would silently erase a real bio.
 */
export const CAP_ABOUT = 2000;

/** Truncate to `CAP_ABOUT` code points (never mid-surrogate-pair). */
export function clampAbout(text: string): string {
  // A string of at most CAP_ABOUT UTF-16 units has at most CAP_ABOUT code points.
  if (text.length <= CAP_ABOUT) return text;
  return Array.from(text).slice(0, CAP_ABOUT).join('');
}
