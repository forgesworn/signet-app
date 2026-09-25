// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSyncReadRetry } from './useSyncReadRetry';
afterEach(() => vi.useRealTimers());
it('retries offline reads on a timer and online events, then stops when reachable', async () => {
  vi.useFakeTimers();
  const { result, rerender, unmount } = renderHook(({ failed }) => useSyncReadRetry(failed), { initialProps: { failed: true } });
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(result.current).toBe(1);
  act(() => window.dispatchEvent(new Event('online')));
  expect(result.current).toBe(2);
  rerender({ failed: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(result.current).toBe(2);
  unmount();
});
