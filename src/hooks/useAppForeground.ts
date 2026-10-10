import { useEffect, useState } from 'react';
import { isNativeApp, SignetNative } from '../lib/native';

/**
 * True while the app is actually on screen. The page's own visibility is not
 * enough on the APK: the always-on bunker keeps the WebView marked visible in
 * the background, so the native shell's start/stop is consulted too. Pollers
 * that can wait until the user returns pause while this is false.
 */
export function useAppForeground(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(() => {
    if (!isNativeApp()) return;
    let stopped = false, remove: (() => void) | undefined;
    void SignetNative.addListener('nearbyLifecycle', e => setShown(e.state !== 'background'))
      .then(sub => { if (stopped) void sub.remove(); else remove = () => { void sub.remove(); }; })
      .catch(() => {});
    return () => { stopped = true; remove?.(); };
  }, []);
  return visible && shown;
}
