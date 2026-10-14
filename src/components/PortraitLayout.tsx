import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { Z } from '../lib/z-index';

/** Physical orientation, not the keyboard shrinking a portrait viewport. */
function needsPortrait(): boolean {
  if (!window.matchMedia('(pointer: coarse)').matches) return false;
  const type = window.screen.orientation?.type;
  const legacy = (window as Window & { orientation?: number }).orientation;
  const landscape = type ? type.startsWith('landscape')
    : typeof legacy === 'number' ? Math.abs(legacy) === 90
      : window.screen.width > window.screen.height;
  return landscape && window.innerWidth > window.innerHeight;
}

/** Keep the app mounted when a browser or tablet OS refuses portrait locking. */
export function PortraitLayout({ children }: { children: ReactNode }) {
  const [turnUpright, setTurnUpright] = useState(false);
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!turnUpright) return;
    const previous = document.activeElement;
    notice.current?.focus({ preventScroll: true });
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, [turnUpright]);
  useEffect(() => {
    let active = true, locking = false;
    const update = () => { if (active) setTurnUpright(needsPortrait()); };
    const requestPortrait = () => {
      update();
      if (!window.matchMedia('(pointer: coarse)').matches || locking || document.visibilityState === 'hidden') return;
      const orientation = window.screen.orientation as (ScreenOrientation & {
        lock?: (orientation: 'portrait-primary') => Promise<void>;
      }) | undefined;
      if (!orientation?.lock) return;
      locking = true;
      // Installed PWAs can support this. Ordinary tabs and Safari may refuse;
      // do not force fullscreen or lose the current form when that happens.
      try {
        void orientation.lock('portrait-primary').catch(() => {}).finally(() => { locking = false; update(); });
      } catch { locking = false; }
    };
    requestPortrait();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', requestPortrait);
    window.screen.orientation?.addEventListener('change', requestPortrait);
    document.addEventListener('fullscreenchange', requestPortrait);
    document.addEventListener('visibilitychange', requestPortrait);
    return () => {
      active = false;
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', requestPortrait);
      window.screen.orientation?.removeEventListener('change', requestPortrait);
      document.removeEventListener('fullscreenchange', requestPortrait);
      document.removeEventListener('visibilitychange', requestPortrait);
    };
  }, []);

  return <>
    <div className="portrait-app" inert={turnUpright || undefined} aria-hidden={turnUpright || undefined}>{children}</div>
    {turnUpright && (
      <div className="portrait-notice" ref={notice} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="portrait-title" style={{ zIndex: Z.orientation }}>
        <div className="portrait-notice-icon"><Icon name="smartphone" size={48} /></div>
        <h1 id="portrait-title">Turn your device upright</h1>
        <p>Signet works in portrait. Your place is saved — turn your phone or tablet upright to continue.</p>
      </div>
    )}
  </>;
}
