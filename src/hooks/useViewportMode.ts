import { useEffect, useState } from 'react';

export const DESKTOP_BREAKPOINT_PX = 720;

// One flow: the app always renders its mobile layout. On wide screens the whole
// app is hosted inside a centred phone frame (see DesktopFrame + useWideViewport),
// so every component renders its mobile branch regardless of window width.

function getInitialWide(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT_PX}px)`).matches;
}

// True when the real window is wide enough to host the app inside a desktop
// phone-frame. Consumed ONLY by DesktopFrame.
export function useWideViewport(): boolean {
  const [wide, setWide] = useState<boolean>(getInitialWide);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT_PX}px)`);
    const update = () => setWide(mql.matches);
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);
  return wide;
}
