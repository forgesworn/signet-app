// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCamera } from './useCamera';

beforeEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', {
    writable: true,
    configurable: true,
    value: {
      getUserMedia: vi.fn(),
    },
  });
  vi.clearAllMocks();
});

describe('useCamera — initial state', () => {
  it('starts with hasPermission null and no error', () => {
    const { result } = renderHook(() => useCamera());
    expect(result.current.hasPermission).toBeNull();
    expect(result.current.error).toBeNull();
  });
});

describe('useCamera — requestPermission success', () => {
  it('sets hasPermission true, clears error, and stops all tracks', async () => {
    const mockStop = vi.fn();
    const mockStream = { getTracks: () => [{ stop: mockStop }] };
    (navigator.mediaDevices.getUserMedia as any).mockResolvedValue(mockStream);

    const { result } = renderHook(() => useCamera());

    await act(async () => {
      await result.current.requestPermission();
    });

    expect(result.current.hasPermission).toBe(true);
    expect(result.current.error).toBeNull();
    expect(mockStop).toHaveBeenCalled();
  });
});

describe('useCamera — requestPermission errors', () => {
  it('sets hasPermission false with denied message on NotAllowedError', async () => {
    (navigator.mediaDevices.getUserMedia as any).mockRejectedValue(
      Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
    );

    const { result } = renderHook(() => useCamera());

    await act(async () => {
      await result.current.requestPermission();
    });

    expect(result.current.hasPermission).toBe(false);
    expect(result.current.error).toContain('Camera permission denied');
  });

  it('sets hasPermission false with no-camera message on NotFoundError', async () => {
    (navigator.mediaDevices.getUserMedia as any).mockRejectedValue(
      Object.assign(new Error('no cam'), { name: 'NotFoundError' }),
    );

    const { result } = renderHook(() => useCamera());

    await act(async () => {
      await result.current.requestPermission();
    });

    expect(result.current.hasPermission).toBe(false);
    expect(result.current.error).toContain('No camera found');
  });

  it('sets hasPermission false with generic message on unknown error', async () => {
    (navigator.mediaDevices.getUserMedia as any).mockRejectedValue(new Error('generic'));

    const { result } = renderHook(() => useCamera());

    await act(async () => {
      await result.current.requestPermission();
    });

    expect(result.current.hasPermission).toBe(false);
    expect(result.current.error).toBe('Could not access camera.');
  });
});
