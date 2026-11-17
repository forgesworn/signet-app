// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChildHeartwoodHeartbeat, CHILD_HEARTBEAT_MS } from './useChildHeartwoodHeartbeat';

type Props = { enabled: boolean; ping: (() => Promise<unknown>) | null };

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
}

async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => { vi.useFakeTimers(); setVisibility('visible'); });
afterEach(() => { vi.useRealTimers(); });

describe('useChildHeartwoodHeartbeat', () => {
  it('pings at once on activation, then every interval', async () => {
    const ping = vi.fn().mockResolvedValue('pong');
    renderHook((p: Props) => useChildHeartwoodHeartbeat(p), { initialProps: { enabled: true, ping } });
    await tick(0);
    expect(ping).toHaveBeenCalledTimes(1);
    await tick(CHILD_HEARTBEAT_MS);
    expect(ping).toHaveBeenCalledTimes(2);
    await tick(CHILD_HEARTBEAT_MS);
    expect(ping).toHaveBeenCalledTimes(3);
  });

  it('one miss is not lost; two in a row are; a success clears it', async () => {
    let fail = true;
    const ping = vi.fn(() => (fail ? Promise.reject(new Error('timeout')) : Promise.resolve('pong')));
    const { result } = renderHook((p: Props) => useChildHeartwoodHeartbeat(p), { initialProps: { enabled: true, ping } });
    await tick(0);
    expect(result.current).toBe(false);
    await tick(CHILD_HEARTBEAT_MS);
    expect(result.current).toBe(true);
    fail = false;
    await tick(CHILD_HEARTBEAT_MS);
    expect(result.current).toBe(false);
  });

  it('a success between two misses resets the count', async () => {
    const answers = [false, true, false, true];
    const ping = vi.fn(() => (answers.shift() ? Promise.resolve('pong') : Promise.reject(new Error('x'))));
    const { result } = renderHook((p: Props) => useChildHeartwoodHeartbeat(p), { initialProps: { enabled: true, ping } });
    await tick(0);
    await tick(CHILD_HEARTBEAT_MS);
    await tick(CHILD_HEARTBEAT_MS);
    expect(result.current).toBe(false);
  });

  it('never has two pings in flight', async () => {
    const ping = vi.fn(() => new Promise<unknown>(() => { /* never settles */ }));
    renderHook((p: Props) => useChildHeartwoodHeartbeat(p), { initialProps: { enabled: true, ping } });
    await tick(0);
    await tick(CHILD_HEARTBEAT_MS * 3);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('does nothing and says false while disabled or without a ping', async () => {
    const ping = vi.fn().mockRejectedValue(new Error('x'));
    const off = renderHook((p: Props) => useChildHeartwoodHeartbeat(p), { initialProps: { enabled: false, ping } });
    const none = renderHook((p: Props) => useChildHeartwoodHeartbeat(p), { initialProps: { enabled: true, ping: null } });
    await tick(CHILD_HEARTBEAT_MS * 3);
    expect(ping).not.toHaveBeenCalled();
    expect(off.result.current).toBe(false);
    expect(none.result.current).toBe(false);
  });

  it('does not ping while hidden; going hidden resets lost; pinging resumes when visible', async () => {
    const ping = vi.fn().mockRejectedValue(new Error('x'));
    const { result } = renderHook((p: Props) => useChildHeartwoodHeartbeat(p), { initialProps: { enabled: true, ping } });
    await tick(0);
    await tick(CHILD_HEARTBEAT_MS);
    expect(result.current).toBe(true);
    setVisibility('hidden');
    expect(result.current).toBe(false);
    const calls = ping.mock.calls.length;
    await tick(CHILD_HEARTBEAT_MS * 3);
    expect(ping).toHaveBeenCalledTimes(calls);
    setVisibility('visible');
    await tick(0);
    expect(ping).toHaveBeenCalledTimes(calls + 1);
    // Misses start from zero again: one miss is not lost.
    expect(result.current).toBe(false);
  });

  it('ignores the answer to a ping sent before deactivation', async () => {
    const rejecters: Array<(e: unknown) => void> = [];
    const ping = vi.fn(() => new Promise<unknown>((_res, rej) => { rejecters.push(rej); }));
    const { result, rerender } = renderHook((p: Props) => useChildHeartwoodHeartbeat(p), { initialProps: { enabled: true, ping } });
    await tick(0);
    rerender({ enabled: false, ping });
    await act(async () => { rejecters[0](new Error('late')); await Promise.resolve(); });
    rerender({ enabled: true, ping });
    await tick(0);
    // The old miss did not carry over: this activation has one ping out and no misses.
    expect(result.current).toBe(false);
    expect(ping).toHaveBeenCalledTimes(2);
    // A second activation's own single miss is still not lost.
    await act(async () => { rejecters[1](new Error('x')); await Promise.resolve(); });
    expect(result.current).toBe(false);
  });

  it('a changed ping resets lost and starts afresh', async () => {
    const bad = vi.fn().mockRejectedValue(new Error('x'));
    const good = vi.fn().mockResolvedValue('pong');
    const { result, rerender } = renderHook((p: Props) => useChildHeartwoodHeartbeat(p), { initialProps: { enabled: true, ping: bad } });
    await tick(0);
    await tick(CHILD_HEARTBEAT_MS);
    expect(result.current).toBe(true);
    rerender({ enabled: true, ping: good });
    expect(result.current).toBe(false);
    await tick(0);
    expect(good).toHaveBeenCalledTimes(1);
  });
});
