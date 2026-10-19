// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOwnerHoldCap } from './useOwnerHoldCap';
import { ownerOfferState, OWNER_HOLD_CAP_MS } from '../lib/heartwood-one-hold';

const CAP = 60_000;

describe('useOwnerHoldCap (A8, B1)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function mount(init: { raw: boolean; connected: boolean }) {
    return renderHook((p: { raw: boolean; connected: boolean }) => useOwnerHoldCap(p.raw, p.connected, CAP), { initialProps: init });
  }

  it('does not run the cap while the Heartwood is not connected', () => {
    const h = mount({ raw: true, connected: false });
    act(() => { vi.advanceTimersByTime(CAP * 3); });
    expect(h.result.current).toBe(true);
  });

  it('lapses once the cap has run from connect', () => {
    const h = mount({ raw: true, connected: false });
    act(() => { vi.advanceTimersByTime(CAP * 2); });
    h.rerender({ raw: true, connected: true });
    act(() => { vi.advanceTimersByTime(CAP - 1); });
    expect(h.result.current).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(h.result.current).toBe(false);
  });

  it('lock, wait past the cap, unlock: backups are still held until the status answers', () => {
    const h = mount({ raw: true, connected: true });
    // A lock: the unlocked gate turns the hold off, whatever the elapsed time.
    h.rerender({ raw: false, connected: false });
    expect(h.result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(CAP * 5); });
    // Unlock: the hold is on again, the Heartwood has not connected yet.
    h.rerender({ raw: true, connected: false });
    expect(h.result.current).toBe(true);
    act(() => { vi.advanceTimersByTime(CAP * 5); });
    expect(h.result.current).toBe(true);
    // Connected, status not answered yet: still held, for the cap from connect.
    h.rerender({ raw: true, connected: true });
    act(() => { vi.advanceTimersByTime(CAP - 1); });
    expect(h.result.current).toBe(true);
    // The status answers: the hold ends on its own.
    h.rerender({ raw: false, connected: true });
    expect(h.result.current).toBe(false);
  });

  it('a lapse is forgotten at the next lock, so the next unlock holds for a full cap again', () => {
    const h = mount({ raw: true, connected: true });
    act(() => { vi.advanceTimersByTime(CAP); });
    expect(h.result.current).toBe(false);
    h.rerender({ raw: false, connected: false });
    h.rerender({ raw: true, connected: true });
    expect(h.result.current).toBe(true);
  });
});

describe('ownerOfferState holds only while unlocked (B1)', () => {
  const base = {
    bunkerMode: true, routerSettled: false, supported: false, everHadFullAccess: true,
    statusOwner: null, awaitingFirstStatus: false, vaultNeedsApproval: false, dismissed: false,
  };
  it('a locked app (bunkerMode false) holds nothing', () => {
    expect(ownerOfferState(base).holdBackups).toBe(true);
    expect(ownerOfferState({ ...base, bunkerMode: false }).holdBackups).toBe(false);
  });
  it('the cap constant is the 60 s the tests assume', () => { expect(OWNER_HOLD_CAP_MS).toBe(CAP); });
});
