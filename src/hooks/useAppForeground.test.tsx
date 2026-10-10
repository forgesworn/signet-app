// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ listener: undefined as ((e: { state: 'background' | 'foreground' }) => void) | undefined, on: true }));
vi.mock('../lib/native', () => ({
  isNativeApp: () => native.on,
  SignetNative: { addListener: vi.fn(async (_name: string, fn: (e: { state: 'background' | 'foreground' }) => void) => { native.listener = fn; return { remove: vi.fn() }; }) },
}));
import { useAppForeground } from './useAppForeground';
let state: DocumentVisibilityState = 'visible';
beforeEach(() => { state = 'visible'; native.on = true; native.listener = undefined;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state }); });
afterEach(cleanup);
const visibility = (next: DocumentVisibilityState) => act(() => { state = next; document.dispatchEvent(new Event('visibilitychange')); });
it('on the APK, a page marked visible in the background (the always-on pulse) is not the app coming back', async () => {
  const hook = renderHook(() => useAppForeground());
  await act(async () => { await Promise.resolve(); });
  expect(hook.result.current).toBe(true);
  act(() => native.listener!({ state: 'background' }));
  visibility('hidden');
  expect(hook.result.current).toBe(false);
  visibility('visible'); // the pulse
  expect(hook.result.current).toBe(false);
  act(() => native.listener!({ state: 'foreground' }));
  expect(hook.result.current).toBe(true);
});
it('in a browser, it follows the page\'s visibility', () => {
  native.on = false;
  const hook = renderHook(() => useAppForeground());
  visibility('hidden'); expect(hook.result.current).toBe(false);
  visibility('visible'); expect(hook.result.current).toBe(true);
});
