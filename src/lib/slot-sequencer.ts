/**
 * Per-slot ordering for picture changes that upload first and save after (a card
 * backdrop sent to a child's phone, a persona avatar). Each slot gets a
 * "newest change" counter, a record of how each change since the oldest one
 * still running has gone, and a save queue:
 *
 * - `bump(slotKey)` at the START of a send, before anything is awaited, so a
 *   change started later outranks it whatever order the uploads land in;
 *   `bump(slotKey, 'clear')` for a clear, a remove or an unpair, which outranks
 *   every older send outright;
 * - `settle(slotKey, generation, 'uploaded' | 'failed')` once a send's upload has
 *   landed or failed, and `finish` once it has saved or given up;
 * - `serial(slotKey, task)` around the save, so saves on one slot never overlap;
 * - `whenNewerSettled` before the save and `superseded` inside it: an older send
 *   is discarded when ANY newer change on the slot is a clear, has uploaded, has
 *   saved, or is still uploading. Only when every newer send failed before
 *   saving (upload error, refused, consent off) may the older one still save.
 *   An older send ready to save while a newer one is still uploading waits for
 *   that upload to settle rather than deciding early, at most `waitMs`.
 *
 * `current(slotKey)` stays "the latest change started" (the backfill's yield
 * rule reads it).
 *
 * Module-level instances, one per kind of picture, because the closures that
 * start a change are rebuilt on every render while an upload is still in flight.
 * Never share an instance between kinds: an avatar set must not supersede a
 * backdrop send on the same slot.
 */
export type ChangeState = 'uploading' | 'uploaded' | 'saved' | 'failed' | 'clear';

export interface SlotSequencer {
  bump(slotKey: string, kind?: 'send' | 'clear'): number;
  current(slotKey: string): number;
  /** A send's upload landed (`uploaded`) or failed (`failed`). */
  settle(slotKey: string, generation: number, state: 'uploaded' | 'failed'): void;
  /** A send is done: it saved, or it ended without saving. Always call it, once. */
  finish(slotKey: string, generation: number, saved: boolean): void;
  /** True when a newer change outranks this one (see the module note). */
  superseded(slotKey: string, generation: number): boolean;
  /** True while a change newer than `generation` is still uploading. */
  newerUploading(slotKey: string, generation: number): boolean;
  /** Resolves once no change newer than `generation` is still uploading, or at `deadline` (ms epoch). */
  whenNewerSettled(slotKey: string, generation: number, deadline: number): Promise<void>;
  serial<T>(slotKey: string, task: () => Promise<T>): Promise<T>;
}

/** How long an older send waits, in all, for newer uploads to settle before it counts as outranked. */
export const NEWER_SEND_WAIT_MS = 120_000;

interface Change { state: ChangeState; active: boolean }

export function createSlotSequencer(): SlotSequencer {
  const generations = new Map<string, number>();
  // Per slot, every change from the oldest one still active onwards, in
  // generation order (a Map keeps insertion order and generations only grow).
  const changes = new Map<string, Map<number, Change>>();
  const waiters = new Map<string, Set<() => void>>();
  const queues = new Map<string, Promise<unknown>>();

  const notify = (slotKey: string) => {
    const set = waiters.get(slotKey);
    if (!set) return;
    waiters.delete(slotKey);
    for (const w of set) w();
  };
  // A change no older change can still look at is dropped: only the oldest
  // active one and everything after it are kept.
  const prune = (slotKey: string) => {
    const m = changes.get(slotKey);
    if (!m) return;
    for (const [g, c] of m) {
      if (c.active) break;
      m.delete(g);
    }
    if (m.size === 0) changes.delete(slotKey);
  };
  const newer = (slotKey: string, generation: number): Change[] => {
    const m = changes.get(slotKey);
    if (!m) return [];
    const out: Change[] = [];
    for (const [g, c] of m) if (g > generation) out.push(c);
    return out;
  };
  const newerUploading = (slotKey: string, generation: number) => newer(slotKey, generation).some(c => c.state === 'uploading');
  const update = (slotKey: string, generation: number, fn: (c: Change) => void) => {
    const c = changes.get(slotKey)?.get(generation);
    if (!c) return;
    fn(c);
    prune(slotKey);
    notify(slotKey);
  };

  return {
    bump(slotKey, kind = 'send') {
      const next = (generations.get(slotKey) ?? 0) + 1;
      generations.set(slotKey, next);
      let m = changes.get(slotKey);
      if (!m) { m = new Map(); changes.set(slotKey, m); }
      m.set(next, kind === 'clear' ? { state: 'clear', active: false } : { state: 'uploading', active: true });
      prune(slotKey);
      notify(slotKey);
      return next;
    },
    current(slotKey) {
      return generations.get(slotKey) ?? 0;
    },
    settle(slotKey, generation, state) {
      update(slotKey, generation, c => { if (c.state === 'uploading') c.state = state; });
    },
    finish(slotKey, generation, saved) {
      update(slotKey, generation, c => {
        c.state = saved ? 'saved' : 'failed';
        c.active = false;
      });
    },
    superseded(slotKey, generation) {
      return newer(slotKey, generation).some(c => c.state !== 'failed');
    },
    newerUploading,
    async whenNewerSettled(slotKey, generation, deadline) {
      while (newerUploading(slotKey, generation)) {
        const left = deadline - Date.now();
        if (left <= 0) return;
        await new Promise<void>(resolve => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const done = () => { if (timer !== undefined) clearTimeout(timer); resolve(); };
          let set = waiters.get(slotKey);
          if (!set) { set = new Set(); waiters.set(slotKey, set); }
          set.add(done);
          timer = setTimeout(() => { waiters.get(slotKey)?.delete(done); resolve(); }, left);
        });
      }
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

/**
 * The save step of a send, under the rules above: wait (outside the save queue,
 * so a newer send can still upload and queue) until no newer upload is in
 * flight, then take the queue and decide. If a newer send started while this
 * one waited for the queue, leave it and wait again. Past the deadline a newer
 * upload still in flight outranks this one. `save` runs inside the queue with
 * the slot's own checks; `discard` when outranked.
 */
export async function saveUnlessSuperseded<T>(
  seq: SlotSequencer,
  slotKey: string,
  generation: number,
  steps: { save: () => Promise<T>; superseded: () => T },
  waitMs: number = NEWER_SEND_WAIT_MS,
): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    await seq.whenNewerSettled(slotKey, generation, deadline);
    const out = await seq.serial(slotKey, async (): Promise<{ again: true } | { again: false; value: T }> => {
      if (seq.newerUploading(slotKey, generation) && Date.now() < deadline) return { again: true };
      if (seq.superseded(slotKey, generation)) return { again: false, value: steps.superseded() };
      return { again: false, value: await steps.save() };
    });
    if (!out.again) return out.value;
  }
}
