import { useEffect, useRef } from 'react';
import type { ChildModeState } from '../lib/child-mode-sign-in';

/**
 * A contact invite that arrives by native link or `#contact-invite` hash while child
 * mode is on is dropped, exactly as a scanned one is refused: the child never starts
 * the guardian's contact flow, and nothing is parked to open after the PIN exit. An
 * invite that arrives while child mode is still `unknown` (the start-up read) waits
 * for the answer: dropped if it turns out on, opened as before if off.
 */
export function useDropInviteInChildMode(opts: {
  childMode: ChildModeState;
  pendingInvite: string | undefined;
  onDrop: () => void;
}): void {
  const { childMode, pendingInvite } = opts;
  const onDropRef = useRef(opts.onDrop);
  onDropRef.current = opts.onDrop;
  useEffect(() => {
    if (childMode === 'on' && pendingInvite) onDropRef.current();
  }, [childMode, pendingInvite]);
}
