/** Dismissing the backup nudge snoozes it for seven days. */
export const BACKUP_NUDGE_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/** Holding someone else's keys shortens the snooze to two days. */
export const BACKUP_NUDGE_FAMILY_SNOOZE_MS = 48 * 60 * 60 * 1000;

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
 * Once a dependant is held, the identity is already worth losing regardless of
 * age or site count — someone else's keys ride on these same words — so the
 * sites/age thresholds no longer apply. The snooze still applies.
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
  dependantCount: number;
}): boolean {
  if (input.backedUp) return false;
  if (!input.hasMnemonic) return false;
  if (input.isPairedChild) return false;
  if (input.snoozedUntilMs !== undefined && input.snoozedUntilMs > input.nowMs) return false;

  if (input.dependantCount > 0) return true;

  if (input.authorizedSiteCount >= AUTHORIZED_SITES_THRESHOLD) return true;
  return input.nowMs - input.createdAtSeconds * 1000 >= IDENTITY_AGE_THRESHOLD_MS;
}

/** The snooze shortens once someone else's keys are held. */
export function backupNudgeSnoozeMs(dependantCount: number): number {
  return dependantCount > 0 ? BACKUP_NUDGE_FAMILY_SNOOZE_MS : BACKUP_NUDGE_SNOOZE_MS;
}

/** Copy for the backup nudge card, named for whose keys are riding on it. */
export function backupNudgeCopy(dependantNames: string[]): { title: string; body: string } {
  const title = 'Write down your recovery words';
  if (dependantNames.length === 0) {
    return { title, body: "They're the only way back in on a new phone." };
  }
  if (dependantNames.length === 1) {
    const name = dependantNames[0]?.trim() || 'your dependant';
    return { title, body: `They're the only way back in — for you and for ${name}.` };
  }
  return {
    title,
    body: `They're the only way back in — for you and for the ${dependantNames.length} people whose keys you hold.`,
  };
}
