// src/lib/carousel-arrows.test.ts
import { describe, it, expect } from 'vitest';
import { computeArrowState } from './carousel-arrows';

describe('computeArrowState', () => {
  it('disables up on the first row', () => {
    expect(computeArrowState(0, 4)).toEqual({ upDisabled: true, downDisabled: false });
  });
  it('disables down on the last row', () => {
    expect(computeArrowState(3, 4)).toEqual({ upDisabled: false, downDisabled: true });
  });
  it('enables both in the middle', () => {
    expect(computeArrowState(1, 4)).toEqual({ upDisabled: false, downDisabled: false });
  });
  it('disables both when there is a single row', () => {
    expect(computeArrowState(0, 1)).toEqual({ upDisabled: true, downDisabled: true });
  });
});
