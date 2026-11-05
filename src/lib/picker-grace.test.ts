import { afterEach, describe, expect, it } from 'vitest';
import {
  PICKER_ARM_TTL_MS, armPickerGrace, clearPickerGrace, hideGetsGrace, pickerGraceOnHide,
} from './picker-grace';

describe('picker grace', () => {
  afterEach(() => clearPickerGrace());

  it('does nothing unless a picker armed it: hide still locks', () => {
    expect(hideGetsGrace(false, 1000)).toBe(false);
  });

  it('keeps the existing flows grace', () => {
    expect(hideGetsGrace(true, 1000)).toBe(true);
  });

  it('gives the hide that follows an arm the grace', () => {
    armPickerGrace(1000);
    expect(hideGetsGrace(false, 1500)).toBe(true);
  });

  it('holds for repeat checks during the same hide, until the page is visible', () => {
    armPickerGrace(1000);
    expect(hideGetsGrace(false, 1500)).toBe(true);
    // The lock effect re-runs while still hidden and decides again.
    expect(hideGetsGrace(false, 9000)).toBe(true);
    clearPickerGrace();
    expect(hideGetsGrace(false, 9500)).toBe(false);
  });

  it('is consumed once: a later hide after returning to visible locks', () => {
    armPickerGrace(1000);
    expect(pickerGraceOnHide(1200)).toBe(true);
    clearPickerGrace();
    expect(pickerGraceOnHide(2000)).toBe(false);
  });

  it('clearing on visible drops an arm no hide followed', () => {
    armPickerGrace(1000);
    clearPickerGrace();
    expect(hideGetsGrace(false, 1100)).toBe(false);
  });

  it('lapses when no hide follows soon after the arm', () => {
    armPickerGrace(1000);
    expect(hideGetsGrace(false, 1000 + PICKER_ARM_TTL_MS + 1)).toBe(false);
  });
});
