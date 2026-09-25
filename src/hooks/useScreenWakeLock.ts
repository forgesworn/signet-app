// src/hooks/useScreenWakeLock.ts
import { useEffect, useRef } from 'react';

/** True when the Screen Wake Lock API is available in this browser. */
export function isWakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

/**
 * Hold a screen wake-lock while `active` is true so the display does not dim.
 * Used by the Stay-awake window and the venue-entry boarding-pass QR.
 *
 * - Requests `navigator.wakeLock.request('screen')` when `active` turns true.
 * - Releases the sentinel when `active` turns false or on unmount.
 * - Re-acquires on `visibilitychange → visible` (the platform auto-releases the
 *   sentinel whenever the document is hidden).
 * - No-ops gracefully when the API is unsupported or the request is denied.
 *
 * No `console.*` — failures are swallowed; a missing wake-lock only means the
 * screen may dim, it never blocks signing.
 */
export function useScreenWakeLock(active: boolean): void {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!active || !isWakeLockSupported()) return;

    let cancelled = false;

    const acquire = async () => {
      if (cancelled || sentinelRef.current) return;
      try {
        const sentinel = await navigator.wakeLock.request('screen');
        if (cancelled) {
          void sentinel.release().catch(() => { /* ignore */ });
          return;
        }
        sentinelRef.current = sentinel;
        sentinel.addEventListener('release', () => {
          if (sentinelRef.current === sentinel) sentinelRef.current = null;
        });
      } catch {
        // unsupported / denied / document not visible — leave the screen to dim
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      if (sentinel) void sentinel.release().catch(() => { /* ignore */ });
    };
  }, [active]);
}
