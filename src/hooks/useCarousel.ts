import type { BotMetadata } from './useBotInventory';
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import type { SignetIdentity, DependantIdentity, CarouselRow, CarouselColumn } from '../types';
import { buildRows, buildChildRows, resolveActiveIdentity, findRowForGuardianKeypair } from '../lib/carousel-utils';
import type { ResolvedIdentity } from '../lib/carousel-utils';
import { resolveLandingKeypair } from '../lib/identity-display';

interface CarouselState {
  /** Current row index (identity) */
  row: number;
  /** Current column index (card type) */
  col: CarouselColumn;
  /** All rows in the identity ring */
  rows: CarouselRow[];
  /** Resolved identity info for the current row */
  activeIdentity: ResolvedIdentity;
  /** Whether child mode is active */
  childMode: boolean;
  /** The locked dependant in child mode */
  childDependant: DependantIdentity | null;
  /** Whether an animation is in progress */
  animating: boolean;
  /** Navigate to a new position */
  navigateToCell: (newRow: number, newCol: CarouselColumn) => void;
  /** Set animation state */
  setAnimating: (v: boolean) => void;
  /** Enter child mode for a dependant */
  enterChildMode: (dependantId: string) => void;
  /** Exit child mode */
  exitChildMode: () => void;
  /** Update row and column directly (after animation completes) */
  commitPosition: (row: number, col: CarouselColumn) => void;
  /**
   * Snap the carousel onto the supplied identity's landing row — always the
   * persona row now that `resolveLandingKeypair` is persona-first (spec §5,
   * §11). The mount-time landing effect only fires on the first unlock
   * (identity null→non-null) and is guarded against re-landing while
   * unlocked, so a promotion that swaps the identity in place
   * needs an explicit re-land to move off whatever row the swap left the
   * carousel on and back onto the persona row. Takes the identity explicitly
   * because the caller knows the freshly-promoted record before React state
   * catches up.
   */
  landOnPrimary: (next: SignetIdentity) => void;
}

/** Top of the ring — the persona row for every identity that has one. */
const TOP_ROW = 0;

export function useCarousel(
  identity: SignetIdentity | null,
  dependants: DependantIdentity[],
  bots: readonly BotMetadata[] = [],
): CarouselState {
  // Start at the top of the ring — the persona row. Swiping up walks through
  // extra personas, the real identity (when activated) and dependants.
  const [row, setRow] = useState(TOP_ROW);
  const [col, setCol] = useState<CarouselColumn>(0);
  const [childMode, setChildMode] = useState(false);
  // Track only the id — the active dependant object is derived below so
  // updates to the dependants array (e.g. after `addDependantPersona`
  // adds an extra persona) flow into the rendered rows immediately. An
  // earlier version stored a full `DependantIdentity` snapshot here,
  // which meant the child-mode ring kept rendering the pre-add copy and
  // the user saw no new persona row.
  const [childDependantId, setChildDependantId] = useState<string | null>(null);
  const [animating, setAnimating] = useState(false);

  // Snap to the primary keypair's row on each unlock (identity null→non-null).
  // A ref guards against overriding user navigation on subsequent identity
  // reloads while unlocked (e.g. after a cross-device sync merges and re-sets
  // identity in React state); it resets on lock so the next unlock re-lands.
  const hasLandedRef = useRef(false);
  useEffect(() => {
    if (!identity) { hasLandedRef.current = false; return; }
    if (hasLandedRef.current) return;
    hasLandedRef.current = true;
    const keypair = resolveLandingKeypair(identity);
    const targetRow = findRowForGuardianKeypair(identity, keypair, bots);
    if (targetRow !== TOP_ROW) {
      setRow(targetRow);
    }
  }, [identity, bots]);

  const childDependant: DependantIdentity | null = useMemo(
    () => childDependantId
      ? dependants.find(d => d.id === childDependantId) ?? null
      : null,
    [childDependantId, dependants],
  );

  // Build rows — recomputes when identity or dependants change.
  // Returns [] when identity is null (pre-unlock), so the hook is safe to call
  // unconditionally before App.tsx's identity guard runs.
  const rows = useMemo(() => {
    if (!identity) return [];
    if (childMode && childDependant) {
      return buildChildRows(childDependant);
    }
    return buildRows(identity, dependants, bots);
  }, [identity, dependants, childMode, childDependant, bots]);

  // Clamp row if rows array shrunk (e.g. dependant removed)
  const safeRow = rows.length > 0 && row < rows.length ? row : 0;

  const activeIdentity = useMemo<ResolvedIdentity>(
    () => rows.length > 0
      ? resolveActiveIdentity(rows[safeRow])
      : { displayName: '', displayNameIsSet: false, publicKey: '', type: '', isDependant: false },
    [rows, safeRow],
  );

  const navigateToCell = useCallback((newRow: number, newCol: CarouselColumn) => {
    setRow(newRow);
    setCol(newCol);
  }, []);

  const commitPosition = useCallback((r: number, c: CarouselColumn) => {
    setRow(r);
    setCol(c);
    setAnimating(false);
  }, []);

  const enterChildMode = useCallback((dependantId: string) => {
    const dep = dependants.find(d => d.id === dependantId);
    if (!dep) return;
    setChildMode(true);
    setChildDependantId(dependantId);
    setRow(0);
    setCol(0);
  }, [dependants]);

  const exitChildMode = useCallback(() => {
    setChildMode(false);
    setChildDependantId(null);
    // Exiting child mode returns to the top of the ring — the persona row.
    setRow(TOP_ROW);
    setCol(0);
  }, []);

  const landOnPrimary = useCallback((next: SignetIdentity) => {
    const keypair = resolveLandingKeypair(next);
    setRow(findRowForGuardianKeypair(next, keypair, bots));
    setCol(0);
  }, [bots]);

  return {
    row: safeRow,
    col,
    rows,
    activeIdentity,
    childMode,
    childDependant,
    animating,
    navigateToCell,
    setAnimating,
    enterChildMode,
    exitChildMode,
    commitPosition,
    landOnPrimary,
  };
}
