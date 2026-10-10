// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { JigsawSigil, SEAM_GAP_DP } from './JigsawSigil';
import { SIGIL_HEIGHT, SIGIL_OVERHANG, SIGIL_SEAM, SIGIL_WIDTH, sigilAnimator, sigilMotion, sigilPaths, sigilWave } from '../lib/handshake-sigil';
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
    expect(n[1]).toBe(-SIGIL_OVERHANG);
    expect(n[7]).toBe(SIGIL_SEAM);
    expect(n[n.length - 1]).toBe(SIGIL_HEIGHT + SIGIL_OVERHANG);
    for (const x of [n[0], n[2], n[4], n[6], n[8], n[10]]) expect(x >= 0 && x <= SIGIL_WIDTH).toBe(true);
  }
});
const numbers = (d: string) => d.match(/-?\d+(\.\d+)?/g)!.map(Number);
it('moves the same on both phones at the same moment, and differently for another digest', () => {
  const a = sigilAnimator(digest), b = sigilAnimator(digest), other = sigilAnimator('cd'.repeat(32));
  for (const t of [0, 1234, 1_700_000_000_123]) {
    expect(a(t)).toEqual(b(t));
    expect(other(t)).not.toEqual(a(t));
  }
  expect(sigilMotion(digest)).toEqual(sigilMotion(digest));
});
it('flexes the curves, not just slides them: the slope through the seam and the bend at the ends both change', () => {
  const at = sigilAnimator(digest);
  for (let i = 0; i < 8; i++) {
    const shape = (t: number) => { const n = numbers(at(t)[i]); return { seam: n[6], slope: n[6] - n[4], bend: n[0] - n[6] }; };
    const seen = Array.from({ length: 60 }, (_, k) => shape(k * 500));
    expect(new Set(seen.map(s => s.slope.toFixed(1))).size).toBeGreaterThan(5);
    expect(new Set(seen.map(s => s.bend.toFixed(1))).size).toBeGreaterThan(5);
    // Every line still crosses the seam, and starts and ends at the top and bottom.
    const n = numbers(at(777)[i]);
    expect([n[1], n[7], n[n.length - 1]]).toEqual([-SIGIL_OVERHANG, SIGIL_SEAM, SIGIL_HEIGHT + SIGIL_OVERHANG]);
  }
});
it('changes what meets at the seam slowly, so clocks a third of a second apart still join', () => {
  for (const m of sigilMotion(digest)) {
    for (const w of [m.drift, m.slope]) {
      expect(Math.abs(sigilWave(w, 1_700_000_000_123))).toBeLessThanOrEqual(w.amplitude);
      // The fastest a third of a second can move it: under 4.5 of 256.
      expect(2 * Math.PI * w.amplitude * 333 / w.periodMs).toBeLessThan(4.5);
    }
  }
});
it('animates the lines of a half with the clock, but keeps the whole sigil and reduced motion still', () => {
  vi.useFakeTimers({ toFake: ['Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  vi.setSystemTime(1_700_000_000_000);
  const still = sigilPaths(digest)[0].d;
  const moving = render(<JigsawSigil digest={digest} half="bottom" />).container.querySelector('path')!;
  const first = moving.getAttribute('d');
  expect(first).toBe(sigilAnimator(digest)(1_700_000_000_000)[0]);
  vi.setSystemTime(1_700_000_002_000); vi.advanceTimersToNextFrame();
  expect(moving.getAttribute('d')).not.toBe(first);
  cleanup();
  expect(render(<JigsawSigil digest={digest} />).container.querySelector('path')!.getAttribute('d')).toBe(still);
  cleanup();
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
  expect(render(<JigsawSigil digest={digest} half="top" />).container.querySelector('path')!.getAttribute('d')).toBe(still);
});
it('starts each half beyond the seam by the hidden strip, the same physical distance on phones of different widths', () => {
  const at = (width: number, half: 'top' | 'bottom') => {
    const spy = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ width } as DOMRect);
    const [, y] = render(<JigsawSigil digest={digest} half={half} />).container.querySelector('svg')!.getAttribute('viewBox')!.split(' ').map(Number);
    cleanup(); spy.mockRestore();
    return y;
  };
  for (const width of [384, 411]) {
    const gap = SEAM_GAP_DP * SIGIL_WIDTH / width;
    expect(at(width, 'bottom')).toBeCloseTo(SIGIL_SEAM + gap, 1);
    expect(at(width, 'top')).toBeCloseTo(-gap, 1);
    // In screen units the strip is SEAM_GAP_DP on either width.
    expect((at(width, 'bottom') - SIGIL_SEAM) * width / SIGIL_WIDTH).toBeCloseTo(SEAM_GAP_DP, 0);
  }
  // Never beyond the lines' overhang, even on a very narrow screen.
  expect(at(100, 'bottom')).toBeCloseTo(SIGIL_SEAM + SIGIL_OVERHANG, 1);
});
