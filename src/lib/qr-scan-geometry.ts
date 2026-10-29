// Pure geometry for the QR scan loop: where in the video frame the framing box
// is, and which of several decoded codes to believe.
import type { QrHit } from './qr-decode-core';

export interface Rect { left: number; top: number; width: number; height: number }
export interface Size { width: number; height: number }
export interface CropRegion { sx: number; sy: number; sw: number; sh: number }

/** Margin kept around the framing box on every side, as a share of the box. */
export const QR_CROP_MARGIN = 0.15;
/** Longest side of the image handed to the decoder. */
export const QR_MAX_DECODE_SIDE = 1024;

/**
 * Maps the on-screen framing box into video pixels.
 *
 * `container` is the untransformed layout size of the video element; `box` is
 * the framing box in the same coordinate space (origin at the container's top
 * left). The video is drawn `object-fit: cover`, then scaled by `zoom` about
 * the container centre (CSS `scale()`; pass 1 when zoom is optical, since the
 * camera already delivers the zoomed frame). The box is grown by `margin` on
 * each side and clamped to the frame. If the layout is unmeasurable (zero
 * sizes) the whole frame is returned.
 */
export function qrBoxRegion(
  video: Size,
  container: Size,
  box: Rect,
  zoom: number,
  margin = QR_CROP_MARGIN,
): CropRegion {
  const whole: CropRegion = { sx: 0, sy: 0, sw: video.width, sh: video.height };
  if (video.width <= 0 || video.height <= 0 || container.width <= 0 || container.height <= 0 || box.width <= 0 || box.height <= 0) {
    return whole;
  }
  const z = Number.isFinite(zoom) && zoom >= 1 ? zoom : 1;
  const scale = Math.max(container.width / video.width, container.height / video.height);
  const offX = (container.width - video.width * scale) / 2;
  const offY = (container.height - video.height * scale) / 2;
  const cx = container.width / 2;
  const cy = container.height / 2;

  const toVideoX = (x: number) => ((cx + (x - cx) / z) - offX) / scale;
  const toVideoY = (y: number) => ((cy + (y - cy) / z) - offY) / scale;

  const left = box.left - box.width * margin;
  const right = box.left + box.width * (1 + margin);
  const top = box.top - box.height * margin;
  const bottom = box.top + box.height * (1 + margin);

  const x0 = Math.max(0, Math.floor(toVideoX(left)));
  const x1 = Math.min(video.width, Math.ceil(toVideoX(right)));
  const y0 = Math.max(0, Math.floor(toVideoY(top)));
  const y1 = Math.min(video.height, Math.ceil(toVideoY(bottom)));
  if (x1 - x0 < 1 || y1 - y0 < 1) return whole;
  return { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 };
}

/** Output size for a crop: downscale so the longest side is at most `maxSide`, never upscale. */
export function qrDecodeSize(sw: number, sh: number, maxSide = QR_MAX_DECODE_SIDE): Size {
  const longest = Math.max(sw, sh);
  const k = longest > maxSide ? maxSide / longest : 1;
  return { width: Math.max(1, Math.round(sw * k)), height: Math.max(1, Math.round(sh * k)) };
}

/** With several codes in view, trust the one nearest the middle of the crop. */
export function pickNearestCentre(hits: readonly QrHit[], width: number, height: number): QrHit | null {
  let best: QrHit | null = null;
  let bestDist = Infinity;
  for (const hit of hits) {
    const d = (hit.cx - width / 2) ** 2 + (hit.cy - height / 2) ** 2;
    if (d < bestDist) { best = hit; bestDist = d; }
  }
  return best;
}
