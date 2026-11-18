import { useEffect, useRef } from 'react';
import type { Page } from '../types';
import type { ChildModePageDecision } from '../lib/child-mode-page-allowlist';

/**
 * Runs `onLeave` when a refused page (child mode only ever refuses) is left by
 * any route: the tab bar, Back or history, Home, Decline, or the guardian's PIN
 * turning child mode off on that very page. Whatever the navigation to that
 * page staged (a scanned operator-import link, a pairing or verify request)
 * must not wait there for the guardian to exit.
 *
 * A refuse-then-allow flip on the SAME page while locked is not a leave: the
 * dependants list empties and reloads around a lock, which reads as the scope
 * going and coming back, and clearing then would drop a page the child is on.
 */
export function useOnLeaveRefusedPage(opts: {
  page: Page;
  decision: ChildModePageDecision;
  /** The app has no encryption key (locked). */
  locked?: boolean;
  onLeave: () => void;
}): void {
  const { page, decision, locked } = opts;
  const prev = useRef<{ page: Page; decision: ChildModePageDecision } | null>(null);
  const onLeaveRef = useRef(opts.onLeave);
  onLeaveRef.current = opts.onLeave;
  useEffect(() => {
    const before = prev.current;
    prev.current = { page, decision };
    if (!before || before.decision !== 'refuse') return;
    if (before.page === page && decision !== 'refuse' && locked) return;
    if (before.page !== page || decision !== 'refuse') onLeaveRef.current();
  }, [page, decision, locked]);
}
