/**
 * Picker grace: lets a system file picker hide the page without locking the
 * app at once.
 *
 * Opening the system picker hides the page. On a page that locks the moment it
 * hides, that lock unmounts the screen (and the file input with it), so the
 * picked file arrives at a detached node and is lost. A file input calls
 * `armPickerGrace()` just before it opens the picker; the next hide inside
 * `PICKER_ARM_TTL_MS` is then given the same 30 s grace the other pending
 * flows already get, never more: App still measures that grace from when the
 * page was hidden. Everything else keeps hide = lock.
 *
 * The arm is consumed by the first hide it meets and cleared when the page
 * next becomes visible, so it cannot carry over to a later, unrelated hide.
 * An arm that no hide follows (a desktop dialog that never hides the page)
 * lapses after the TTL.
 *
 * Module state, not React state: a file input deep in a card has no way to
 * reach App's effect, and the decision must survive the effect re-running
 * while the page is still hidden.
 */

/** How long an arm stays good for. The picker hides the page within a moment
 *  of opening, so a hide this long after the arm is not the picker's. */
export const PICKER_ARM_TTL_MS = 5000;

let armedAt: number | null = null;
let active = false;

/** Call just before opening a system file picker. */
export function armPickerGrace(now: number = Date.now()): void {
  armedAt = now;
}

/** Whether a hide happening now is the picker's. Consumes the arm; stays true
 *  for repeat checks during the same hide, until `clearPickerGrace()`. */
export function pickerGraceOnHide(now: number = Date.now()): boolean {
  if (armedAt !== null) {
    const fresh = now - armedAt >= 0 && now - armedAt <= PICKER_ARM_TTL_MS;
    armedAt = null;
    if (fresh) active = true;
  }
  return active;
}

/** Call when the page next becomes visible. */
export function clearPickerGrace(): void {
  armedAt = null;
  active = false;
}

/**
 * The grace decision for a hide: the existing flows' verdict, or the picker's.
 * Always consults the picker so its arm is consumed by this hide.
 */
export function hideGetsGrace(existingGrace: boolean, now: number = Date.now()): boolean {
  return pickerGraceOnHide(now) || existingGrace;
}
