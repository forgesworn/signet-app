import { useEffect, useRef } from 'react';
import type { ChildModeState } from '../lib/child-mode-sign-in';

/** Calls `onEntered` each time child mode becomes `on` (from off or unknown), once per entry. */
export function useOnChildModeEntered(childMode: ChildModeState, onEntered: () => void): void {
  const ref = useRef(onEntered);
  ref.current = onEntered;
  const wasOn = useRef(false);
  useEffect(() => {
    const on = childMode === 'on';
    if (on && !wasOn.current) ref.current();
    wasOn.current = on;
  }, [childMode]);
}
