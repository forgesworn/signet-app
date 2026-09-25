/** Dismissing the backup nudge snoozes it for seven days. */
export const BACKUP_NUDGE_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/** Show once the identity has accumulated something worth losing. */
const AUTHORIZED_SITES_THRESHOLD = 3;
const IDENTITY_AGE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Should the home ring show the backup nudge (spec §10)?
 *
 * Creating a Signet takes under a minute precisely because the words are NOT
 * demanded at the door — so the nudge waits until the identity is worth losing:
 * three authorized sites, or a day old. Never for an identity with nothing to
 * back up (an nsec import has no mnemonic), and never on a paired child, whose
 * keys are their guardian's responsibility.
 *
 * Pure: `nowMs` and every input are passed in, so the rule is testable without
 * clocks or IndexedDB.
 */
export function shouldShowBackupNudge(input: {
  backedUp: boolean;
  hasMnemonic: boolean;
  isPairedChild: boolean;
  /** `SignetIdentity.createdAt` — unix SECONDS, not ms. */
  createdAtSeconds: number;
  authorizedSiteCount: number;
  /** `AppPreferences.backupNudgeSnoozedUntil` — ms epoch. */
  snoozedUntilMs: number | undefined;
  nowMs: number;
}): boolean {
  if (input.backedUp) return false;
  if (!input.hasMnemonic) return false;
  if (input.isPairedChild) return false;
  if (input.snoozedUntilMs !== undefined && input.snoozedUntilMs > input.nowMs) return false;

  if (input.authorizedSiteCount >= AUTHORIZED_SITES_THRESHOLD) return true;
  return input.nowMs - input.createdAtSeconds * 1000 >= IDENTITY_AGE_THRESHOLD_MS;
}
