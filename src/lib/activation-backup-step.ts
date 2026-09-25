/** Which backup step the activation page shows after the typed confirm. */
export type ActivationBackupStep =
  /** Nothing to show — no mnemonic, or already backed up and not from Lite. */
  | 'none'
  /** First time: show the words with the "I've written these down" checkbox. */
  | 'first-backup'
  /** Lite import: show the words read-only; `backedUp` is already true and stays true. */
  | 'lite-reminder';

/**
 * Spec §7.1 step 4. Activating the real identity is the moment the account
 * starts carrying a legal name, so it is the right moment to make sure the user
 * can get back in — but only when there is actually something to write down.
 *
 * A Lite import arrives `backedUp: true` (the user already holds their Lite
 * phrase) yet still needs to be told that MySignet restores from a different,
 * longer word list. That is the `lite-reminder` case, and it must NOT flip
 * `backedUp`, because the user is not being asked to confirm anything.
 */
export function resolveActivationBackupStep(input: {
  hasMnemonic: boolean;
  backedUp: boolean;
  liteImported: boolean;
}): ActivationBackupStep {
  if (!input.hasMnemonic) return 'none';
  if (!input.backedUp) return 'first-backup';
  if (input.liteImported) return 'lite-reminder';
  return 'none';
}
