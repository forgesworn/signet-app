/**
 * Edit time for a dependant's synced scalar fields (#199).
 *
 * The sync merge used to let the remote record win every scalar field, so an
 * older copy (another device's vault snapshot, the legacy relay record read
 * just after unlock) could undo a fresh local edit such as a stage change.
 * `updatedAt` (ms) records when this device last changed one of these fields;
 * the merge keeps the local fields when that is newer than the remote edit.
 *
 * Extras, tombstones, the schedule and the real-identity flag keep their own
 * merge rules and are deliberately not covered here.
 */

interface ScalarView {
  displayName: string;
  dateOfBirth?: string;
  autonomyStage: string;
  primaryKeypair: string;
  naturalPerson?: { displayName: string };
  persona?: { displayName: string };
  np?: { displayName: string };
}

/** Rejects edit times more than a day ahead, so a skewed clock cannot win forever. */
export const MAX_EDIT_TIME_SKEW_MS = 24 * 60 * 60 * 1000;

function scalars(d: ScalarView): string {
  return JSON.stringify([d.displayName, d.dateOfBirth ?? null, d.autonomyStage, d.primaryKeypair,
    (d.naturalPerson ?? d.np)?.displayName ?? null, d.persona?.displayName ?? null]);
}

/** Do two records (stored or wire shape) differ in any synced scalar field? */
export function dependantScalarsDiffer(a: ScalarView, b: ScalarView): boolean {
  return scalars(a) !== scalars(b);
}

/** A wire `updatedAt` worth trusting, or undefined. */
export function validEditTime(value: unknown, now = Date.now()): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    && value <= now + MAX_EDIT_TIME_SKEW_MS ? value : undefined;
}
