import { useCallback, useEffect, useRef } from 'react';
import type { Page } from '../types';

interface NavigationActions {
  navigateTo: (page: Page) => void;
  navigateBack: () => void;
  navigateReplace: (page: Page) => void;
}

interface NavigationOptions {
  /**
   * Return true when the app is inside a bounded session (e.g. child-mode).
   * Popstate is intercepted: history is re-pinned and onAttemptBoundaryExit
   * is fired so the caller can route it through a PIN gate or similar.
   */
  isBounded?: () => boolean;
  /** Called when popstate fires while isBounded() is true. */
  onAttemptBoundaryExit?: () => void;
}

export function useNavigation(
  setPage: (page: Page) => void,
  opts?: NavigationOptions,
): NavigationActions {
  // Keep latest opts in a ref so the effect doesn't re-attach on every render
  const isBoundedRef = useRef(opts?.isBounded);
  isBoundedRef.current = opts?.isBounded;
  const onAttemptBoundaryExitRef = useRef(opts?.onAttemptBoundaryExit);
  onAttemptBoundaryExitRef.current = opts?.onAttemptBoundaryExit;

  // Counts in-flight intentional back navigations originating from
  // `navigateBack()` (i.e. the in-app back chevron, "Cancel" buttons, etc.)
  // so the popstate handler can distinguish them from hardware / browser
  // back. Hardware back stays gated by the bounded-session exit flow;
  // in-app back navigates within the session without a PIN prompt.
  const pendingIntentionalBacksRef = useRef(0);

  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      const intentional = pendingIntentionalBacksRef.current > 0;
      if (intentional) pendingIntentionalBacksRef.current--;

      if (isBoundedRef.current?.() && !intentional) {
        // Hardware / browser back inside a bounded session (child-mode).
        // Re-pin history and route through the caller's gated exit handler.
        // See dependant-account-ux-spec §2.
        window.history.pushState({ page: 'home' }, '');
        onAttemptBoundaryExitRef.current?.();
        return;
      }
      const state = e.state as { page: Page } | null;
      if (state?.page) {
        setPage(state.page);
      } else {
        // Refresh-then-back guard: after page refresh, history may be shallow.
        // Stay on home instead of exiting the app.
        setPage('home');
        window.history.replaceState({ page: 'home' }, '');
      }
    };

    // Set initial history state
    window.history.replaceState({ page: 'home' }, '');

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [setPage]);

  const navigateTo = useCallback((page: Page) => {
    setPage(page);
    window.history.pushState({ page }, '');
  }, [setPage]);

  const navigateBack = useCallback(() => {
    pendingIntentionalBacksRef.current++;
    window.history.back();
  }, []);

  const navigateReplace = useCallback((page: Page) => {
    setPage(page);
    window.history.replaceState({ page }, '');
  }, [setPage]);

  return { navigateTo, navigateBack, navigateReplace };
}
