/**
 * Which dependant the app is scoped to (App's `activeDependantId`), and how
 * that scope gets back to where it was after a management page.
 *
 * The id means two different things:
 *
 * - A scope the user CHOSE: child mode, "Hand this phone to …", "Switch to …",
 *   landing on a dependant after signing in as them, or "Back to me". It stays
 *   until the user changes it again. That is `set`.
 * - A page parameter: Phone & Pairing, a dependant's settings, the family list,
 *   the dependant's contacts and so on open "for" a dependant by putting its id
 *   here. Nothing on those pages hands it back, so before this the guardian
 *   reached home still scoped to the dependant, without the Bunker tab and with
 *   the dependant's signing backend, until the app was restarted. That is
 *   `borrow`: the scope in force before the first borrow is kept and put back
 *   the next time the app reaches home, however it gets there.
 */

export interface DependantScope {
  /** The dependant the app is scoped to, or null for the owner. */
  readonly id: string | null;
  /**
   * Set while a management page has borrowed `id`: the scope to put back on
   * reaching home. Null when the current scope was chosen.
   */
  readonly restore: { readonly id: string | null } | null;
}

export type DependantScopeAction =
  /** A scope the user chose. Cancels any pending restore. */
  | { type: 'set'; id: string | null }
  /** A management page's parameter, undone on reaching home. */
  | { type: 'borrow'; id: string | null }
  /** The user chose the borrowed scope after all, so keep it past home. */
  | { type: 'commit' }
  /** The app reached home: put back the scope from before the borrow. */
  | { type: 'arrived-home' }
  /** The dependant was removed: neither the scope nor a restore may name it. */
  | { type: 'forget'; id: string };

export const INITIAL_DEPENDANT_SCOPE: DependantScope = { id: null, restore: null };

export function dependantScopeReducer(state: DependantScope, action: DependantScopeAction): DependantScope {
  switch (action.type) {
    case 'set':
      if (state.id === action.id && state.restore === null) return state;
      return { id: action.id, restore: null };
    case 'borrow':
      // Nested management pages keep the scope from before the FIRST borrow.
      return { id: action.id, restore: state.restore ?? { id: state.id } };
    case 'commit':
      return state.restore === null ? state : { id: state.id, restore: null };
    case 'arrived-home':
      return state.restore === null ? state : { id: state.restore.id, restore: null };
    case 'forget': {
      const id = state.id === action.id ? null : state.id;
      const restore = state.restore?.id === action.id ? { id: null } : state.restore;
      return id === state.id && restore === state.restore ? state : { id, restore };
    }
  }
}
