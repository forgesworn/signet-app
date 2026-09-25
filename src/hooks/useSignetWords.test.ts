// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../lib/signet', () => ({
  getSignetDisplay: vi.fn(),
}));

import { getSignetDisplay } from '../lib/signet';
import { useSignetWords } from './useSignetWords';

const mockGetDisplay = vi.mocked(getSignetDisplay);

const defaultDisplay = { words: ['alpha', 'bravo'], formatted: 'alpha bravo', expiresIn: 20 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockGetDisplay.mockReturnValue(defaultDisplay);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSignetWords — null sharedSecret', () => {
  it('returns empty display and does not call getSignetDisplay', async () => {
    const { result } = renderHook(() => useSignetWords(null));

    await act(async () => { await Promise.resolve(); });

    expect(result.current).toEqual({ words: [], formatted: '', expiresIn: 0 });
    expect(mockGetDisplay).not.toHaveBeenCalled();
  });
});

describe('useSignetWords — provided sharedSecret', () => {
  it('calls getSignetDisplay on mount and returns the result', async () => {
    const { result } = renderHook(() => useSignetWords('secret'));

    await act(async () => { await Promise.resolve(); });

    expect(mockGetDisplay).toHaveBeenCalledWith('secret');
    expect(result.current).toEqual(defaultDisplay);
  });

  it('calls getSignetDisplay on each 1-second interval', async () => {
    renderHook(() => useSignetWords('secret'));

    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });

    expect(mockGetDisplay).toHaveBeenCalledTimes(4);
  });

  it('clears the interval on unmount and stops calling getSignetDisplay', async () => {
    const { unmount } = renderHook(() => useSignetWords('secret'));

    await act(async () => { await Promise.resolve(); });

    const callsBeforeUnmount = mockGetDisplay.mock.calls.length;
    unmount();

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });

    expect(mockGetDisplay).toHaveBeenCalledTimes(callsBeforeUnmount);
  });
});
