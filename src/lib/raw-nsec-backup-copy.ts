/**
 * Copy for raw-nsec recovery words: the 31 words that back up ONE imported
 * Nostr key (ForgeSworn `raw-nsec-v1`), as opposed to the 19 that restore a
 * whole Signet. One module so the surfaces that show, confirm or decline them
 * say the same thing.
 */

/** Security settings → Backup Words, for an identity created from an nsec. */
export const RAW_NSEC_WORDS_INTRO =
  '31 words. Write them down in order. They restore this Nostr key, and only this key, on a new phone.';

/** The confirm that clears the backup prompt once the words are written down. */
export const RAW_NSEC_WORDS_CONFIRM_LABEL = 'I’ve written them down';
export const RAW_NSEC_WORDS_CONFIRMED = 'Backed up.';

/** Persona → Advanced, for an imported extra persona. */
export const IMPORTED_PERSONA_NOTE =
  'This persona was imported from an existing nsec, so your Signet’s recovery words won’t bring it back. It has its own 31 words instead. Imported personas stay on this device only and are not in the cross-device backup.';
export const IMPORTED_PERSONA_SHOW_WORDS = 'Show its recovery words';

/** An imported slot whose private key is not held here: nothing to show. */
export const IMPORTED_KEY_NOT_HERE =
  'This persona’s key isn’t on this device, so there are no recovery words to show here.';

/** Shamir v3 splits Signet recovery words only (`forgesworn-recovery-words-v1`). */
export const SHAMIR_NOT_FOR_RAW_NSEC =
  'Shamir backup splits Signet recovery words. It doesn’t cover an imported key yet, so write down this key’s 31 recovery words instead.';

/** Onboarding nsec import, confirm step. */
export const NSEC_CONFIRM_BACKUP_COPY =
  'Once imported, write down this key’s 31 recovery words. You’ll find them in Settings → Security → Backup Words.';
export const NSEC_CONFIRM_FROM_WORDS_COPY =
  'Restored from your 31 recovery words. Keep them safe: they’re the only backup of this key.';
