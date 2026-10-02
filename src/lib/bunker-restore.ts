// src/lib/bunker-restore.ts
//
// Android bunker state that must come back after the app is swiped away, its
// process dies or the phone reboots. Keys cannot come back without an unlock,
// so both rules only ever act on an unlocked page.

/**
 * The stay-awake window to resume on unlock, from the stored wall-clock end
 * (Date.now()-based ms — not elapsedRealtime, which resets on reboot).
 * Returns the SAME end when it is still in the future (the window is never
 * extended), or null when it has passed or nothing usable was stored.
 */
export function resolveStayAwakeOnUnlock(storedEnd: number | null | undefined, now: number): number | null {
  if (typeof storedEnd !== 'number' || !Number.isFinite(storedEnd)) return null;
  return storedEnd > now ? storedEnd : null;
}

/**
 * Combine a restored end with whatever window is already open (a "+X min"
 * pressed to unlock arms its own window in the same render): keep the later.
 */
export function mergeRestoredStayAwake(current: number | null, restored: number): number {
  return current !== null && current > restored ? current : restored;
}

export interface RearmAlwaysOnInput {
  native: boolean;
  unlocked: boolean;
  prefsLoading: boolean;
  /** `AppPreferences.backgroundBunkerEnabled` */
  enabledPref: boolean | undefined;
  /** Always-on serving is already armed on this page. */
  serving: boolean;
  /** An arm is already in flight on this page. */
  inFlight: boolean;
  /** Owner routes the service will serve; empty right after unlock. */
  servePubkeyCount: number;
}

/**
 * Re-arm always-on serving after an unlock: only once preferences have
 * loaded and the serve routes exist (an arm with no pubkeys persists an empty
 * set for the boot receiver and the fallback poll), and only once per page.
 */
export function shouldRearmAlwaysOn(i: RearmAlwaysOnInput): boolean {
  return i.native
    && i.unlocked
    && !i.prefsLoading
    && i.enabledPref === true
    && !i.serving
    && !i.inFlight
    && i.servePubkeyCount > 0;
}

export interface PromptUnlockForAlwaysOnInput {
  native: boolean;
  /** Identity or preferences still loading. */
  loading: boolean;
  hasIdentity: boolean;
  authSetUp: boolean;
  /** A key is in memory, or an auth setup is already pending. */
  unlocked: boolean;
  promptOpen: boolean;
  /** `AppPreferences.backgroundBunkerEnabled` */
  enabledPref: boolean | undefined;
  pairedChild: boolean;
}

/**
 * Ask for the unlock on open when always-on is set but the page is locked:
 * serving needs the key, and without a prompt always-on stays silently off.
 * A paired-child install has its own auto-prompt.
 */
export function shouldPromptUnlockForAlwaysOn(i: PromptUnlockForAlwaysOnInput): boolean {
  return i.native
    && !i.loading
    && i.hasIdentity
    && i.authSetUp
    && !i.unlocked
    && !i.promptOpen
    && i.enabledPref === true
    && !i.pairedChild;
}
