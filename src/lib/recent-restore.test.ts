// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  markRecentRestore,
  hasRecentRestore,
  clearRecentRestore,
  RECENT_RESTORE_WINDOW_MS,
} from './recent-restore';

beforeEach(() => {
  localStorage.clear();
});

describe('recent-restore marker', () => {
  it('returns false when no marker has been set', () => {
    expect(hasRecentRestore()).toBe(false);
  });

  it('returns true immediately after markRecentRestore', () => {
    markRecentRestore();
    expect(hasRecentRestore()).toBe(true);
  });

  it('returns true inside the 7-day window', () => {
    markRecentRestore();
    const fiveDaysLater = Date.now() + 5 * 24 * 60 * 60 * 1000;
    expect(hasRecentRestore(fiveDaysLater)).toBe(true);
  });

  it('returns false after the 7-day window expires', () => {
    markRecentRestore();
    const tooLate = Date.now() + RECENT_RESTORE_WINDOW_MS + 1;
    expect(hasRecentRestore(tooLate)).toBe(false);
  });

  it('returns false after clearRecentRestore', () => {
    markRecentRestore();
    clearRecentRestore();
    expect(hasRecentRestore()).toBe(false);
  });

  it('returns false for a malformed marker value', () => {
    localStorage.setItem('signet:recent-restore', 'not-a-number');
    expect(hasRecentRestore()).toBe(false);
  });

  it('returns false for a zero / negative timestamp', () => {
    localStorage.setItem('signet:recent-restore', '0');
    expect(hasRecentRestore()).toBe(false);
  });

  it('survives a storage exception (private mode / disabled)', () => {
    const orig = localStorage.setItem;
    localStorage.setItem = vi.fn(() => { throw new Error('denied'); });
    // Must not throw
    expect(() => markRecentRestore()).not.toThrow();
    localStorage.setItem = orig;
  });
});
