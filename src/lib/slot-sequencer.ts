/**
 * Per-slot ordering for picture changes that upload first and save after (a card
 * backdrop sent to a child's phone, a persona avatar). Each slot gets a
 * "newest change" counter and a save queue:
 *
 * - `bump(slotKey)` at the START of a change, before anything is awaited, so a
 *   change started later outranks it whatever order the uploads land in;
 * - `serial(slotKey, task)` around the save, so saves on one slot never overlap;
 * - inside the task, `current(slotKey) !== generation` means a newer change
 *   (or a remove) started meanwhile: discard what this one uploaded.
 *
 * Module-level instances, one per kind of picture, because the closures that
 * start a change are rebuilt on every render while an upload is still in flight.
 * Never share an instance between kinds: an avatar set must not supersede a
 * backdrop send on the same slot.
 */
export interface SlotSequencer {
  bump(slotKey: string): number;
  current(slotKey: string): number;
  serial<T>(slotKey: string, task: () => Promise<T>): Promise<T>;
}

export function createSlotSequencer(): SlotSequencer {
  const generations = new Map<string, number>();
  const queues = new Map<string, Promise<unknown>>();
  return {
    bump(slotKey) {
      const next = (generations.get(slotKey) ?? 0) + 1;
      generations.set(slotKey, next);
      return next;
    },
    current(slotKey) {
      return generations.get(slotKey) ?? 0;
    },
    /** Run `task` after every earlier task on this slot has settled. */
    serial(slotKey, task) {
      const run = (queues.get(slotKey) ?? Promise.resolve()).then(task, task);
      const tail = run.catch(() => undefined);
      queues.set(slotKey, tail);
      void tail.then(() => { if (queues.get(slotKey) === tail) queues.delete(slotKey); });
      return run;
    },
  };
}
