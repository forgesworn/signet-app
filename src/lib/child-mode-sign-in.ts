/**
 * Sign-in requests that reach the guardian's phone while it is in child mode
 * (device run 2026-11-17, F12).
 *
 * A child whose own phone pairs straight to the family Heartwood signs in on
 * that phone. On the guardian's phone their key is on the Heartwood, not here,
 * so the only identities the picker could offer were the guardian's own: a
 * parent typing the PIN "to help" signed the child in as the parent. The
 * request is refused instead, with no PIN asked for and no guardian identity
 * shown.
 *
 * Any other child in child mode signs in only as that child: the guardian's
 * identities, and any other dependant's, are never on offer.
 */
import type { AuthSelection } from '../pages/ApproveAuth';
import type { CarouselRow } from '../types';
import { sanitizeDisplayName } from './text-sanitize';

/** What the decision reads from the child-mode dependant. Readable while locked. */
export interface ChildModeSignInDependant {
  id: string;
  displayName: string;
  childDevice?: { mode?: string } | null;
}

export interface ChildModeSignInInput {
  /** The phone is in child mode (live, or as last saved while it is still locked). */
  childMode: boolean;
  /** The child-mode dependant, or null if unknown. */
  dependant: ChildModeSignInDependant | null | undefined;
}

const NAME_MAX = 64;

/** The child's name for the refusal copy; never empty. */
function childName(displayName: string): string {
  return sanitizeDisplayName(typeof displayName === 'string' ? displayName : '', NAME_MAX) || 'your child';
}

/**
 * In child mode for a child paired straight to the Heartwood, every sign-in is
 * refused: `{ child }` names them for the copy. Null everywhere else.
 */
export function childModeSignInRefusal(input: ChildModeSignInInput): { child: string } | null {
  if (!input.childMode || !input.dependant) return null;
  if (input.dependant.childDevice?.mode !== 'heartwood-direct') return null;
  return { child: childName(input.dependant.displayName) };
}

/**
 * The approval-time check behind the picker: in child mode a selection is
 * refused unless it is the child-mode dependant signing as themselves (and that
 * child does not sign in on their own phone). Outside child mode nothing is.
 */
export function childModeSelectionRefused(input: ChildModeSignInInput & { selection: AuthSelection }): boolean {
  if (!input.childMode) return false;
  if (childModeSignInRefusal(input)) return true;
  return input.selection.source !== 'dependant'
    || !input.dependant
    || input.selection.dependantId !== input.dependant.id;
}

/**
 * What a sign-in or connect approval may offer, whichever way the request
 * came in (a link, a QR on the carousel or the scan page, a relay request, an
 * App Link). In child mode the guardian's identities are never offered and
 * only the child-mode dependant is; for a child who signs in on their own
 * phone the request is refused outright (`refuse` names them). Outside child
 * mode everything is offered, as before.
 */
export interface ChildModeApprovalOffer {
  refuse: { child: string } | null;
  /** The guardian's own identities (real name, persona, extras, Pro) may be offered. */
  guardian: boolean;
  /** This dependant may be offered. */
  offersDependant: (dependantId: string) => boolean;
}

export function childModeApprovalOffer(input: ChildModeSignInInput): ChildModeApprovalOffer {
  if (!input.childMode) return { refuse: null, guardian: true, offersDependant: () => true };
  const refuse = childModeSignInRefusal(input);
  const onlyId = refuse ? null : input.dependant?.id || null;
  return { refuse, guardian: false, offersDependant: id => onlyId !== null && id === onlyId };
}

/**
 * Child mode as phone apps (NIP-55) are answered: `unknown` until child mode
 * as last saved has been read at start-up, then `on` while it is live or still
 * saved and not yet restored, `off` otherwise.
 */
export type ChildModeState = 'on' | 'off' | 'unknown';

/**
 * The saved session could not be read at start-up (IndexedDB failed). That is
 * not "no session": child mode stays on, with no child to resolve, so only home
 * renders and nothing is offered, until the PIN exit clears it (or a later read
 * succeeds after unlock and restores the real session). An empty id never
 * matches a dependant.
 */
