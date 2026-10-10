// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { JigsawSigil } from './JigsawSigil';
import { SIGIL_HEIGHT, SIGIL_SEAM, SIGIL_WIDTH, sigilPaths } from '../lib/handshake-sigil';
afterEach(cleanup);
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
