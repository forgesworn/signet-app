/**
 * Per-directory serial async queue for contacts v2 mutations (§8.2 review fix).
 *
 * `useContactsV2` reads `clockRef.current`, computes the next Lamport clock,
 * and only writes the bumped value back after an `await` (persisting the
 * operation). Two mutators fired without an intervening await — a
 * `Promise.all([addContact(a), addContact(b)])`, or two rapid taps before
 * React re-renders — both read the SAME clock before either write lands, so
 * both operations would be stamped with the same `logicalClock`.
 *
 * `createSerialQueue()` gives one hook instance a single in-flight chain:
 * every call to `run` executes strictly after the previous one has settled,
 * in call order, so only one task's synchronous "read clock, bump clock" can
 * ever be in flight at a time. A task that rejects does not block the next
 * queued task — only the internal chain link swallows the rejection to keep
 * the queue alive; the promise returned to the caller of `run` still carries
 * that task's own result or error.
 *
 * Pure in the sense that it holds no external state (no storage, no time, no
 * randomness) — its only state is its own internal promise chain.
 */

export interface SerialQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task, task);
      // Keep the chain alive regardless of whether this task rejected; the
      // rejection itself is still delivered to whoever awaits `result`.
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

/** Serialises contacts plans across UI, family and app-grant writers in this process. */
export const contactsMutationQueue = createSerialQueue();