export const CHILD_MODE_UNRESOLVED: ChildModeSignInDependant = Object.freeze({ id: '', displayName: '' });

/**
 * Child mode as last saved, read at start-up: the child's facts, null when
 * there is no session or its dependant is missing or independent (that drop is
 * deliberate), or `CHILD_MODE_UNRESOLVED` when either read fails.
 */
export async function readSavedChildMode(deps: {
  loadSession: () => Promise<{ activeDependantId: string } | null>;
  loadFacts: (dependantId: string) => Promise<ChildModeSignInDependant | null>;
}): Promise<ChildModeSignInDependant | null> {
  try {
    const session = await deps.loadSession();
    return session ? await deps.loadFacts(session.activeDependantId) : null;
  } catch {
    return CHILD_MODE_UNRESOLVED;
  }
}

export function childModeState(input: { live: boolean; saved: ChildModeSignInDependant | null | undefined }): ChildModeState {
  if (input.live || input.saved) return 'on';
  return input.saved === undefined ? 'unknown' : 'off';
}

/**
 * The carousel step after an approved sign-in or connect. Outside child mode
 * it lands on the approved card as before. In child mode it never leaves child
 * mode, which only the PIN exit does: the child-mode dependant's own approval
 * lands on their card in the child's ring, and anything else (refused before
 * signing, so never expected here) leaves the carousel as it is.
 */
export type ChildModeAlignStep = 'outside-child-mode' | 'land-on-child' | 'stay-put';

export function childModeAlignStep(input: { childMode: boolean; childModeDependantId: string | null | undefined; selection: AuthSelection }): ChildModeAlignStep {
  if (!input.childMode) return 'outside-child-mode';
  return input.selection.source === 'dependant' && !!input.childModeDependantId
    && input.selection.dependantId === input.childModeDependantId ? 'land-on-child' : 'stay-put';
}

/**
 * The row of the child's ring (`buildChildRows`) holding the keypair a
 * child-mode approval signed with, or -1. `keypairType` is 'natural-person',
 * 'persona' or an extra persona's pubkey, as in `AuthSelection`.
 */
export function childRingRowFor(rows: readonly CarouselRow[], keypairType: string): number {
  return rows.findIndex(row => {
    if (row.type === 'dependant') return keypairType === 'natural-person';
    if (row.type === 'dependant-persona') return keypairType === 'persona';
    if (row.type === 'dependant-extra-persona') return row.dependant.extraPersonas?.[row.personaIndex]?.publicKey === keypairType;
    return false;
  });
}

/**
 * A child-mode session saved on this phone that can never be restored here:
 * the phone is unlocked, the dependants have been read with the key, child
 * mode is not live, and the session's dependant is not among them (the read
 * skipped its record, or it is gone). It is then
 * cleared, so it restricts nothing: outside live child mode the guardian is
 * never restricted once unlocked. Never stale before the keyed read, so a
 * valid session is not dropped in the window where the list is still the
 * keyless one or empty.
 */
export function childModeSessionStale(input: {
  unlocked: boolean;
  dependantsLoadedWithKey: boolean;
  childModeLive: boolean;
  sessionDependantId: string | null | undefined;
  dependantIds: readonly string[];
}): boolean {
  if (!input.unlocked || !input.dependantsLoadedWithKey || input.childModeLive) return false;
  if (!input.sessionDependantId) return false;
  return !input.dependantIds.includes(input.sessionDependantId);
}

/**
 * What the child-mode banner's button does. Exit (PIN) whenever child mode is live
 * or the saved session can be cleared (read failed, or unlocked with no restore);
 * Unlock (PIN) when it is only saved and the phone is still locked, since the
 * restore after the unlock makes it live, with its Exit. 'none' only when child
 * mode is not on at all, where no banner shows.
 */
export type ChildModeBannerAction = 'exit' | 'unlock' | 'none';
export function childModeBannerAction(s: { live: boolean; saved: boolean; savedExitable: boolean }): ChildModeBannerAction {
  if (s.live) return 'exit';
  if (!s.saved) return 'none';
  return s.savedExitable ? 'exit' : 'unlock';
}
