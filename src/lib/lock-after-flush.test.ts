import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLockRequester, FLUSH_LOCK_CAP_MS, MAX_EXTRA_FLUSH_PASSES } from './lock-after-flush';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => { resolve = res; });
  return { promise, resolve };
}

describe('createLockRequester', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('locks synchronously when nothing is pending', () => {
    const lock = vi.fn();
    const flush = vi.fn(async () => {});
    const requestLock = createLockRequester({ lock, hasPending: () => false, flush });
    requestLock();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(flush).not.toHaveBeenCalled();
  });

  it('waits for the flush before locking when a publish is pending', async () => {
    const lock = vi.fn();
    const d = deferred();
    const flush = vi.fn(() => d.promise);
    const requestLock = createLockRequester({ lock, hasPending: () => true, flush });
    requestLock();
    expect(flush).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(lock).not.toHaveBeenCalled();
    d.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('locks at the cap even if the flush never resolves', async () => {
    const lock = vi.fn();
    const flush = vi.fn(() => new Promise<void>(() => {}));
    const requestLock = createLockRequester({ lock, hasPending: () => true, flush });
    requestLock();
    await vi.advanceTimersByTimeAsync(FLUSH_LOCK_CAP_MS - 1);
    expect(lock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('honours a custom capMs', async () => {
    const lock = vi.fn();
    const requestLock = createLockRequester({
      lock, hasPending: () => true, flush: () => new Promise<void>(() => {}), capMs: 50,
    });
    requestLock();
    await vi.advanceTimersByTimeAsync(50);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('cancel() skips the lock but the flush is still awaited', async () => {
    const lock = vi.fn();
    const d = deferred();
    let flushSettled = false;
    const flush = vi.fn(() => d.promise.then(() => { flushSettled = true; }));
    const requestLock = createLockRequester({ lock, hasPending: () => true, flush });
    const handle = requestLock();
    handle.cancel();
    d.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(flushSettled).toBe(true);
    expect(lock).not.toHaveBeenCalled();
  });

  it('two requests during one flush share it and both lock', async () => {
    const lock = vi.fn();
    const d = deferred();
    const flush = vi.fn(() => d.promise);
    const requestLock = createLockRequester({ lock, hasPending: () => true, flush });
    requestLock();
    requestLock();
    expect(flush).toHaveBeenCalledTimes(1);
    d.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(lock).toHaveBeenCalledTimes(2);
  });

  it('a request while a flush is in flight shares it even if nothing is pending any more', async () => {
    const lock = vi.fn();
    const d = deferred();
    let pending = true;
    const flush = vi.fn(() => d.promise);
    const requestLock = createLockRequester({ lock, hasPending: () => pending, flush });
    requestLock();
    pending = false;
    requestLock();
    expect(lock).not.toHaveBeenCalled();
    d.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(lock).toHaveBeenCalledTimes(2);
  });

  it('after a flush settles with nothing pending, a request locks synchronously again', async () => {
    const lock = vi.fn();
    const d = deferred();
    let pending = true;
    const flush = vi.fn(() => { pending = false; return d.promise; });
    const requestLock = createLockRequester({ lock, hasPending: () => pending, flush });
    requestLock();
    d.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(lock).toHaveBeenCalledTimes(1);
    requestLock();
    expect(lock).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledTimes(1);
  });
  it('flushes again while something is still pending, then locks', async () => {
    const lock = vi.fn();
    let pendingRounds = 2; // each flush leaves one more re-armed publish behind, twice
    const flush = vi.fn(async () => { pendingRounds -= 1; });
    const requestLock = createLockRequester({ lock, hasPending: () => pendingRounds > 0, flush });
    requestLock();
    await vi.advanceTimersByTimeAsync(0);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the re-flush loop is bounded by the pass count even when a pass never yields', async () => {
    const lock = vi.fn();
    const flush = vi.fn(async () => {});
    const requestLock = createLockRequester({ lock, hasPending: () => true, flush });
    requestLock();
    await vi.advanceTimersByTimeAsync(0);
    expect(flush).toHaveBeenCalledTimes(1 + MAX_EXTRA_FLUSH_PASSES);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the re-flush loop is bounded by the cap', async () => {
    const lock = vi.fn();
    const flush = vi.fn(async () => { await new Promise<void>(r => setTimeout(r, 1000)); });
    const requestLock = createLockRequester({ lock, hasPending: () => true, flush, capMs: 1500 });
    requestLock();
    await vi.advanceTimersByTimeAsync(1500);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(2); // the second pass was in flight at the cap
    await vi.advanceTimersByTimeAsync(10_000);
    expect(flush).toHaveBeenCalledTimes(2); // ...and nothing re-flushed after it
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('a fast flush leaves no cap timer behind', async () => {
    const lock = vi.fn();
    let pending = true;
    const flush = vi.fn(async () => { pending = false; });
    const requestLock = createLockRequester({ lock, hasPending: () => pending, flush });
    requestLock();
    await vi.advanceTimersByTimeAsync(0);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
