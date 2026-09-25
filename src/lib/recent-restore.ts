/**
 * Post-restore "re-pair your children" banner marker.
 *
 * When a guardian restores their mnemonic onto a new phone, their
 * dependants' metadata syncs via cross-device sync but the per-dependant endpoint
 * keypairs do NOT — they're random, not derived from the
 * mnemonic, so they can't be reconstituted from backup words alone.
 * Every paired child device is therefore orphaned post-restore.
 *
 * This module provides a persistent marker that a restore recently
 * happened, so the home surface can surface a banner prompting the
 * guardian to re-pair child devices. Stored in localStorage rather
 * than AppPreferences because:
 *   - AppPreferences writes through a React hook gated on the
 *     encryption key; the marker needs to survive the restore->unlock
 *     handoff before that hook is ready.
 *   - localStorage is synchronous, avoiding an async race at render.
 *   - The marker is per-device UX state, not identity state — it
 *     belongs with other local-only flags, not the synced profile.
 *
 * Auto-expires after `RECENT_RESTORE_WINDOW_MS` (default 7 days). After
 * that the marker is ignored — a guardian who ignored the banner for
 * a week will see it disappear naturally rather than nag forever.
 */

const STORAGE_KEY = 'signet:recent-restore';
export const RECENT_RESTORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Record that a restore completed. Safe to call from a plain async handler. */
export function markRecentRestore(): void {
  try { localStorage.setItem(STORAGE_KEY, String(Date.now())); } catch { /* SSR / disabled */ }
}

/**
 * Returns true if a restore completed within the recent-restore window.
 * Treats malformed / missing / expired markers as false.
 */
export function hasRecentRestore(now: number = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const ts = parseInt(raw, 10);
    if (!Number.isFinite(ts) || ts <= 0) return false;
    return now - ts < RECENT_RESTORE_WINDOW_MS;
  } catch {
    return false;
  }
}

/** Clear the marker. Called when the user dismisses or acts on the banner. */
export function clearRecentRestore(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
