import { describe, expect, it } from 'vitest';
import { pickNearestCentre, qrBoxRegion, qrDecodeSize } from './qr-scan-geometry';

// A 360x640 phone screen showing the video; a 220px box centred on it.
const phone = { width: 360, height: 640 };
const centredBox = { left: 70, top: 210, width: 220, height: 220 };

describe('qrBoxRegion', () => {
  it('maps the box through object-fit: cover for a landscape video on a portrait screen', () => {
    // scale 640/720; the video overflows 389px each side horizontally.
    expect(qrBoxRegion({ width: 1280, height: 720 }, phone, centredBox, 1, 0))
      .toEqual({ sx: 516, sy: 236, sw: 248, sh: 248 });
  });

  it('adds a 15% margin on every side by default', () => {
    expect(qrBoxRegion({ width: 1280, height: 720 }, phone, centredBox, 1))
      .toEqual({ sx: 479, sy: 199, sw: 322, sh: 322 });
  });

  it('maps a portrait video on a portrait screen without cropping', () => {
    expect(qrBoxRegion({ width: 720, height: 1280 }, phone, centredBox, 1, 0))
      .toEqual({ sx: 140, sy: 420, sw: 440, sh: 440 });
  });

  it('crops vertically when a portrait video fills a landscape container', () => {
    expect(qrBoxRegion({ width: 720, height: 1280 }, { width: 640, height: 360 }, { left: 220, top: 70, width: 200, height: 200 }, 1, 0))
      .toEqual({ sx: 247, sy: 516, sw: 226, sh: 226 });
  });

  it('shrinks the region by the digital zoom, about the container centre', () => {
    expect(qrBoxRegion({ width: 720, height: 1280 }, phone, centredBox, 2, 0))
      .toEqual({ sx: 250, sy: 530, sw: 220, sh: 220 });
    expect(qrBoxRegion({ width: 1280, height: 720 }, phone, centredBox, 2, 0))
      .toEqual({ sx: 578, sy: 298, sw: 124, sh: 124 });
  });

  it('treats a missing or sub-1 zoom as 1x', () => {
    const base = qrBoxRegion({ width: 720, height: 1280 }, phone, centredBox, 1, 0);
    expect(qrBoxRegion({ width: 720, height: 1280 }, phone, centredBox, Number.NaN, 0)).toEqual(base);
    expect(qrBoxRegion({ width: 720, height: 1280 }, phone, centredBox, 0.5, 0)).toEqual(base);
  });

  it('clamps to the frame at the top-left and bottom-right', () => {
    const topLeft = qrBoxRegion({ width: 720, height: 1280 }, phone, { left: 0, top: 0, width: 100, height: 100 }, 1);
    expect(topLeft.sx).toBe(0);
    expect(topLeft.sy).toBe(0);
    const bottomRight = qrBoxRegion({ width: 720, height: 1280 }, phone, { left: 300, top: 580, width: 100, height: 100 }, 1);
    expect(bottomRight.sx + bottomRight.sw).toBe(720);
    expect(bottomRight.sy + bottomRight.sh).toBe(1280);
  });

  it('returns the whole frame when the layout cannot be measured', () => {
    const whole = { sx: 0, sy: 0, sw: 1280, sh: 720 };
    expect(qrBoxRegion({ width: 1280, height: 720 }, { width: 0, height: 0 }, centredBox, 1)).toEqual(whole);
    expect(qrBoxRegion({ width: 1280, height: 720 }, phone, { left: 0, top: 0, width: 0, height: 0 }, 1)).toEqual(whole);
  });

  it('returns the whole frame when the box lies entirely outside the video', () => {
    expect(qrBoxRegion({ width: 720, height: 1280 }, phone, { left: 1000, top: 1000, width: 50, height: 50 }, 1))
      .toEqual({ sx: 0, sy: 0, sw: 720, sh: 1280 });
  });
});

describe('qrDecodeSize', () => {
  it('downscales so the longest side is at most 1024', () => {
    expect(qrDecodeSize(2048, 1024)).toEqual({ width: 1024, height: 512 });
    expect(qrDecodeSize(600, 3000)).toEqual({ width: 205, height: 1024 });
  });

  it('never upscales', () => {
    expect(qrDecodeSize(300, 200)).toEqual({ width: 300, height: 200 });
    expect(qrDecodeSize(1024, 1024)).toEqual({ width: 1024, height: 1024 });
  });
});

describe('pickNearestCentre', () => {
  it('picks the code whose centre is nearest the middle of the crop', () => {
    const hits = [
      { text: 'far', cx: 10, cy: 10, w: 10, h: 10 },
      { text: 'near', cx: 205, cy: 195, w: 10, h: 10 },
      { text: 'mid', cx: 300, cy: 100, w: 10, h: 10 },
    ];
    expect(pickNearestCentre(hits, 400, 400)?.text).toBe('near');
  });

  it('returns null when nothing was decoded', () => {
    expect(pickNearestCentre([], 400, 400)).toBeNull();
  });
});
