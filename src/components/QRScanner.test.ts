import { describe, expect, it } from 'vitest';
import {
  QR_SCANNER_DIGITAL_ZOOM_RANGE,
  QR_SCANNER_PREFERRED_ZOOM,
  QR_SCANNER_VIDEO_CONSTRAINTS,
  QR_SCANNER_ZOOM_BUTTON_STEP,
  qrNextZoom,
  qrInitialZoom,
} from './QRScanner';

describe('qrInitialZoom', () => {
  it('starts above 1x for camera flows so distant screen QRs are easier to scan', () => {
    expect(qrInitialZoom(QR_SCANNER_DIGITAL_ZOOM_RANGE)).toBe(QR_SCANNER_PREFERRED_ZOOM);
  });

  it('clamps the preferred zoom to the camera range', () => {
    expect(qrInitialZoom({ min: 1, max: 1.25 })).toBe(1.25);
    expect(qrInitialZoom({ min: 2, max: 5 })).toBe(2);
  });
});

describe('qrNextZoom', () => {
  it('uses a tap-friendly zoom increment and clamps to the range', () => {
    const range = { min: 1, max: 2, step: 0.1 };

    expect(qrNextZoom(1.6, range, 1)).toBe(Number((1.6 + QR_SCANNER_ZOOM_BUTTON_STEP).toFixed(2)));
    expect(qrNextZoom(1.1, range, -1)).toBe(1);
    expect(qrNextZoom(1.95, range, 1)).toBe(2);
  });
});

describe('QR scanner camera constraints', () => {
  it('requests high-resolution rear-camera frames', () => {
    expect(QR_SCANNER_VIDEO_CONSTRAINTS).toMatchObject({
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 30 },
    });
  });
});
