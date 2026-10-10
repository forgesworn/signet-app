// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { JigsawSigil } from './JigsawSigil';
import { SIGIL_HEIGHT, SIGIL_SEAM, SIGIL_WIDTH, sigilMotion, sigilOffset, sigilPaths } from '../lib/handshake-sigil';
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const digest = 'ab'.repeat(32);
const box = (half: 'top' | 'bottom' | 'whole') => {
  const svg = render(<JigsawSigil digest={digest} half={half} />).container.querySelector('svg')!;
  const [x, y, w, h] = svg.getAttribute('viewBox')!.split(' ').map(Number);
  return { svg, x, y, w, h };
};
it('splits the sigil across the seam into two full-width halves that tile it exactly', () => {
  const top = box('top'), bottom = box('bottom'), whole = box('whole');
  expect([whole.x, whole.y, whole.w, whole.h]).toEqual([0, 0, SIGIL_WIDTH, SIGIL_HEIGHT]);
  expect([top.x, top.y, top.w, top.h]).toEqual([0, 0, SIGIL_WIDTH, SIGIL_SEAM]);
  expect([bottom.x, bottom.y, bottom.w, bottom.h]).toEqual([0, SIGIL_SEAM, SIGIL_WIDTH, SIGIL_HEIGHT - SIGIL_SEAM]);
  // Only the top half turns, so on both phones the seam is at the top edge.
  expect(top.svg.classList.contains('jigsaw-sigil-top')).toBe(true);
  expect(bottom.svg.classList.contains('jigsaw-sigil-bottom')).toBe(true);
});
it('runs every line from top to bottom through the seam, inside the width', () => {
  for (const path of sigilPaths(digest)) {
    const n = path.d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    expect(n[1]).toBe(0);
    expect(n[7]).toBe(SIGIL_SEAM);
    expect(n[n.length - 1]).toBe(SIGIL_HEIGHT);
    for (const x of [n[0], n[2], n[4], n[6], n[8], n[10]]) expect(x >= 0 && x <= SIGIL_WIDTH).toBe(true);
  }
});
it('moves the same on both phones at the same moment, slowly and within a small swing, and differently for another digest', () => {
  const a = sigilMotion(digest), b = sigilMotion(digest), other = sigilMotion('cd'.repeat(32));
  expect(a).toEqual(b);
  expect(other).not.toEqual(a);
  for (const m of a) {
    for (const t of [0, 1234, 1_700_000_000_123]) expect(Math.abs(sigilOffset(m, t))).toBeLessThanOrEqual(14);
    // A third of a second between two clocks moves a line by under 1 of 256.
    const worst = Math.max(...Array.from({ length: 200 }, (_, k) => Math.abs(sigilOffset(m, k * 50 + 333) - sigilOffset(m, k * 50))));
    expect(worst).toBeLessThan(1.1 * (2 * Math.PI * m.amplitude * 333) / m.periodMs + 0.01);
    expect(2 * Math.PI * m.amplitude * 333 / m.periodMs).toBeLessThan(4.2);
  }
});
it('drifts the lines of a half with the clock, but keeps the whole sigil and reduced motion still', () => {
  vi.useFakeTimers({ toFake: ['Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  vi.setSystemTime(1_700_000_000_000);
  const moving = render(<JigsawSigil digest={digest} half="bottom" />).container.querySelector('path')!;
  const first = moving.getAttribute('transform');
  expect(first).toMatch(/^translate\(-?\d+\.\d{2} 0\)$/);
  vi.setSystemTime(1_700_000_002_000); vi.advanceTimersToNextFrame();
  expect(moving.getAttribute('transform')).not.toBe(first);
  cleanup();
  expect(render(<JigsawSigil digest={digest} />).container.querySelector('path')!.getAttribute('transform')).toBeNull();
  cleanup();
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
  expect(render(<JigsawSigil digest={digest} half="top" />).container.querySelector('path')!.getAttribute('transform')).toBeNull();
});
