// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeQrFromImage, QR_PHOTO_MAX_SIDE } from './qr-image-decode';
import type { QrDecodeOutput } from './qr-decode-core';
import type { QrDecoderClient } from './qr-decoder-client';

const bitmap = (width: number, height: number) => ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;
const client = (out: QrDecodeOutput) => ({ decode: vi.fn().mockResolvedValue(out), destroy: vi.fn() }) satisfies QrDecoderClient;
const hit = (text: string, cx: number, cy: number) => ({ text, cx, cy, w: 50, h: 50 });

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    drawImage: vi.fn(),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  }) as unknown as CanvasRenderingContext2D);
});
afterEach(() => vi.restoreAllMocks());

describe('decodeQrFromImage', () => {
  it('scales a large photo down and returns the code nearest the middle', async () => {
    const image = bitmap(4000, 3000);
    const c = client({ decoder: 'zxing', results: [hit('edge', 10, 10), hit('', 1024, 768), hit('middle', 1000, 760)] });
    const text = await decodeQrFromImage(new Blob(), { loadBitmap: async () => image, createClient: () => c });
    expect(text).toBe('middle');
    expect(c.decode).toHaveBeenCalledWith(expect.objectContaining({ width: QR_PHOTO_MAX_SIDE, height: 1536 }));
    expect(image.close).toHaveBeenCalled();
    expect(c.destroy).toHaveBeenCalled();
  });

  it('returns null when the photo holds no code, and still cleans up', async () => {
    const image = bitmap(800, 600);
    const c = client({ decoder: 'jsqr', results: [] });
    expect(await decodeQrFromImage(new Blob(), { loadBitmap: async () => image, createClient: () => c })).toBeNull();
    expect(c.decode).toHaveBeenCalledWith(expect.objectContaining({ width: 800, height: 600 }));
    expect(image.close).toHaveBeenCalled();
    expect(c.destroy).toHaveBeenCalled();
  });
});
