// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const grants = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../lib/db', () => ({ listContactGrantsV2: grants }));
vi.mock('../lib/sync-relays', () => ({ fetchNewestFromRelays: vi.fn() }));
vi.mock('../lib/contact-app-invites', () => ({ handleContactAppInvite: vi.fn() }));
import { APP_INVITE_BACKGROUND_POLL_MS, APP_INVITE_POLL_MS, useContactAppInvites } from './useContactAppInvites';
import { resetAppForegroundForTests } from '../lib/app-foreground';
let state: DocumentVisibilityState = 'visible';
beforeEach(() => {
  vi.useFakeTimers(); grants.mockClear(); state = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  resetAppForegroundForTests();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const setVisibility = (next: DocumentVisibilityState) => act(() => { state = next; document.dispatchEvent(new Event('visibilitychange')); });
it('polls every 30 s while on screen, not at all while hidden, and again on return', async () => {
  renderHook(() => useContactAppInvites({ encryptionKey: 'k'.repeat(64), enabled: true, identities: ['a'.repeat(64)], relays: [],
    service: vi.fn() as never }));
  await act(async () => { await Promise.resolve(); });
  expect(grants).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(APP_INVITE_POLL_MS - 1000); });
  expect(grants).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(grants).toHaveBeenCalledTimes(2);
  setVisibility('hidden');
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * APP_INVITE_POLL_MS); });
  expect(grants).toHaveBeenCalledTimes(2);
  setVisibility('visible');
  await act(async () => { await Promise.resolve(); });
  expect(grants).toHaveBeenCalledTimes(3);
});
it('keeps answering apps in the background every 60 s under always-on serving (review M1)', async () => {
  renderHook(() => useContactAppInvites({ encryptionKey: 'k'.repeat(64), enabled: true, identities: ['a'.repeat(64)], relays: [],
    service: vi.fn() as never, serveInBackground: true }));
  await act(async () => { await Promise.resolve(); });
  setVisibility('hidden');
  await act(async () => { await Promise.resolve(); });
  const before = grants.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(APP_INVITE_BACKGROUND_POLL_MS); });
  expect(grants.mock.calls.length).toBe(before + 1);
  // Well inside an app request's 300 s life.
  expect(APP_INVITE_BACKGROUND_POLL_MS).toBeLessThan(300_000 / 2);
});
