import { describe, expect, it, vi } from 'vitest';
import { QrDecoder, jsqrInversionForFrame, type QrFrame, type ZxingRead } from './qr-decode-core';

const frame: QrFrame = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
const corners = (x: number, y: number) => ({
  topLeftCorner: { x: x - 1, y: y - 1 },
  topRightCorner: { x: x + 1, y: y - 1 },
  bottomRightCorner: { x: x + 1, y: y + 1 },
  bottomLeftCorner: { x: x - 1, y: y + 1 },
});

describe('jsqrInversionForFrame', () => {
  it('alternates polarity on successive frames', () => {
    expect([0, 1, 2, 3].map(jsqrInversionForFrame)).toEqual(['dontInvert', 'onlyInvert', 'dontInvert', 'onlyInvert']);
  });
});

describe('QrDecoder', () => {
  it('uses zxing when it initialises, and does not touch jsQR', async () => {
    const read: ZxingRead = vi.fn().mockResolvedValue([{ text: 'a', cx: 1, cy: 1, w: 1, h: 1 }]);
    const jsqr = vi.fn();
    const decoder = new QrDecoder({ loadZxing: () => Promise.resolve(read), jsqr });
    expect(await decoder.decode(frame)).toEqual({ results: [{ text: 'a', cx: 1, cy: 1, w: 1, h: 1 }], decoder: 'zxing' });
    expect(decoder.kind).toBe('zxing');
    expect(jsqr).not.toHaveBeenCalled();
  });

  it('falls back to jsQR when zxing fails to initialise, alternating polarity', async () => {
    const jsqr = vi.fn().mockReturnValue(null);
    const decoder = new QrDecoder({ loadZxing: () => Promise.reject(new Error('wasm blocked')), jsqr });
    const first = await decoder.decode(frame);
    await decoder.decode(frame);
    await decoder.decode(frame);
    expect(first).toEqual({ results: [], decoder: 'jsqr' });
    expect(decoder.kind).toBe('jsqr');
    expect(jsqr.mock.calls.map(c => c[3])).toEqual([
      { inversionAttempts: 'dontInvert' },
      { inversionAttempts: 'onlyInvert' },
      { inversionAttempts: 'dontInvert' },
    ]);
  });

  it('uses jsQR only when no zxing loader is supplied (main-thread fallback)', async () => {
    const jsqr = vi.fn().mockReturnValue({ data: 'hello', location: corners(10, 20) });
    const out = await new QrDecoder({ jsqr }).decode(frame);
    expect(out).toEqual({ results: [{ text: 'hello', cx: 10, cy: 20, w: 2, h: 2 }], decoder: 'jsqr' });
  });

  it('abandons zxing for good once a read throws', async () => {
    const read = vi.fn().mockRejectedValue(new Error('boom'));
    const jsqr = vi.fn().mockReturnValue(null);
    const decoder = new QrDecoder({ loadZxing: () => Promise.resolve(read), jsqr });
    expect((await decoder.decode(frame)).decoder).toBe('jsqr');
    expect((await decoder.decode(frame)).decoder).toBe('jsqr');
    expect(read).toHaveBeenCalledTimes(1);
    expect(jsqr).toHaveBeenCalledTimes(2);
  });

  it('initialises zxing once however many frames arrive meanwhile', async () => {
    const load = vi.fn().mockResolvedValue(vi.fn().mockResolvedValue([]));
    const decoder = new QrDecoder({ loadZxing: load, jsqr: vi.fn() });
    await Promise.all([decoder.warm(), decoder.decode(frame), decoder.decode(frame)]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
