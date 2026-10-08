import { expect, it } from 'vitest';
import { handshakeCameraCrop, nearbyQR } from './HandshakeCamera';
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
