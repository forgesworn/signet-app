/**
 * Lock the app, but flush pending relay publishes first.
 *
 * When nothing is pending the lock is synchronous, exactly as before. When a
 * publish is armed or in flight, every pending publish is started at once and
 * the lock waits for them to settle — capped at `capMs` — so an edit made just
 * before the app hid still reaches the relay. The encryption key therefore
 * stays in memory up to the cap longer, and only when a publish is pending.
 *
 * Pure: no React. App passes `() => setEncryptionKey(null)` as `lock`.
 */

export const FLUSH_LOCK_CAP_MS = 5000;
/** Extra flush passes after the first. A pass that leaves something pending
 *  (a publish that collided with one in flight re-arms itself in its
 *  `finally`, after the flush took its snapshot) gets another go, but the
 *  count is what bounds the loop: a pass that settles without yielding to
 *  the event loop would otherwise spin on microtasks and starve the cap
 *  timer itself. */
export const MAX_EXTRA_FLUSH_PASSES = 2;

/** Cancels the LOCK, never the flush. */
export interface LockRequest {
  cancel(): void;
}

const NOOP_REQUEST: LockRequest = { cancel() {} };

export function createLockRequester(deps: {
  lock: () => void;
  hasPending: () => boolean;
  flush: () => Promise<void>;
  capMs?: number;
}): () => LockRequest {
  const capMs = deps.capMs ?? FLUSH_LOCK_CAP_MS;
  let inFlight: Promise<void> | null = null;

  function startFlush(): Promise<void> {
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    let capped = false;
    const cap = new Promise<void>(resolve => {
      capTimer = setTimeout(() => { capped = true; resolve(); }, capMs);
    });
    // Re-flush while anything is still pending (see MAX_EXTRA_FLUSH_PASSES):
    // a single pass would leave a `finally` re-arm for the lock cleanup to
    // cancel. Bounded by the pass count AND the cap.
    const flushed = (async () => {
      let extra = 0;
      do {
        await deps.flush().catch(() => {});
      } while (!capped && deps.hasPending() && extra++ < MAX_EXTRA_FLUSH_PASSES);
    })();
    const settled = Promise.race([flushed, cap]).then(() => {
      if (capTimer !== null) clearTimeout(capTimer);
      if (inFlight === settled) inFlight = null;
    });
    return settled;
  }

  return function requestLock(): LockRequest {
    if (!inFlight && !deps.hasPending()) {
      deps.lock();
      return NOOP_REQUEST;
    }
    if (!inFlight) inFlight = startFlush();
    let cancelled = false;
    void inFlight.then(() => {
      if (!cancelled) deps.lock();
    });
    return {
      cancel() {
        cancelled = true;
      },
    };
  };
}
