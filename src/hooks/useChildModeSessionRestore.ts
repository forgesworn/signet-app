import { useEffect, useRef } from 'react';
import { loadChildModeSession, clearChildModeSession } from '../lib/db';
import { childModeSessionStale } from '../lib/child-mode-sign-in';

export interface ChildModeSessionRestoreInput {
  /** Identity and preferences have finished loading. */
  ready: boolean;
  /** An encryption key is held (the app is unlocked). */
  unlocked: boolean;
  dependantIds: readonly string[];
  /** The dependants list has been read with the key, so "not found" now means gone. */
  dependantsLoadedWithKey: boolean;
  /** Child mode is already live. */
  childModeLive: boolean;
  /** Set once the saved session has been dealt with (or child mode entered by hand). */
  restoredRef: React.MutableRefObject<boolean>;
  onRestore: (dependantId: string) => void;
  /** The saved session is gone or can never restore: drop what the start-up read held. */
  onDrop: () => void;
  loadSession?: () => Promise<{ activeDependantId: string } | null>;
  clearSession?: () => Promise<void>;
}

/**
 * Restores child mode from the session saved on disk, once unlocked, and drops
 * a session that can never restore.
 *
 * The session's own dependant id decides, not the start-up read of the
 * dependant's facts. That read is empty when the record was missing at
 * start-up, so a check keyed on it never fired: the session stayed on disk,
 * and when a sync later merged the dependant in, the restore ran and switched
 * child mode on in the middle of the guardian using the phone. Once the
 * dependants have been read with the key and the record is absent, the session
 * is cleared and marked handled, so a later merge cannot bring it back.
 *
 * Until that keyed read is in, "not found" proves nothing, so the hook waits
 * and runs again when its inputs change.
 */
export function useChildModeSessionRestore(input: ChildModeSessionRestoreInput): void {
  const {
    ready, unlocked, dependantIds, dependantsLoadedWithKey, childModeLive, restoredRef,
  } = input;
  const onRestoreRef = useRef(input.onRestore);
  const onDropRef = useRef(input.onDrop);
  const loadSessionRef = useRef(input.loadSession ?? loadChildModeSession);
  const clearSessionRef = useRef(input.clearSession ?? clearChildModeSession);
  onRestoreRef.current = input.onRestore;
  onDropRef.current = input.onDrop;
  loadSessionRef.current = input.loadSession ?? loadChildModeSession;
  clearSessionRef.current = input.clearSession ?? clearChildModeSession;

  const idsKey = dependantIds.join(',');

  useEffect(() => {
    if (!ready || !unlocked) return;
    if (restoredRef.current) return;
    let cancelled = false;
    loadSessionRef.current().then(session => {
      if (cancelled || restoredRef.current) return;
      if (!session) {
        restoredRef.current = true;
        // No saved session any more (cleared in another tab or instance): drop what the
        // start-up read held, so the banner, hidden Bunker tab and child-only sign-ins lift.
        onDropRef.current();
        return;
      }
      const id = session.activeDependantId;
      if (dependantIds.includes(id)) {
        restoredRef.current = true;
        onRestoreRef.current(id);
        return;
      }
      if (childModeSessionStale({
        unlocked,
        dependantsLoadedWithKey,
        childModeLive,
        sessionDependantId: id,
        dependantIds,
      })) {
        restoredRef.current = true;
        clearSessionRef.current().catch(() => {});
        onDropRef.current();
      }
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, unlocked, idsKey, dependantsLoadedWithKey, childModeLive, restoredRef]);
}
