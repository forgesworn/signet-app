/**
 * Chip fitting for the card's known-places strip: how many measured chips show
 * in the allowed rows, and how many fold into one trailing "+N" chip.
 *
 * Pure so it can be tested without a DOM; the strip measures `offsetWidth`
 * (ResizeObserver) and passes the numbers in.
 */

export interface ChipFit {
  shown: number;
  hidden: number;
}

/** Row cursor after greedily placing `count` chips; `rowsUsed` is 1-based, 0 when nothing is placed. */
interface Layout {
  rowsUsed: number;
  lastRowWidth: number;
}

function layoutPrefix(widths: number[], count: number, containerWidth: number, gap: number): Layout {
  let rowsUsed = 0;
  let used = 0;
  for (let i = 0; i < count; i++) {
    const w = Math.max(0, widths[i]);
    if (rowsUsed === 0) {
      rowsUsed = 1;
      used = w;
    } else if (used + gap + w <= containerWidth) {
      used += gap + w;
    } else {
      rowsUsed += 1;
      used = w;
    }
  }
  return { rowsUsed, lastRowWidth: used };
}

/** Greedy count of chips that fit in `rows` rows (a chip wider than the row sits alone on its own row). */
function maxPlaceable(widths: number[], containerWidth: number, rows: number, gap: number): number {
  let rowsUsed = 0;
  let used = 0;
  for (let i = 0; i < widths.length; i++) {
    const w = Math.max(0, widths[i]);
    if (rowsUsed === 0) {
      rowsUsed = 1;
      used = w;
    } else if (used + gap + w <= containerWidth) {
      used += gap + w;
    } else if (rowsUsed < rows) {
      rowsUsed += 1;
      used = w;
    } else {
      return i;
    }
  }
  return widths.length;
}

/**
 * Pack chips left to right into at most `rows` rows. When they do not all fit,
 * the "+N" chip takes the end of the last row it can sit on, displacing as many
 * further chips as it needs to. A container with no width yet (not measured)
 * shows nothing and folds everything into "+N".
 */
export function fitChips(
  widths: number[],
  containerWidth: number,
  rows: number,
  gap: number,
  plusChipWidth: number,
): ChipFit {
  const n = widths.length;
  if (n === 0) return { shown: 0, hidden: 0 };
  if (!(containerWidth > 0)) return { shown: 0, hidden: n };
  const maxRows = Math.max(1, Math.floor(rows));
  const g = Math.max(0, gap);
  const plus = Math.max(0, plusChipWidth);

  const placeable = maxPlaceable(widths, containerWidth, maxRows, g);
  if (placeable === n) return { shown: n, hidden: 0 };

  for (let k = placeable; k >= 0; k--) {
    const { rowsUsed, lastRowWidth } = layoutPrefix(widths, k, containerWidth, g);
    const fitsOnLastRow = rowsUsed > 0 && lastRowWidth + g + plus <= containerWidth;
    const fitsOnNewRow = rowsUsed < maxRows && plus <= containerWidth;
    if (fitsOnLastRow || fitsOnNewRow) return { shown: k, hidden: n - k };
  }
  return { shown: 0, hidden: n };
}
