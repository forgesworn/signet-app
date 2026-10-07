import { describe, expect, it } from 'vitest';
import {
  clampCropRect, cropDecodeWidth, cropRectWithSide, cropSourceRect, defaultCropRect, isValidPictureCrop,
  maxCropSide, minCropSide, panCropRect, sideFromSlider, sliderFromSide, toPictureCrop, zoomCropRect,
} from './picture-crop';

describe('crop limits', () => {
  it('the widest square is the short side; the tightest spans 64 source px (or less on a tiny image)', () => {
    expect(maxCropSide(4000, 3000)).toBe(3000);
    expect(maxCropSide(300, 800)).toBe(300);
    expect(minCropSide(4000, 3000)).toBe(64);
    expect(minCropSide(40, 90)).toBe(40);
  });

  it('defaults to the largest square, centred', () => {
    expect(defaultCropRect(4000, 3000)).toEqual({ x: 500, y: 0, side: 3000 });
    expect(defaultCropRect(300, 800)).toEqual({ x: 0, y: 250, side: 300 });
    expect(defaultCropRect(500, 500)).toEqual({ x: 0, y: 0, side: 500 });
  });
});

describe('clampCropRect', () => {
  it('never lets the square leave the image, so no edge is blank', () => {
    expect(clampCropRect(400, 300, { x: -50, y: -9, side: 100 })).toEqual({ x: 0, y: 0, side: 100 });
    expect(clampCropRect(400, 300, { x: 390, y: 290, side: 100 })).toEqual({ x: 300, y: 200, side: 100 });
  });

  it('keeps the side between the 64 px floor and the short side', () => {
    expect(clampCropRect(400, 300, { x: 0, y: 0, side: 10 }).side).toBe(64);
    expect(clampCropRect(400, 300, { x: 0, y: 0, side: 9999 })).toEqual({ x: 0, y: 0, side: 300 });
  });
});

describe('panCropRect', () => {
  it('moves the photo with the finger: dragging right shows more of the left of the photo', () => {
    // Frame 300 px showing a 150 px square: 2 px of screen = 1 source px.
    const out = panCropRect(1000, 1000, { x: 400, y: 400, side: 150 }, 20, -40, 300);
    expect(out).toEqual({ x: 390, y: 420, side: 150 });
  });

  it('stops at the image edge', () => {
    const out = panCropRect(1000, 1000, { x: 5, y: 840, side: 150 }, 500, -500, 300);
    expect(out).toEqual({ x: 0, y: 850, side: 150 });
  });
});

describe('zoomCropRect / cropRectWithSide', () => {
  it('zooms about the anchor, keeping the point under it fixed', () => {
    const start = { x: 100, y: 200, side: 400 };
    const out = zoomCropRect(2000, 2000, start, 2, { x: 0.25, y: 0.75 });
    expect(out.side).toBe(200);
    // The source point under (0.25, 0.75) before: (200, 500). After: x + 0.25*200, y + 0.75*200.
    expect(out.x + 0.25 * out.side).toBeCloseTo(200);
    expect(out.y + 0.75 * out.side).toBeCloseTo(500);
  });

  it('cannot zoom out past cover or in past 64 source px', () => {
    const rect = { x: 0, y: 0, side: 300 };
    expect(zoomCropRect(400, 300, rect, 0.1).side).toBe(300);
    expect(zoomCropRect(400, 300, rect, 1000).side).toBe(64);
  });

  it('ignores a non-positive or non-finite factor', () => {
    const rect = { x: 10, y: 10, side: 100 };
    expect(zoomCropRect(400, 300, rect, 0)).toBe(rect);
    expect(zoomCropRect(400, 300, rect, NaN)).toBe(rect);
  });

  it('a zoom-out re-clamps a square that would otherwise hang off the edge', () => {
    const out = cropRectWithSide(400, 300, { x: 300, y: 200, side: 100 }, 300, { x: 0.5, y: 0.5 });
    expect(out).toEqual({ x: 100, y: 0, side: 300 });
  });
});

describe('slider mapping', () => {
  it('0 is cover, 1 is the tightest, and the two functions are inverse', () => {
    expect(sideFromSlider(4000, 3000, 0)).toBeCloseTo(3000);
    expect(sideFromSlider(4000, 3000, 1)).toBeCloseTo(64);
    for (const t of [0, 0.2, 0.5, 0.9, 1]) {
      expect(sliderFromSide(4000, 3000, sideFromSlider(4000, 3000, t))).toBeCloseTo(t);
    }
  });

  it('a tiny image does not invert the range', () => {
    expect(sideFromSlider(40, 90, 1)).toBe(40);
    expect(sliderFromSide(40, 90, 40)).toBe(0);
  });
});

describe('toPictureCrop / cropSourceRect', () => {
  it('x of width, y of height, side of width', () => {
    expect(toPictureCrop(4000, 3000, { x: 1000, y: 750, side: 1500 })).toEqual({ x: 0.25, y: 0.25, side: 0.375 });
  });

  it('maps fractions onto a bitmap decoded at another size', () => {
    expect(cropSourceRect(1000, 750, { x: 0.25, y: 0.25, side: 0.375 })).toEqual({ sx: 250, sy: 187.5, s: 375 });
  });

  it('clamps float drift inside the bitmap', () => {
    const r = cropSourceRect(1000, 750, { x: 0.5, y: 0.5, side: 0.5000001 });
    expect(r.sx + r.s).toBeLessThanOrEqual(1000);
    expect(r.sy + r.s).toBeLessThanOrEqual(750);
  });
});

describe('isValidPictureCrop', () => {
  it('accepts a crop inside the image and rejects the rest', () => {
    expect(isValidPictureCrop({ x: 0, y: 0, side: 1 })).toBe(true);
    expect(isValidPictureCrop({ x: 0.5, y: 0.1, side: 0.5 })).toBe(true);
    expect(isValidPictureCrop({ x: 0.6, y: 0, side: 0.5 })).toBe(false);
    expect(isValidPictureCrop({ x: -0.1, y: 0, side: 0.5 })).toBe(false);
    expect(isValidPictureCrop({ x: 0, y: 0, side: 0 })).toBe(false);
    expect(isValidPictureCrop({ x: NaN, y: 0, side: 0.5 })).toBe(false);
    expect(isValidPictureCrop(null)).toBe(false);
    expect(isValidPictureCrop({ x: '0', y: 0, side: 0.5 })).toBe(false);
  });
});

describe('cropDecodeWidth', () => {
  it('is the width at which the crop square is 256 px', () => {
    expect(cropDecodeWidth({ x: 0, y: 0, side: 0.25 }, 4000, 3000)).toBe(1024);
  });

  it('is never wider than the shorter header side, so neither orientation over-decodes', () => {
    expect(cropDecodeWidth({ x: 0, y: 0, side: 0.01 }, 4000, 3000)).toBe(3000);
    expect(cropDecodeWidth({ x: 0, y: 0, side: 0.01 }, 3000, 4000)).toBe(3000);
    expect(cropDecodeWidth({ x: 0, y: 0, side: 1 }, 200, 300)).toBe(200);
  });
});
