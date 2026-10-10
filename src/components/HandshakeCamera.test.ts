import { expect, it } from 'vitest';
import { COVERED_LUMA, frameIsDark, handshakeCameraCrop, nearbyQR } from './HandshakeCamera';
it('matches the displayed square for portrait, landscape and square camera streams', () => {
  expect(handshakeCameraCrop(1080, 1920)).toEqual({ x: 0, y: 420, size: 1080 });
  expect(handshakeCameraCrop(1920, 1080)).toEqual({ x: 420, y: 0, size: 1080 });
  expect(handshakeCameraCrop(640, 640)).toEqual({ x: 0, y: 0, size: 640 });
});
it('still refuses small or off-centre codes in the visible square', () => {
  const location = (x: number, y: number, size: number) => ({ topLeftCorner: { x, y }, topRightCorner: { x: x + size, y },
    bottomRightCorner: { x: x + size, y: y + size }, bottomLeftCorner: { x, y: y + size } });
  expect(nearbyQR(location(300, 300, 400), 1000, 1000)).toBe(true);
  expect(nearbyQR(location(450, 450, 100), 1000, 1000)).toBe(false);
  expect(nearbyQR(location(0, 0, 400), 1000, 1000)).toBe(false);
});
it('takes a near-black frame as a covered lens, and a dim room as not', () => {
  const frame = (r: number, g: number, b: number) => new Uint8ClampedArray(Array.from({ length: 16 }, () => [r, g, b, 255]).flat());
  expect(frameIsDark(frame(4, 4, 6))).toBe(true);
  expect(frameIsDark(frame(COVERED_LUMA + 10, COVERED_LUMA + 10, COVERED_LUMA + 10))).toBe(false);
  expect(frameIsDark(new Uint8ClampedArray(0))).toBe(false);
});
