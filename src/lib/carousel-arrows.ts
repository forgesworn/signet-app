// src/lib/carousel-arrows.ts
export interface CarouselArrowState {
  /** Up = previous identity. Disabled at the first row (vertical is clamped, no wrap). */
  upDisabled: boolean;
  /** Down = next identity. Disabled at the last row (vertical is clamped, no wrap). */
  downDisabled: boolean;
}

/**
 * Vertical carousel navigation is linear/clamped, so the up arrow is dead at the
 * top row and the down arrow is dead at the bottom row. Horizontal (cards) wraps,
 * so left/right are never disabled and are not modelled here.
 */
export function computeArrowState(row: number, rowCount: number): CarouselArrowState {
  return {
    upDisabled: row <= 0,
    downDisabled: rowCount <= 1 || row >= rowCount - 1,
  };
}
