import { afterEach, expect, it, vi } from 'vitest';
import { createHandshakeHapticQueue, type HandshakeBeat } from './handshake-haptics';
afterEach(() => { vi.useRealTimers(); });
it('keeps scan, proof and save beats separate even when all three arrive together', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const beats: { beat: HandshakeBeat; at: number }[] = [];
  const queue = createHandshakeHapticQueue(beat => { beats.push({ beat, at: Date.now() }); });
  queue.push('tick'); queue.push('double'); queue.push('thud');
  await vi.advanceTimersByTimeAsync(0); expect(beats).toEqual([{ beat: 'tick', at: 0 }]);
  await vi.advanceTimersByTimeAsync(185); expect(beats.at(-1)).toEqual({ beat: 'double', at: 185 });
  await vi.advanceTimersByTimeAsync(420); expect(beats.at(-1)).toEqual({ beat: 'thud', at: 605 });
  queue.cancel();
});
it('cancels pending beats on leaving and ignores a stale native completion in a new session', async () => {
  vi.useFakeTimers();
  let finish: () => void = () => {};
  const play = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const queue = createHandshakeHapticQueue(play);
  queue.push('double'); queue.push('thud'); await vi.advanceTimersByTimeAsync(0);
  queue.cancel(); finish(); await vi.advanceTimersByTimeAsync(1000);
  expect(play).toHaveBeenCalledTimes(1);
  queue.push('tick'); await vi.advanceTimersByTimeAsync(0);
  expect(play).toHaveBeenLastCalledWith('tick'); queue.cancel(); finish();
});
