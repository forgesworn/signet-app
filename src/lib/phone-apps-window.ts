/**
 * The phone-apps window: after serving an app on this phone over NIP-55, a
 * hidden MySignet keeps its key for a few minutes, so the apps it serves are
 * answered without a screen (see `PHONE_APPS_WINDOW_MS` in App.tsx).
 *
 * The window used to end on a `setTimeout`. Chromium freezes a hidden page
 * about a minute after it is hidden, timers included, so the timer never
 * fired, and when the page thawed it was visible and the lock was skipped:
 * the key stayed in memory for as long as the apps kept asking. The deadline
 * is now a wall-clock timestamp checked whenever the page can run again
 * (visible, resumed) and before every NIP-55 request is answered.
 */
export interface PhoneAppsWindowState {
  now: number;
  /** When the app was hidden, or null while it has been visible since. */
  hiddenAt: number | null;
  /** End of the window, or null when no phone app has been served. */
  until: number | null;
  /** A stay-awake window or always-on serving holds the key on purpose. */
  exempt: boolean;
  /**
   * The key has already been found expired and its lock asked for, but the
   * lock has not rendered yet. Stays expired until it has: the first thing
   * to see the deadline (a resume, say) must not leave the NIP-55 request
   * handled right after it in the same task to find a key still there.
   */
  lockPending?: boolean;
}

/**
 * Whether the key held for phone apps has outlived its window and must be
 * dropped before anything else is answered. Only while the app has been
 * hidden: a visible app is under the person's eyes and the idle lock rules.
 */
export function phoneAppsKeyExpired({ now, hiddenAt, until, exempt, lockPending = false }: PhoneAppsWindowState): boolean {
  if (lockPending) return true;
  if (exempt) return false;
  if (hiddenAt === null || until === null) return false;
  return now >= until;
}
