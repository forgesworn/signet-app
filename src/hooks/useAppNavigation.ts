import { useCallback, useRef, useState } from 'react';
import type { Page } from '../types';
import { useNavigation, type NavigationEntry } from './useNavigation';
import {
  dependantScopeReducer, INITIAL_DEPENDANT_SCOPE, liveScopeId, resolvePoppedEntry,
  type DependantScope, type DependantScopeAction,
} from '../lib/dependant-scope';

export interface AppNavigationOptions {
  /** Whether a dependant with this id exists now. */
  isLive: (dependantId: string) => boolean;
  /**
   * Live child mode: history never re-scopes it (it goes home instead), and a
   * `borrow` leaves it alone. A `set` still lands, because entering, leaving
   * (the PIN exit) and switching to a sibling are all `set`s made while this
   * still reads true: App assigns it at render time.
   */
  isScopeLocked: () => boolean;
  /** Whether `page` needs a dependant in scope on this install (`pageNeedsDependant`). */
  needsDependant: (page: Page) => boolean;
  /**
   * Whether what a popped entry's parameter names still exists (a persona, a
   * dependant). False sends the entry home. Absent: every parameter is live.
   */
  isPageParamLive?: (page: Page, param: unknown) => boolean;
  /** Passed to useNavigation: hardware/browser back is pinned while true. */
  isBounded?: () => boolean;
  /** Passed to useNavigation: called on a pinned hardware/browser back. */
  onAttemptBoundaryExit?: () => void;
}

/**
 * The only way App changes the page or the dependant scope. There is no raw
 * page or scope setter: every change below keeps the history entry on screen
 * describing the page, its scope and its parameter.
 */
export interface AppNavigation {
  page: Page;
  /**
   * The parameter of the entry on screen (which slot, which dependant's
   * activation…), opaque here. Back and forward bring back each entry's own.
   */
  pageParam: unknown;
  navigateTo: (page: Page, param?: unknown) => void;
  navigateBack: () => void;
  navigateReplace: (page: Page, param?: unknown) => void;
  /** Open a management page for a dependant (or the owner, null) without choosing that scope. */
  openDependantPage: (page: Page, dependantId: string | null, param?: unknown) => void;
  /** The dependant the app is scoped to, or null; a removed dependant reads as null. */
  activeDependantId: string | null;
  /** A scope the user chose (child mode, "Switch to …", "Back to me"). Stays past home. */
  chooseDependantScope: (id: string | null) => void;
  /** A page parameter set on the page itself, without navigating. Put back on reaching home. */
  borrowActiveDependantId: (id: string | null) => void;
  /** The user chose the borrowed scope after all ("Switch to …" after an import). */
  keepActiveDependantId: () => void;
  /**
   * This dependant was removed on this device: it stops being the scope, the
   * scope to put back, and the scope of any history entry, for the rest of
   * the session, even if a sync merges the record back.
   */
  endDependantScope: (id: string) => void;
}

interface View { page: Page; param: unknown }

/**
 * The page, its parameter, the dependant scope and history, wired together.
 * Every route to a page goes through here so neither the scope nor the
 * parameter can drift from the page:
 *
 * - reaching home (back, hardware back, the Home tab, a replace) puts back the
 *   scope from before a management page borrowed it;
 * - every history entry records the scope its page was shown under and its
 *   parameter, and going back or forward to it shows it with both again, in
 *   the same render;
 * - an entry whose dependant is gone (or was removed this session), whose
 *   parameter names something gone, or a dependant-only page with no
 *   dependant, goes home.
 */
export function useAppNavigation(opts: AppNavigationOptions): AppNavigation {
  const [view, setView] = useState<View>({ page: 'home', param: undefined });
  const [scope, setScope] = useState<DependantScope>(INITIAL_DEPENDANT_SCOPE);
  // The scope as of the latest action, readable in the same handler (the entry
  // a navigateTo pushes right after a borrow must record the borrowed id).
  const scopeRef = useRef(scope);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const apply = useCallback((action: DependantScopeAction) => {
    // A page opened "for" someone must not move child mode onto the guardian
    // or a sibling. Only `borrow` is refused: `set` is how child mode is
    // entered, left and switched.
    if (action.type === 'borrow' && optsRef.current.isScopeLocked()) return;
    const next = dependantScopeReducer(scopeRef.current, action);
    if (next === scopeRef.current) return;
    scopeRef.current = next;
    setScope(next);
  }, []);

  /** The single resolver every stored id is read through, ended set included. */
  const live = useCallback(
    (id: string | null) => liveScopeId(id, optsRef.current.isLive, scopeRef.current.ended),
    [],
  );

  // Shows the entry useNavigation hands over; its parameter comes with it.
  const show = useCallback((next: Page, entry?: NavigationEntry) => {
    if (next === 'home') apply({ type: 'arrived-home' });
    setView({ page: next, param: next === 'home' ? undefined : entry?.param });
  }, [apply]);

  const entryFields = useCallback(() => ({ dependantId: live(scopeRef.current.id) }), [live]);

  const resolvePop = useCallback((entry: NavigationEntry): Page => {
    const o = optsRef.current;
    const resolution = resolvePoppedEntry({
      page: entry.page,
      entryDependantId: typeof entry.dependantId === 'string' ? entry.dependantId : null,
      currentId: live(scopeRef.current.id),
      locked: o.isScopeLocked(),
      isLive: id => live(id) !== null,
      needsDependant: o.needsDependant(entry.page),
    });
    if (resolution.show === 'home') return 'home';
    if (o.isPageParamLive && !o.isPageParamLive(entry.page, entry.param)) return 'home';
    if (resolution.borrow !== undefined) apply({ type: 'borrow', id: resolution.borrow });
    return entry.page;
  }, [apply, live]);

  const nav = useNavigation(show, {
    isBounded: () => optsRef.current.isBounded?.() ?? false,
    onAttemptBoundaryExit: () => optsRef.current.onAttemptBoundaryExit?.(),
    entryFields,
    resolvePop,
  });

  const navigateTo = useCallback((target: Page, param?: unknown) => {
    nav.navigateTo(target, param === undefined ? undefined : { param });
  }, [nav.navigateTo]);
  const navigateReplace = useCallback((target: Page, param?: unknown) => {
    nav.navigateReplace(target, param === undefined ? undefined : { param });
  }, [nav.navigateReplace]);

  const openDependantPage = useCallback((target: Page, dependantId: string | null, param?: unknown) => {
    apply({ type: 'borrow', id: dependantId });
    navigateTo(target, param);
  }, [apply, navigateTo]);
  const chooseDependantScope = useCallback((id: string | null) => apply({ type: 'set', id }), [apply]);
  const borrowActiveDependantId = useCallback((id: string | null) => apply({ type: 'borrow', id }), [apply]);
  const keepActiveDependantId = useCallback(() => apply({ type: 'commit' }), [apply]);
  const endDependantScope = useCallback((id: string) => apply({ type: 'ended', id }), [apply]);

  return {
    page: view.page,
    pageParam: view.param,
    navigateTo,
    navigateBack: nav.navigateBack,
    navigateReplace,
    openDependantPage,
    activeDependantId: liveScopeId(scope.id, opts.isLive, scope.ended),
    chooseDependantScope,
    borrowActiveDependantId,
    keepActiveDependantId,
    endDependantScope,
  };
}
