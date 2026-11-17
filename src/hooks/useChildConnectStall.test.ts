// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChildConnectStall } from './useChildConnectStall';
import { CHILD_CONNECT_STALL_MS } from '../lib/child-bunker';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('useChildConnectStall', () => {
  it('false for the first minute down, true after it, false again the moment the connection comes up', () => {
    const { result, rerender } = renderHook((p: { down: boolean }) => useChildConnectStall(p.down), { initialProps: { down: true } });
    act(() => { vi.advanceTimersByTime(CHILD_CONNECT_STALL_MS - 1); });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(true);
    rerender({ down: false });
    expect(result.current).toBe(false);
    // Down again: a fresh minute.
    rerender({ down: true });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(CHILD_CONNECT_STALL_MS); });
    expect(result.current).toBe(true);
  });
});
