import { useRegisterSW } from 'virtual:pwa-register/react';
import { isNativeApp } from '../lib/native';

/**
 * Web: registers the PWA service worker and polls for updates (unchanged
 * behaviour, code moved verbatim from App.tsx). Native APK: a no-op —
 * assets ship inside the APK; a SW would only serve stale caches and the
 * update poll has no server to poll.
 *
 * The conditional hook call is safe: isNativeApp() is constant for the
 * lifetime of the WebView, so hook order can never change between renders.
 */
export function useSwUpdate(): { needRefresh: boolean; updateServiceWorker: (reloadPage?: boolean) => Promise<void> | void } {
  if (isNativeApp()) {
    return { needRefresh: false, updateServiceWorker: () => {} };
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_swUrl, r) {
      if (!r) return;
      setInterval(() => {
        if (typeof navigator !== 'undefined' && 'onLine' in navigator && !navigator.onLine) return;
        r.update().catch(() => { /* offline / transient — retry next tick */ });
      }, 60_000);
    },
  });
  return { needRefresh, updateServiceWorker };
}
