/**
 * Which dependant the app is scoped to (App's `activeDependantId`), how a
 * management page borrows that scope, and how the scope follows history.
 *
 * The id means two different things:
 *
 * - A scope the user CHOSE: child mode, "Hand this phone to …", "Switch to …",
 *   landing on a dependant after signing in as them, or "Back to me". It stays
 *   until the user changes it again. That is `set`.
 * - A page parameter: Phone & Pairing, a dependant's settings, the family list,
 *   the dependant's contacts and so on open "for" a dependant by putting its id
 *   here. That is `borrow`: the scope in force before the first borrow is kept
 *   and put back the next time the app reaches home, however it gets there.
 *   Before this the guardian reached home still scoped to the dependant,
 *   without the Bunker tab and with the dependant's signing backend, until the
 *   app was restarted.
 *
 * A page's dependant is part of the page: every history entry records the
 * scope it was shown under, and going back or forward to it shows it under
 * that scope again (`resolvePoppedEntry`). Ids are always read against the
 * live dependant list (`liveScopeId`), so a dependant removed anywhere — the
 * Advanced page, the independence ceremony, a sync — reads as the owner.
 *
 * A dependant removed on this device is also ENDED for the rest of the
 * session (`ended`): the dependants rail never deletes, so a sync can merge
 * the record back, and without the mark the app would silently become
 * "Managing" them again through a stale scope, restore target or history
 * entry. Only a later deliberate choice of that dependant (`set`, or a page
 * opened for them) clears the mark.
 */
import type { Page } from '../types';

export interface DependantScope {
  /** The dependant the app is scoped to, or null for the owner. Read it through `liveScopeId`. */
  readonly id: string | null;
  /**
   * Set while a management page has borrowed `id`: the scope to put back on
   * reaching home. Null when the current scope was chosen.
   */
  readonly restore: { readonly id: string | null } | null;
  /** Dependants removed this session; absent when none. Read through `liveScopeId`. */
  readonly ended?: ReadonlySet<string>;
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
  /** This dependant was removed: it is no longer the scope, restore target or any entry's scope. */
  | { type: 'ended'; id: string };

export const INITIAL_DEPENDANT_SCOPE: DependantScope = { id: null, restore: null };

/** The ended set without `id`: choosing a dependant again brings them back. */
function unmark(ended: ReadonlySet<string> | undefined, id: string | null): ReadonlySet<string> | undefined {
  if (!ended || id === null || !ended.has(id)) return ended;
  const next = new Set(ended);
  next.delete(id);
  return next.size > 0 ? next : undefined;
}

export function dependantScopeReducer(state: DependantScope, action: DependantScopeAction): DependantScope {
  switch (action.type) {
    case 'set':
      if (state.id === action.id && state.restore === null && !(action.id !== null && state.ended?.has(action.id))) return state;
      return { id: action.id, restore: null, ended: unmark(state.ended, action.id) };
    case 'borrow':
      // Nested management pages keep the scope from before the FIRST borrow.
      // A borrow is always a page opened for this dependant on purpose (a
      // popped entry borrows only a live, un-ended id), so it clears the mark.
      return { id: action.id, restore: state.restore ?? { id: state.id }, ended: unmark(state.ended, action.id) };
    case 'commit':
      return state.restore === null ? state : { ...state, restore: null };
    case 'arrived-home':
      return state.restore === null ? state : { ...state, id: state.restore.id, restore: null };
    case 'ended': {
      const ended = new Set(state.ended);
      ended.add(action.id);
      return {
        id: state.id === action.id ? null : state.id,
        restore: state.restore?.id === action.id ? { id: null } : state.restore,
        ended,
      };
    }
  }
}

/**
 * The one place a stored id is read: a dependant that no longer exists, or
 * that was removed this session (`ended`), is the owner.
 */
export function liveScopeId(
  id: string | null,
  isLive: (dependantId: string) => boolean,
  ended?: ReadonlySet<string>,
): string | null {
  return id !== null && !ended?.has(id) && isLive(id) ? id : null;
}

/**
 * Pages that show nothing of their own without a dependant in scope on a
 * guardian install (they fall through to the carousel with the bar hidden or
 * mislabelled). `activity` and `child-permissions` have their own variants on
 * a child's install, so the caller excludes those installs.
 */
const DEPENDANT_ONLY_PAGES: ReadonlySet<Page> = new Set<Page>([
  'pair-dependant-device', 'pair-dependant-app', 'transition-ceremony', 'activity', 'child-permissions',
]);

export function pageNeedsDependant(page: Page): boolean {
  return DEPENDANT_ONLY_PAGES.has(page);
}

export type PoppedEntryResolution =
  /** Show home instead of the entry's page. */
  | { show: 'home' }
  /** Show the entry's page, borrowing `borrow` first when present. */
  | { show: 'page'; borrow?: string | null };

/**
 * What going back or forward to a history entry shows. The entry carries the
 * scope its page was shown under (`entryDependantId`, null for the owner).
 */
export function resolvePoppedEntry(input: {
  page: Page;
  entryDependantId: string | null;
  /** The live scope now (`liveScopeId`). */
  currentId: string | null;
  /** Deliberate child mode: a popped entry never re-scopes it. */
  locked: boolean;
  isLive: (dependantId: string) => boolean;
  /** `pageNeedsDependant(page)`, false on a child's own install. */
  needsDependant: boolean;
}): PoppedEntryResolution {
  const { page, entryDependantId: entry, currentId, locked, isLive, needsDependant } = input;
  if (page === 'home') return { show: 'home' };
  // The dependant this page was for is gone.
  if (entry !== null && !isLive(entry)) return { show: 'home' };
  if (entry === currentId) {
    return entry === null && needsDependant ? { show: 'home' } : { show: 'page' };
  }
  // Child mode is left only through the guardian's unlock; history never
  // takes it to the owner's pages or another dependant's.
  if (locked) return { show: 'home' };
  if (entry === null) return needsDependant ? { show: 'home' } : { show: 'page', borrow: null };
  return { show: 'page', borrow: entry };
}
