// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../lib/signet-me', () => ({
  getSignetMeDisplay: vi.fn(),
}));
import { getSignetMeDisplay } from '../lib/signet-me';
import { useSignetMe } from './useSignetMe';

const mockGetDisplay = vi.mocked(getSignetMeDisplay);

const fakeDisplay = { myWords: ['alpha'], theirWords: ['bravo'], expiresIn: 25 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockGetDisplay.mockReturnValue(fakeDisplay);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSignetMe — null guards', () => {
  it('null sharedSecret — returns empty display without calling getSignetMeDisplay', async () => {
    const { result } = renderHook(() => useSignetMe(null, 'mypk', 'theirpk'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toEqual({ myWords: [], theirWords: [], expiresIn: 0 });
    expect(mockGetDisplay).not.toHaveBeenCalled();
  });

  it('null myPubkey — returns empty display without calling getSignetMeDisplay', async () => {
    const { result } = renderHook(() => useSignetMe('secret', null, 'theirpk'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toEqual({ myWords: [], theirWords: [], expiresIn: 0 });
    expect(mockGetDisplay).not.toHaveBeenCalled();
  });

  it('null theirPubkey — returns empty display without calling getSignetMeDisplay', async () => {
    const { result } = renderHook(() => useSignetMe('secret', 'mypk', null));
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toEqual({ myWords: [], theirWords: [], expiresIn: 0 });
    expect(mockGetDisplay).not.toHaveBeenCalled();
  });
});

describe('useSignetMe — normal operation', () => {
  it('all args provided — calls getSignetMeDisplay on mount with default wordCount', async () => {
    const { result } = renderHook(() => useSignetMe('secret', 'mypk', 'theirpk'));
    await act(async () => { await Promise.resolve(); });
    expect(mockGetDisplay).toHaveBeenCalledWith('secret', 'mypk', 'theirpk', 1);
    expect(result.current).toEqual(fakeDisplay);
  });

  it('custom wordCount — passes wordCount through to getSignetMeDisplay', async () => {
    renderHook(() => useSignetMe('secret', 'mypk', 'theirpk', 3));
    await act(async () => { await Promise.resolve(); });
    expect(mockGetDisplay).toHaveBeenCalledWith('secret', 'mypk', 'theirpk', 3);
  });

  it('updates on 1-second interval — calls getSignetMeDisplay at least 4 times after 3s', async () => {
    renderHook(() => useSignetMe('secret', 'mypk', 'theirpk'));
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    expect(mockGetDisplay.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});
