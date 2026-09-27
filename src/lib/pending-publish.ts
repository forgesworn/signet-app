/**
 * Pending relay publishes, tracked so a lock can flush them first.
 *
 * Every sync rail delays its relay publish behind a timer (a debounce, and on
 * the jittered rails 5–90 s on top). Locking nulls the encryption key, which
 * re-runs each rail's arming effect and clears the unfired timer — so an edit
 * made shortly before the app hid was never published. Each rail arms its
 * timer through `schedulePublish` instead, and App's lock paths call
 * `flushPendingPublishes` (via `createLockRequester`) before nulling the key.
 *
 * Pure: no React. The timer is a real `setTimeout` so fake-timer tests keep
 * driving it.
 */

export interface PendingPublish {
  /** Fire now. Clears the timer if it has not fired. Idempotent: every call
   *  returns the SAME promise. Never rejects (run errors are swallowed —
   *  every hook already handles its own errors inside run). */
  start(): Promise<void>;
  /** Clear the timer if it has not fired and drop the registry entry.
   *  Does NOT abort a run already started (a started run stays registered
   *  until it settles). */
  cancel(): void;
  /** True once start() has been called (by the timer or by a flush). */
  readonly started: boolean;
}

const registry = new Set<PendingPublish>();

/** How long a STARTED run may stay registered. A publish that never settles
 *  (a NIP-46 signer that never answers, a relay socket that never opens)
 *  would otherwise hold `hasPendingPublishes()` true for the rest of the
 *  session and make every later lock wait the full flush cap. The run is
 *  not aborted — only forgotten by the registry. */
export const IN_FLIGHT_REGISTRY_CAP_MS = 90_000;

/** Arm a publish. Registers it in a module-level registry until the run
 *  settles or it is cancelled before firing. delayMs 0 is allowed. */
export function schedulePublish(run: () => Promise<void>, delayMs: number): PendingPublish {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let promise: Promise<void> | null = null;

  const entry: PendingPublish = {
    get started() {
      return promise !== null;
    },
    start() {
      if (promise) return promise;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const forget = setTimeout(() => registry.delete(entry), IN_FLIGHT_REGISTRY_CAP_MS);
      promise = (async () => {
        try {
          await run();
        } catch {
          // Swallowed: each hook handles its own errors inside run.
        } finally {
          clearTimeout(forget);
          registry.delete(entry);
        }
      })();
      return promise;
    },
    cancel() {
      if (promise) return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      registry.delete(entry);
    },
  };

  registry.add(entry);
  timer = setTimeout(() => {
    timer = null;
    void entry.start();
  }, delayMs);
  return entry;
}

/** True while any entry is registered (timer armed or run in flight). */
export function hasPendingPublishes(): boolean {
  return registry.size > 0;
}

/** start() every registered entry and wait for all of them to settle.
 *  Entries registered DURING the flush are not awaited. Resolves void. */
export async function flushPendingPublishes(): Promise<void> {
  const snapshot = [...registry];
  await Promise.all(snapshot.map(entry => entry.start()));
}

/** Test-only: cancel and drop every entry. */
export function resetPendingPublishesForTests(): void {
  for (const entry of [...registry]) entry.cancel();
  registry.clear();
}
