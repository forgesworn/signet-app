import { useEffect, useRef } from 'react';
import type { Page } from '../types';
import type { ChildModePageDecision } from '../lib/child-mode-page-allowlist';

/**
 * Runs `onLeave` when child mode is on and the child leaves a refused page by
 * any route: the tab bar, Back or history, Home, or Decline. Whatever the
 * navigation to that page staged (a scanned operator-import link, a pairing or
 * verify request) must not wait there for the guardian to exit.
 */
export function useOnLeaveRefusedPage(opts: {
  page: Page;
  decision: ChildModePageDecision;
  /** Child mode is on (live, saved or unknown). */
  childModeOn: boolean;
  onLeave: () => void;
}): void {
  const { page, decision, childModeOn } = opts;
  const prev = useRef<{ page: Page; decision: ChildModePageDecision } | null>(null);
  const onLeaveRef = useRef(opts.onLeave);
  onLeaveRef.current = opts.onLeave;
  useEffect(() => {
    const before = prev.current;
    prev.current = { page, decision };
    if (!before || before.decision !== 'refuse' || !childModeOn) return;
    if (before.page !== page || decision !== 'refuse') onLeaveRef.current();
  }, [page, decision, childModeOn]);
}
