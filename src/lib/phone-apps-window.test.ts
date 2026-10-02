import { describe, it, expect, vi, afterEach } from 'vitest';
import { phoneAppsKeyExpired } from './phone-apps-window';

const MIN = 60_000;

describe('phoneAppsKeyExpired', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('holds the key inside the window, hidden or not', () => {
    expect(phoneAppsKeyExpired({ now: 4 * MIN, hiddenAt: 0, until: 5 * MIN, exempt: false })).toBe(false);
    expect(phoneAppsKeyExpired({ now: 4 * MIN, hiddenAt: null, until: 5 * MIN, exempt: false })).toBe(false);
  });

  it('drops it at the deadline, by the clock', () => {
    expect(phoneAppsKeyExpired({ now: 5 * MIN, hiddenAt: 0, until: 5 * MIN, exempt: false })).toBe(true);
    expect(phoneAppsKeyExpired({ now: 60 * MIN, hiddenAt: 0, until: 5 * MIN, exempt: false })).toBe(true);
  });

  it('a frozen timer changes nothing: a thaw after the deadline still finds it expired', () => {
    // The page is hidden with the window running and frozen at once: the
    // timer that used to end the window never fires.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const hiddenAt = Date.now();
    const until = Date.now() + 5 * MIN;
    const timerLock = vi.fn();
    setTimeout(timerLock, 5 * MIN); // never run: the page is frozen
    vi.setSystemTime(20 * MIN); // the wall clock moves on regardless
    expect(timerLock).not.toHaveBeenCalled();
    // Thawed by being brought to the front: the check is made before the
    // visible state clears `hiddenAt`.
    expect(phoneAppsKeyExpired({ now: Date.now(), hiddenAt, until, exempt: false })).toBe(true);
  });

  it('a request arriving after the deadline finds it expired, before anything is answered', () => {
    const served = 10 * MIN;
    const until = served + 5 * MIN;
    expect(phoneAppsKeyExpired({ now: until - 1, hiddenAt: served, until, exempt: false })).toBe(false);
    expect(phoneAppsKeyExpired({ now: until + 1, hiddenAt: served, until, exempt: false })).toBe(true);
  });

  it('once found expired, stays expired until the lock has happened, whatever cleared the window meanwhile', () => {
    // The thaw delivers `resume`, then the NIP-55 request, in one task: the
    // resume handler asks for the lock and forgets the deadline; the request
    // must still see the key as gone, not sign with it.
    expect(phoneAppsKeyExpired({ now: 20 * MIN, hiddenAt: 0, until: null, exempt: false, lockPending: true })).toBe(true);
    expect(phoneAppsKeyExpired({ now: 20 * MIN, hiddenAt: null, until: null, exempt: true, lockPending: true })).toBe(true);
  });

  it('a stay-awake window or always-on serving keeps the key on purpose', () => {
    expect(phoneAppsKeyExpired({ now: 60 * MIN, hiddenAt: 0, until: 5 * MIN, exempt: true })).toBe(false);
  });

  it('with no window, leaves the decision to the hide-lock', () => {
    expect(phoneAppsKeyExpired({ now: 60 * MIN, hiddenAt: 0, until: null, exempt: false })).toBe(false);
  });
});
