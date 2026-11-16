import { useCallback, useEffect, useRef } from 'react';
import type { Page } from '../types';

/** A history entry: the page, plus whatever the caller stores with it. */
export type NavigationEntry = { page: Page } & Record<string, unknown>;

interface NavigationActions {
  /** Push `page`; `extra` is stored on its entry and handed to `setPage`. */
  navigateTo: (page: Page, extra?: Record<string, unknown>) => void;
  navigateBack: () => void;
  /** Replace the current entry with `page`; `extra` as for navigateTo. */
  navigateReplace: (page: Page, extra?: Record<string, unknown>) => void;
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
  /**
   * Extra fields stored on every entry navigateTo / navigateReplace /
   * navigateBack write. Read after `setPage`, so state the caller updates in
   * `setPage` is what gets stored.
   */
  entryFields?: () => Record<string, unknown>;
  /**
   * Decides what a popped entry shows, before `setPage`. The caller may update
   * its own state for that entry here; it renders in the same pass. Returning
   * another page rewrites the entry to it.
   */
  resolvePop?: (entry: NavigationEntry) => Page;
}

/** How many in-app entries sit below the current one. An entry without a
 *  depth (the mount entry, or one replaced from outside this hook) is the
 *  bottom of the app's own history. */
function currentDepth(): number {
  const depth = (window.history.state as { depth?: unknown } | null)?.depth;
  return typeof depth === 'number' && depth > 0 ? depth : 0;
}

/**
 * `setPage` is told the entry it is showing whenever there is one (a push, a
 * replace, or a popped entry shown as it is), so state the caller keeps per
 * entry comes from the same object as the page. Going home without an entry
 * (the bottom of history) passes the page alone.
 */
export function useNavigation(
  setPage: (page: Page, entry?: NavigationEntry) => void,
  opts?: NavigationOptions,
): NavigationActions {
  // Keep latest opts in a ref so the effect doesn't re-attach on every render
  const isBoundedRef = useRef(opts?.isBounded);
  isBoundedRef.current = opts?.isBounded;
  const onAttemptBoundaryExitRef = useRef(opts?.onAttemptBoundaryExit);
  onAttemptBoundaryExitRef.current = opts?.onAttemptBoundaryExit;
  const entryFieldsRef = useRef(opts?.entryFields);
  entryFieldsRef.current = opts?.entryFields;
  const resolvePopRef = useRef(opts?.resolvePop);
  resolvePopRef.current = opts?.resolvePop;

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
        window.history.pushState({ page: 'home', depth: currentDepth() + 1 }, '');
        onAttemptBoundaryExitRef.current?.();
        return;
      }
      const state = e.state as NavigationEntry | null;
      if (state?.page) {
        const target = resolvePopRef.current ? resolvePopRef.current(state) : state.page;
        if (target !== state.page) {
          window.history.replaceState({ ...state, page: target }, '');
          setPage(target);
        } else {
          setPage(target, state);
        }
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

  const navigateTo = useCallback((page: Page, extra?: Record<string, unknown>) => {
    setPage(page, { ...extra, page });
    window.history.pushState({ ...entryFieldsRef.current?.(), ...extra, page, depth: currentDepth() + 1 }, '');
  }, [setPage]);

  // A page reached only by replaces (e.g. a signet-grant: link → approve →
  // code check → companion apps) has nothing of the app's below it, and
  // history.back() is then a silent no-op, or leaves the app entirely: the
  // back chevron did nothing (2026-09-27 device test). Go home instead.
  const navigateBack = useCallback(() => {
    if (currentDepth() === 0) {
      setPage('home');
      window.history.replaceState({ ...entryFieldsRef.current?.(), page: 'home', depth: 0 }, '');
      return;
    }
    pendingIntentionalBacksRef.current++;
    window.history.back();
  }, [setPage]);

  const navigateReplace = useCallback((page: Page, extra?: Record<string, unknown>) => {
    setPage(page, { ...extra, page });
    window.history.replaceState({ ...entryFieldsRef.current?.(), ...extra, page, depth: currentDepth() }, '');
  }, [setPage]);

  return { navigateTo, navigateBack, navigateReplace };
}
