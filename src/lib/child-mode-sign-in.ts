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
