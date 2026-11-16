import { useCallback, useRef, useState } from 'react';
import type { Page } from '../types';
import { useNavigation } from './useNavigation';
import {
  dependantScopeReducer, INITIAL_DEPENDANT_SCOPE, liveScopeId, resolvePoppedEntry,
  type DependantScope, type DependantScopeAction,
} from '../lib/dependant-scope';

export interface AppNavigationOptions {
  /** Whether a dependant with this id exists now. */
  isLive: (dependantId: string) => boolean;
  /** Deliberate child mode: history never re-scopes it (it goes home instead). */
  isScopeLocked: () => boolean;
  /** Whether `page` needs a dependant in scope on this install (`pageNeedsDependant`). */
  needsDependant: (page: Page) => boolean;
  /** Passed to useNavigation: hardware/browser back is pinned while true. */
  isBounded?: () => boolean;
  /** Passed to useNavigation: called on a pinned hardware/browser back. */
  onAttemptBoundaryExit?: () => void;
}

export interface AppNavigation {
  page: Page;
  navigateTo: (page: Page) => void;
  navigateBack: () => void;
  navigateReplace: (page: Page) => void;
  /** Open a management page for a dependant (or the owner, null) without choosing that scope. */
  openDependantPage: (page: Page, dependantId: string | null) => void;
  /** The dependant the app is scoped to, or null; a removed dependant reads as null. */
  activeDependantId: string | null;
  /** A scope the user chose (child mode, "Switch to …", "Back to me"). Stays past home. */
  setActiveDependantId: (id: string | null) => void;
  /** A page parameter set on the page itself, without navigating. Put back on reaching home. */
  borrowActiveDependantId: (id: string | null) => void;
  /** The user chose the borrowed scope after all ("Switch to …" after an import). */
  keepActiveDependantId: () => void;
  /** Bare page setter for the DEV harness; reaching home still puts a borrowed scope back. */
  setPage: (page: Page) => void;
}

/**
 * The page, the dependant scope and history, wired together. Every route to a
 * page goes through here so the scope cannot drift from the page:
 *
 * - reaching home (back, hardware back, the Home tab, a replace) puts back the
 *   scope from before a management page borrowed it;
 * - every history entry records the scope its page was shown under, and going
 *   back or forward to it shows it under that scope again, in the same render;
 * - an entry whose dependant is gone, or a dependant-only page with no
 *   dependant, goes home.
 */
export function useAppNavigation(opts: AppNavigationOptions): AppNavigation {
  const [page, setPageState] = useState<Page>('home');
  const [scope, setScope] = useState<DependantScope>(INITIAL_DEPENDANT_SCOPE);
  // The scope as of the latest action, readable in the same handler (the entry
  // a navigateTo pushes right after a borrow must record the borrowed id).
  const scopeRef = useRef(scope);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const apply = useCallback((action: DependantScopeAction) => {
    const next = dependantScopeReducer(scopeRef.current, action);
    if (next === scopeRef.current) return;
    scopeRef.current = next;
    setScope(next);
  }, []);

  const setPage = useCallback((next: Page) => {
    if (next === 'home') apply({ type: 'arrived-home' });
    setPageState(next);
  }, [apply]);

  const entryFields = useCallback(() => ({
    dependantId: liveScopeId(scopeRef.current.id, optsRef.current.isLive),
  }), []);

  const resolvePop = useCallback((entry: { page: Page } & Record<string, unknown>): Page => {
    const o = optsRef.current;
    const resolution = resolvePoppedEntry({
      page: entry.page,
      entryDependantId: typeof entry.dependantId === 'string' ? entry.dependantId : null,
      currentId: liveScopeId(scopeRef.current.id, o.isLive),
      locked: o.isScopeLocked(),
      isLive: o.isLive,
      needsDependant: o.needsDependant(entry.page),
    });
    if (resolution.show === 'home') return 'home';
    if (resolution.borrow !== undefined) apply({ type: 'borrow', id: resolution.borrow });
    return entry.page;
  }, [apply]);

  const { navigateTo, navigateBack, navigateReplace } = useNavigation(setPage, {
    isBounded: () => optsRef.current.isBounded?.() ?? false,
    onAttemptBoundaryExit: () => optsRef.current.onAttemptBoundaryExit?.(),
    entryFields,
    resolvePop,
  });

  const openDependantPage = useCallback((target: Page, dependantId: string | null) => {
    apply({ type: 'borrow', id: dependantId });
    navigateTo(target);
  }, [apply, navigateTo]);
  const setActiveDependantId = useCallback((id: string | null) => apply({ type: 'set', id }), [apply]);
  const borrowActiveDependantId = useCallback((id: string | null) => apply({ type: 'borrow', id }), [apply]);
  const keepActiveDependantId = useCallback(() => apply({ type: 'commit' }), [apply]);

  return {
    page,
    navigateTo,
    navigateBack,
    navigateReplace,
    openDependantPage,
    activeDependantId: liveScopeId(scope.id, opts.isLive),
    setActiveDependantId,
    borrowActiveDependantId,
    keepActiveDependantId,
    setPage,
  };
}
