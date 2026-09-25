import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeAge, formatDateOfBirth } from './date-utils';

describe('computeAge', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('computes age for an adult', () => {
    vi.useFakeTimers({ now: new Date('2026-04-16') });
    expect(computeAge('1990-06-15')).toBe(35);
  });

  it('subtracts a year if birthday has not occurred yet this year', () => {
    vi.useFakeTimers({ now: new Date('2026-04-16') });
    expect(computeAge('1990-12-25')).toBe(35);
  });

  it('gives exact age on birthday', () => {
    vi.useFakeTimers({ now: new Date('2026-06-15') });
    expect(computeAge('1990-06-15')).toBe(36);
  });

  it('handles children', () => {
    vi.useFakeTimers({ now: new Date('2026-04-16') });
    expect(computeAge('2015-01-01')).toBe(11);
  });
});

describe('formatDateOfBirth', () => {
  it('formats ISO date as DD Month YYYY', () => {
    expect(formatDateOfBirth('1990-06-15')).toBe('15 June 1990');
  });

  it('handles single-digit days', () => {
    expect(formatDateOfBirth('2000-01-05')).toBe('5 January 2000');
  });
});
