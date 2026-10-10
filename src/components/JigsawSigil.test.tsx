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
/** A line's named points: ends, the two turns and the seam crossing. */
const parts = (d: string) => {
  const n = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
  expect(n).toHaveLength(24);
  return { topY: n[1], turn1: n[6], seamX: n[12], seamY: n[13], slope: n[12] - n[10], turn2: n[16], bottomY: n[23], topEnd: n[0], bottomEnd: n[22] };
};
it('runs every line from top to bottom through the seam, crossing it inside the width', () => {
  for (const path of sigilPaths(digest)) {
    const p = parts(path.d);
    expect([p.topY, p.seamY, p.bottomY]).toEqual([-SIGIL_OVERHANG, SIGIL_SEAM, SIGIL_HEIGHT + SIGIL_OVERHANG]);
    expect(p.seamX > 0 && p.seamX < SIGIL_WIDTH).toBe(true);
  }
});
it('snakes: the turn above the seam and the turn below it swing to opposite sides', () => {
  for (const d of ['ab'.repeat(32), 'cd'.repeat(32), '01'.repeat(32)]) for (const path of sigilPaths(d)) {
    const p = parts(path.d);
    expect(Math.sign(p.turn1 - p.seamX)).toBe(-Math.sign(p.turn2 - p.seamX));
    expect(Math.abs(p.turn1 - p.seamX)).toBeGreaterThanOrEqual(18);
  }
});
it('moves the same on both phones at the same moment, and differently for another digest', () => {
  const a = sigilAnimator(digest), b = sigilAnimator(digest), other = sigilAnimator('cd'.repeat(32));
  for (const t of [0, 1234, 1_700_000_000_123]) {
    expect(a(t)).toEqual(b(t));
    expect(other(t)).not.toEqual(a(t));
  }
  expect(sigilMotion(digest)).toEqual(sigilMotion(digest));
});
it('flexes the curves, not just slides them: the slope, the turns and the ends all change', () => {
  const at = sigilAnimator(digest);
  for (let i = 0; i < 8; i++) {
    const seen = Array.from({ length: 60 }, (_, k) => parts(at(k * 500)[i]));
    for (const key of ['slope', 'turn1', 'turn2', 'topEnd'] as const) {
      expect(new Set(seen.map(p => (p[key] - p.seamX).toFixed(1))).size).toBeGreaterThan(5);
    }
    // Every line still crosses the seam, and starts and ends at the top and bottom.
    const p = parts(at(777)[i]);
    expect([p.topY, p.seamY, p.bottomY]).toEqual([-SIGIL_OVERHANG, SIGIL_SEAM, SIGIL_HEIGHT + SIGIL_OVERHANG]);
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
it('animates the lines of a half with the clock, but keeps the whole sigil still', () => {
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
});
it('under reduced motion keeps the seam moving with the other phone, and stills only this phone\'s turns and ends (review L3)', () => {
  vi.useFakeTimers({ toFake: ['Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
  const full = sigilAnimator(digest), calm = sigilAnimator(digest, { seamOnly: true }), still = sigilPaths(digest);
  for (const t of [1_700_000_000_000, 1_700_000_003_210]) {
    vi.setSystemTime(t);
    const shown = render(<JigsawSigil digest={digest} half="top" />).container.querySelectorAll('path');
    shown.forEach((path, i) => {
      const p = parts(path.getAttribute('d')!), moving = parts(full(t)[i]), rest = parts(still[i].d);
      expect(path.getAttribute('d')).toBe(calm(t)[i]);
      // What the other phone also shows, the seam crossing, matches its full animation exactly.
      expect([p.seamX, p.slope]).toEqual([moving.seamX, moving.slope]);
      // The turns and ends sit where they rest, relative to the seam.
      expect(p.turn1 - p.seamX).toBeCloseTo(rest.turn1 - rest.seamX, 1);
      expect(p.topEnd - p.seamX).toBeCloseTo(rest.topEnd - rest.seamX, 1);
    });
    cleanup();
  }
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
