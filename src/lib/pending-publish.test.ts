import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  schedulePublish,
  hasPendingPublishes,
  flushPendingPublishes,
  resetPendingPublishesForTests,
  IN_FLIGHT_REGISTRY_CAP_MS,
} from './pending-publish';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('pending-publish', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    resetPendingPublishesForTests();
    vi.useRealTimers();
  });

  it('fires the run once after the delay', async () => {
    const run = vi.fn(async () => {});
    const p = schedulePublish(run, 1000);
    expect(p.started).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(p.started).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('start() before the timer runs once and the timer then does nothing', async () => {
    const run = vi.fn(async () => {});
    const p = schedulePublish(run, 1000);
    await p.start();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('start() twice returns the same promise and runs once', async () => {
    const run = vi.fn(async () => {});
    const p = schedulePublish(run, 1000);
    const a = p.start();
    const b = p.start();
    expect(a).toBe(b);
    await a;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('cancel() before fire never runs and empties the registry', async () => {
    const run = vi.fn(async () => {});
    const p = schedulePublish(run, 1000);
    expect(hasPendingPublishes()).toBe(true);
    p.cancel();
    expect(hasPendingPublishes()).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).not.toHaveBeenCalled();
    await flushPendingPublishes();
    expect(run).not.toHaveBeenCalled();
  });

  it('cancel() after start() does not abort the run; entry stays until it settles', async () => {
    const d = deferred();
    let finished = false;
    const p = schedulePublish(async () => { await d.promise; finished = true; }, 1000);
    const started = p.start();
    p.cancel();
    expect(hasPendingPublishes()).toBe(true);
    d.resolve();
    await started;
    expect(finished).toBe(true);
    expect(hasPendingPublishes()).toBe(false);
  });

  it('hasPendingPublishes() is true while a run is in flight and false after it settles', async () => {
    const d = deferred();
    schedulePublish(() => d.promise, 0);
    expect(hasPendingPublishes()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(hasPendingPublishes()).toBe(true);
    d.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(hasPendingPublishes()).toBe(false);
  });

  it('flush awaits a run that is already in flight', async () => {
    const d = deferred();
    let finished = false;
    schedulePublish(async () => { await d.promise; finished = true; }, 10);
    await vi.advanceTimersByTimeAsync(10);
    let flushed = false;
    const f = flushPendingPublishes().then(() => { flushed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(flushed).toBe(false);
    d.resolve();
    await f;
    expect(finished).toBe(true);
  });

  it('flush starts an armed timer immediately', async () => {
    const run = vi.fn(async () => {});
    schedulePublish(run, 90_000);
    await flushPendingPublishes();
    expect(run).toHaveBeenCalledTimes(1);
    expect(hasPendingPublishes()).toBe(false);
  });

  it('a rejecting run does not reject start() or flush', async () => {
    const p = schedulePublish(async () => { throw new Error('boom'); }, 1000);
    await expect(p.start()).resolves.toBeUndefined();
    schedulePublish(async () => { throw new Error('boom2'); }, 1000);
    await expect(flushPendingPublishes()).resolves.toBeUndefined();
    expect(hasPendingPublishes()).toBe(false);
  });

  it('flush with an empty registry resolves', async () => {
    await expect(flushPendingPublishes()).resolves.toBeUndefined();
  });

  it('an entry scheduled during a flush is not awaited by that flush', async () => {
    const lateRun = deferred();
    let late: ReturnType<typeof schedulePublish> | null = null;
    schedulePublish(async () => {
      late = schedulePublish(() => lateRun.promise, 0);
      late.start();
    }, 1000);
    await flushPendingPublishes();
    expect(late).not.toBeNull();
    expect(hasPendingPublishes()).toBe(true);
    lateRun.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(hasPendingPublishes()).toBe(false);
  });
  it('a started run that never settles is forgotten by the registry after the in-flight cap', async () => {
    const p = schedulePublish(() => new Promise<void>(() => {}), 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(p.started).toBe(true);
    expect(hasPendingPublishes()).toBe(true);
    await vi.advanceTimersByTimeAsync(IN_FLIGHT_REGISTRY_CAP_MS - 1);
    expect(hasPendingPublishes()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(hasPendingPublishes()).toBe(false);
  });

  it('a run that settles clears its in-flight cap timer', async () => {
    const d = deferred();
    schedulePublish(() => d.promise, 0);
    await vi.advanceTimersByTimeAsync(0);
    d.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(hasPendingPublishes()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
