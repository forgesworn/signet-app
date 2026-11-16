import { useCallback, useReducer } from 'react';
import type { Page } from '../types';
import { dependantScopeReducer, INITIAL_DEPENDANT_SCOPE } from '../lib/dependant-scope';

export interface DependantScopeControls {
  /** The dependant the app is scoped to, or null for the owner. */
  activeDependantId: string | null;
  /** A scope the user chose (child mode, "Switch to …", "Back to me"). Stays past home. */
  setActiveDependantId: (id: string | null) => void;
  /** A management page's parameter. The prior scope comes back on reaching home. */
  borrowActiveDependantId: (id: string | null) => void;
  /** The user chose the borrowed scope after all ("Switch to …" after an import). */
  keepActiveDependantId: () => void;
  /** A dependant was removed: drop it from the scope and from any pending restore. */
  forgetActiveDependantId: (id: string) => void;
  /**
   * `setPage` that also puts a borrowed scope back whenever the page becomes
   * home, in the same render. Hand THIS to `useNavigation`, so the back
   * button, hardware back, the Home tab and every replace to home all go
   * through it.
   */
  setPage: (page: Page) => void;
}

export function useDependantScope(setPageState: (page: Page) => void): DependantScopeControls {
  const [scope, dispatch] = useReducer(dependantScopeReducer, INITIAL_DEPENDANT_SCOPE);
  const setActiveDependantId = useCallback((id: string | null) => dispatch({ type: 'set', id }), []);
  const borrowActiveDependantId = useCallback((id: string | null) => dispatch({ type: 'borrow', id }), []);
  const keepActiveDependantId = useCallback(() => dispatch({ type: 'commit' }), []);
  const forgetActiveDependantId = useCallback((id: string) => dispatch({ type: 'forget', id }), []);
  const setPage = useCallback((page: Page) => {
    if (page === 'home') dispatch({ type: 'arrived-home' });
    setPageState(page);
  }, [setPageState]);
  return {
    activeDependantId: scope.id,
    setActiveDependantId,
    borrowActiveDependantId,
    keepActiveDependantId,
    forgetActiveDependantId,
    setPage,
  };
}
