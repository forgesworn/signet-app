import { describe, it, expect, vi } from 'vitest';
import { createSerialQueue } from './contacts-v2-queue';

describe('createSerialQueue', () => {
  it('runs queued tasks strictly in call order, not completion order', async () => {
    const queue = createSerialQueue();
    const order: string[] = [];

    const slow = queue.run(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      order.push('slow');
      return 'slow';
    });
    const fast = queue.run(async () => {
      order.push('fast');
      return 'fast';
    });

    await Promise.all([slow, fast]);
    expect(order).toEqual(['slow', 'fast']);
  });

  it('delivers each task its own result to the caller of run', async () => {
    const queue = createSerialQueue();
    const [a, b] = await Promise.all([
      queue.run(async () => 1),
      queue.run(async () => 2),
    ]);
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it('does not let a rejected task block the next queued task', async () => {
    const queue = createSerialQueue();
    const first = queue.run(async () => {
      throw new Error('boom');
    });
    const second = queue.run(async () => 'still runs');

    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('still runs');
  });

  it('never produces an unhandled rejection warning from the internal chain', async () => {
    const onUnhandled = vi.fn();
    process.once('unhandledRejection', onUnhandled);

    const queue = createSerialQueue();
    const rejected = queue.run(async () => {
      throw new Error('boom');
    });
    // Give the internal chain a turn to settle before asserting nothing leaked.
    await rejected.catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(onUnhandled).not.toHaveBeenCalled();
    process.removeListener('unhandledRejection', onUnhandled);
  });
});
