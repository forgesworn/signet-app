import { expect, it } from 'vitest';
import { COVERED_LUMA, frameIsDark, handshakeCameraCrop, handshakeHit, nearbyQR } from './HandshakeCamera';
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
it('reads a full frame for one central code only', () => {
  // A 720x1280 portrait frame shows the square from y = 280 to y = 1000.
  const hit = (text: string, cx: number, cy: number, size: number) => ({ text, cx, cy, w: size, h: size });
  const central = hit('a', 360, 640, 400);
  expect(handshakeHit([central], 720, 1280)).toBe(central);
  expect(handshakeHit([], 720, 1280)).toBeNull();
  // A second code anywhere, including the band cropped out of the preview, is ambiguous.
  expect(handshakeHit([central, hit('b', 360, 100, 120)], 720, 1280)).toBeNull();
  expect(handshakeHit([central, hit('', 360, 100, 120)], 720, 1280)).toBeNull();
  // Small, off-centre, or running outside the visible square.
  expect(handshakeHit([hit('a', 360, 640, 100)], 720, 1280)).toBeNull();
  expect(handshakeHit([hit('a', 360, 400, 300)], 720, 1280)).toBeNull();
  expect(handshakeHit([hit('a', 360, 640, 760)], 720, 1280)).toBeNull();
  expect(handshakeHit([hit('a', 360, 140, 400)], 720, 1280)).toBeNull();
});
