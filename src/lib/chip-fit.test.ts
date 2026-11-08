import { describe, expect, it } from 'vitest';
import { fitChips } from './chip-fit';

describe('fitChips', () => {
  it('returns nothing for no chips', () => {
    expect(fitChips([], 300, 2, 8, 40)).toEqual({ shown: 0, hidden: 0 });
  });

  it('shows everything when it fits in one row', () => {
    expect(fitChips([80, 80, 80], 300, 2, 8, 40)).toEqual({ shown: 3, hidden: 0 });
  });

  it('counts an exact fit as fitting, with no +N chip', () => {
    // 100 + 8 + 100 + 8 + 100 = 316 per row; two rows hold six chips exactly.
    expect(fitChips(Array(6).fill(100), 316, 2, 8, 40)).toEqual({ shown: 6, hidden: 0 });
    expect(fitChips(Array(4).fill(100), 208, 2, 8, 40)).toEqual({ shown: 4, hidden: 0 });
  });

  it('wraps to a second row before hiding anything', () => {
    expect(fitChips([150, 150, 150], 320, 2, 8, 40)).toEqual({ shown: 3, hidden: 0 });
  });

  it('puts +N on the last row when there is room', () => {
    // Three 100 wide chips fill a 320 row (316). Seven chips need 3 rows, so only
    // two rows are shown; +N (40) cannot sit beside a full row of three, so the
    // sixth chip steps aside and +N takes its place.
    expect(fitChips(Array(7).fill(100), 320, 2, 8, 40)).toEqual({ shown: 5, hidden: 2 });
  });

  it('lets the +N chip displace one more chip when the last row is full', () => {
    // Greedy: row 1 holds 2 (208), row 2 holds 2 (208); a fifth is hidden.
    // +N (40) does not fit beside the second row's pair, so the fourth chip steps aside.
    expect(fitChips([100, 100, 100, 100, 100], 210, 2, 8, 40)).toEqual({ shown: 3, hidden: 2 });
  });

  it('single-row mode reserves room for +N', () => {
    // Row holds 3 chips (316); +N needs 48 more, so only two stay.
    expect(fitChips(Array(5).fill(100), 316, 1, 8, 40)).toEqual({ shown: 2, hidden: 3 });
    expect(fitChips([100, 100], 316, 1, 8, 40)).toEqual({ shown: 2, hidden: 0 });
  });

  it('treats a missing or invalid row count as one row', () => {
    expect(fitChips(Array(5).fill(100), 316, 0, 8, 40)).toEqual({ shown: 2, hidden: 3 });
  });

  it('shows nothing, hiding all, before the container has a width', () => {
    expect(fitChips([80, 80], 0, 2, 8, 40)).toEqual({ shown: 0, hidden: 2 });
  });

  it('copes with zero-width chips', () => {
    expect(fitChips([0, 0, 0], 100, 1, 8, 40)).toEqual({ shown: 3, hidden: 0 });
  });

  it('hides everything when even one chip plus +N cannot fit', () => {
    expect(fitChips([200, 200], 100, 1, 8, 40)).toEqual({ shown: 0, hidden: 2 });
  });
});
