// src/lib/stay-awake.test.ts
import { describe, it, expect } from 'vitest';
import {
  STAY_AWAKE_OPTIONS_MINUTES,
  stayAwakeUntil,
  isStayAwakeActive,
  stayAwakeRemainingMs,
  formatCountdown,
} from './stay-awake';

describe('stay-awake options', () => {
  it('offers 2/5/10 minutes', () => {
    expect([...STAY_AWAKE_OPTIONS_MINUTES]).toEqual([2, 5, 10]);
  });
});

describe('stayAwakeUntil', () => {
  it('adds the chosen minutes (in ms) to now', () => {
    expect(stayAwakeUntil(1_000_000, 15)).toBe(1_000_000 + 15 * 60_000);
    expect(stayAwakeUntil(0, 5)).toBe(5 * 60_000);
  });
});

describe('isStayAwakeActive', () => {
  it('is false when null', () => {
    expect(isStayAwakeActive(null, 1000)).toBe(false);
  });
  it('is true strictly before expiry, false at/after', () => {
    expect(isStayAwakeActive(2000, 1999)).toBe(true);
    expect(isStayAwakeActive(2000, 2000)).toBe(false);
    expect(isStayAwakeActive(2000, 2001)).toBe(false);
  });
});

describe('stayAwakeRemainingMs', () => {
  it('returns 0 for null and clamps at/after expiry', () => {
    expect(stayAwakeRemainingMs(null, 1000)).toBe(0);
    expect(stayAwakeRemainingMs(5000, 6000)).toBe(0);
    expect(stayAwakeRemainingMs(5000, 4000)).toBe(1000);
  });
});

describe('formatCountdown', () => {
  it('formats m:ss, rounding up to the next whole second', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(1)).toBe('0:01');
    expect(formatCountdown(59_000)).toBe('0:59');
    expect(formatCountdown(60_000)).toBe('1:00');
    expect(formatCountdown(90_500)).toBe('1:31');
    expect(formatCountdown(15 * 60_000)).toBe('15:00');
  });
});
