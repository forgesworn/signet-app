import { describe, expect, it } from 'vitest';
import {
  QR_SCANNER_DIGITAL_ZOOM_RANGE,
  QR_SCANNER_PREFERRED_ZOOM,
  QR_SCANNER_VIDEO_CONSTRAINTS,
  QR_SCANNER_ZOOM_BUTTON_STEP,
  qrNextZoom,
  qrInitialZoom,
  qrScanSourceRect,
} from './QRScanner';

describe('qrScanSourceRect', () => {
  it('uses the full frame at 1x', () => {
    expect(qrScanSourceRect(1280, 720, 1)).toEqual({
      sx: 0,
      sy: 0,
      sw: 1280,
      sh: 720,
    });
  });

  it('center-crops the frame for digital zoom', () => {
    expect(qrScanSourceRect(1280, 720, 2)).toEqual({
      sx: 320,
      sy: 180,
      sw: 640,
      sh: 360,
    });
  });

  it('falls back to 1x for invalid zoom values', () => {
    expect(qrScanSourceRect(640, 480, Number.NaN)).toEqual({
      sx: 0,
      sy: 0,
      sw: 640,
      sh: 480,
    });
  });

  it('clamps extreme zoom to keep a decodable source region', () => {
    expect(qrScanSourceRect(600, 300, 99)).toEqual({
      sx: 250,
      sy: 125,
      sw: 100,
      sh: 50,
    });
  });
});

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
