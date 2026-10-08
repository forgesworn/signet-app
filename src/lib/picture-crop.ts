/**
 * Pure geometry for the "your own picture" crop screen, and for applying its
 * result in the thumbnail pipeline.
 *
 * Two shapes, both over the ORIENTED image (EXIF rotation already applied):
 * - `CropRect`: the crop square in source pixels — the working state of the
 *   crop screen (`x`/`y` is the square's top-left, `side` its edge).
 * - `PictureCrop`: the same square as fractions, which is what crosses into
 *   `makeThumbnail` and its worker. `x` is a fraction of the image WIDTH, `y`
 *   of its HEIGHT, and `side` of its WIDTH (a square has no single "fraction
 *   of both"; width matches how `resizeWidth` scales the decode). Fractions
 *   survive the decode being at a different size from the preview.
 *
 * Rules (spec 2026-10-07 §2): the photo always covers the square (the widest
 * square is the minimum zoom, and the square is clamped inside the image so no
 * edge is ever blank); the tightest square spans no fewer than 64 source
 * pixels; the default is the largest square, centred.
 */

import { THUMBNAIL_MAX_SIDE_PX } from './image-header';

/** The crop square, in pixels of the oriented source image. */
export interface CropRect {
  x: number;
  y: number;
  side: number;
}

/** The crop square as fractions of the oriented image: x of width, y of height, side of width. */
export interface PictureCrop {
  x: number;
  y: number;
  side: number;
}

/** The tightest crop spans this many source pixels (or the whole short side, for a tinier image). */
export const CROP_MIN_SOURCE_SPAN_PX = 64;
/** The saved picture's edge. */
export const CROP_OUTPUT_PX = THUMBNAIL_MAX_SIDE_PX;

/** The widest square: the image's short side (minimum zoom, "cover"). */
export function maxCropSide(width: number, height: number): number {
  return Math.min(width, height);
}

/** The tightest square: 64 px, or the short side where the image is smaller than that. */
export function minCropSide(width: number, height: number): number {
  return Math.min(CROP_MIN_SOURCE_SPAN_PX, maxCropSide(width, height));
}

/** The largest square that fits, centred. */
export function defaultCropRect(width: number, height: number): CropRect {
  const side = maxCropSide(width, height);
  return { x: (width - side) / 2, y: (height - side) / 2, side };
}

/** Pull `rect` into the allowed side range and inside the image, so no edge of the square is ever blank. */
export function clampCropRect(width: number, height: number, rect: CropRect): CropRect {
  const side = Math.min(maxCropSide(width, height), Math.max(minCropSide(width, height), rect.side));
  return {
    side,
    x: Math.min(width - side, Math.max(0, rect.x)),
    y: Math.min(height - side, Math.max(0, rect.y)),
  };
}

/** Drag the photo by (dx, dy) SCREEN pixels in a frame `frameSide` px wide; the photo follows the finger. */
export function panCropRect(width: number, height: number, rect: CropRect, dx: number, dy: number, frameSide: number): CropRect {
  const perPx = rect.side / frameSide;
  return clampCropRect(width, height, { ...rect, x: rect.x - dx * perPx, y: rect.y - dy * perPx });
}

/**
 * Resize the square to `side`, keeping the source point under the anchor fixed.
 * `anchor` is where the zoom is centred, as fractions (0..1) of the frame —
 * the pinch midpoint or the cursor; (0.5, 0.5) for the slider.
 */
export function cropRectWithSide(
  width: number, height: number, rect: CropRect, side: number, anchor: { x: number; y: number } = { x: 0.5, y: 0.5 },
): CropRect {
  const target = Math.min(maxCropSide(width, height), Math.max(minCropSide(width, height), side));
  const px = rect.x + anchor.x * rect.side;
  const py = rect.y + anchor.y * rect.side;
  return clampCropRect(width, height, { side: target, x: px - anchor.x * target, y: py - anchor.y * target });
}

/** Zoom by `factor` (>1 zooms in) about `anchor`. */
export function zoomCropRect(
  width: number, height: number, rect: CropRect, factor: number, anchor?: { x: number; y: number },
): CropRect {
  if (!(factor > 0) || !Number.isFinite(factor)) return rect;
  return cropRectWithSide(width, height, rect, rect.side / factor, anchor);
}

/** Slider position 0..1 (0 = cover, 1 = tightest) for a square side; log scale, so each step feels even. */
export function sliderFromSide(width: number, height: number, side: number): number {
  const max = maxCropSide(width, height);
  const min = minCropSide(width, height);
  if (max <= min) return 0;
  const t = Math.log(max / Math.min(max, Math.max(min, side))) / Math.log(max / min);
  return Math.min(1, Math.max(0, t));
}

/** The inverse of `sliderFromSide`. */
export function sideFromSlider(width: number, height: number, t: number): number {
  const max = maxCropSide(width, height);
  const min = minCropSide(width, height);
  if (max <= min) return max;
  const clamped = Math.min(1, Math.max(0, t));
  return max * Math.pow(min / max, clamped);
}

/** The square as fractions of the oriented image — what `makeThumbnail` takes. */
export function toPictureCrop(width: number, height: number, rect: CropRect): PictureCrop {
  return { x: rect.x / width, y: rect.y / height, side: rect.side / width };
}

/** True for a crop that lies inside the image: finite, side > 0, and square within both extents. */
export function isValidPictureCrop(crop: unknown): crop is PictureCrop {
  if (!crop || typeof crop !== 'object') return false;
  const { x, y, side } = crop as Record<string, unknown>;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof side !== 'number') return false;
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(side)
    && x >= 0 && y >= 0 && side > 0 && x + side <= 1 + 1e-6;
}

/**
 * The square to cut from a decoded bitmap, in its own pixels. A decode at a
 * rounded size can drift a fraction of a pixel, so the square is clamped to
 * stay inside the bitmap.
 */
export function cropSourceRect(bitmapWidth: number, bitmapHeight: number, crop: PictureCrop): { sx: number; sy: number; s: number } {
  const sx = Math.min(Math.max(0, crop.x * bitmapWidth), Math.max(0, bitmapWidth - 1));
  const sy = Math.min(Math.max(0, crop.y * bitmapHeight), Math.max(0, bitmapHeight - 1));
  const s = Math.max(1, Math.min(crop.side * bitmapWidth, bitmapWidth - sx, bitmapHeight - sy));
  return { sx, sy, s };
}

/**
 * The `resizeWidth` to decode at for a cropped thumbnail: the width at which
 * the crop square is at least 256 px, never wider than the original.
 *
 * The header's width x height is before any EXIF rotation and `resizeWidth`
 * applies to the ORIENTED width, so the orientation is unknown here. The
 * shorter header side is the one cap that is never above the original in
 * either orientation, and it also keeps the decoded bitmap within the header's
 * own pixel count (width^2 x aspect <= short x long). A tight crop on an
 * unrotated landscape photo may therefore decode a little under 256 px and be
 * upscaled onto the canvas; that is the price of never over-decoding.
 */
export function cropDecodeWidth(crop: PictureCrop, headerWidth: number, headerHeight: number): number {
  const needed = Math.ceil(CROP_OUTPUT_PX / crop.side);
  return Math.max(1, Math.min(needed, headerWidth, headerHeight));
}
