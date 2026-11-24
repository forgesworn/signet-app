/**
 * What happens to a `keep-invite` link between arriving and the owner pressing "Open Keep".
 *
 * Another app can send this link, so it must not make this phone sign, publish or read from any relay on its own. The
 * link therefore waits for the app to be open and unlocked, is checked against the Keeps saved on this phone (a local
 * read, no network) and then only asks the owner whether to open that Keep. Only the owner's press opens My Keep.
 */

/** A link waits this long, counted from when it arrived, before it is dropped. */
export const KEEP_INVITE_LINK_TTL_MS = 10 * 60 * 1000;

export const KEEP_INVITE_NOT_YOURS = 'That link is for a Keep that isn’t one of yours.';
export const KEEP_INVITE_EXPIRED = 'That link has expired. Open it again from the game.';
export const KEEP_INVITE_OWN_ACCOUNT = 'Open that link from your own account, not while acting for someone else.';
export const KEEP_INVITE_UNREADABLE = 'Your saved Keeps couldn’t be read just now, so the link wasn’t opened.';
export const KEEP_INVITE_NOT_LINKED = 'That link can’t be used here: the persona you’re using isn’t linked to this Keep.';

export type HeldKeepInviteDecision = 'wait' | 'expired' | 'refuse' | 'dependant' | 'read';

/**
 * What to do with a held link now. 'read' means: look the Keep up in the saved list (the only step that follows a link
 * before the owner presses anything). 'refuse' is the existing "nothing to open" answer (no account, or a paired child).
 */
export function decideHeldKeepInvite(i: {
  arrivedAt: number; now: number; loading: boolean; hasIdentity: boolean; pairedChild: boolean; dependantActive: boolean; unlocked: boolean;
}): HeldKeepInviteDecision {
  if (i.loading) return 'wait';
  if (i.now - i.arrivedAt > KEEP_INVITE_LINK_TTL_MS) return 'expired';
  if (i.pairedChild || !i.hasIdentity) return 'refuse';
  if (i.dependantActive) return 'dependant';
  return i.unlocked ? 'read' : 'wait';
}

/**
 * The exact-URL dedupe entry after a link is dealt with: cleared only if it still holds that link's own URL, so a different
 * URL that arrived in the meantime keeps its entry.
 */
export function dedupeAfterSettled(current: string | null, settledUrl: string | undefined): string | null {
  return settledUrl && current === settledUrl ? null : current;
}
