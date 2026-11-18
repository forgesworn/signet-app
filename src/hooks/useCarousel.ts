import type { BotMetadata } from './useBotInventory';
import { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { SignetIdentity, DependantIdentity, CarouselRow, CarouselColumn } from '../types';
import { buildRows, buildChildRows, resolveActiveIdentity, findRowForGuardianKeypair, dependantDisplayView } from '../lib/carousel-utils';
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

/** What a row shows, independent of where it sits in the ring. */
export function carouselRowKey(row: CarouselRow): string {
  switch (row.type) {
    case 'persona': return `key:${row.identity.persona.publicKey.toLowerCase()}`;
    case 'extra-persona': return `key:${(row.identity.extraPersonas?.[row.personaIndex]?.publicKey ?? '').toLowerCase()}`;
    case 'natural-person': return `key:${row.identity.naturalPerson.publicKey.toLowerCase()}`;
    case 'bot': return `bot:${row.bot.publicKey.toLowerCase()}`;
    case 'dependant': return `dep:${row.dependant.id}`;
    default: return row.type;
  }
}

export function useCarousel(
  identity: SignetIdentity | null,
  dependants: DependantIdentity[],
  bots: readonly BotMetadata[] = [],
  /**
   * A direct child's install: the personas its rules allow (`buildRows`).
   * Null is no filter; on a direct child, "not decided yet" (`childCarouselFilter`).
   */
  allowedPersonas: ReadonlySet<string> | null = null,
  /** A direct child's install: the bound persona, shown when the card on screen is no longer allowed. */
  boundPersona: string | null = null,
  /**
   * Child mode is on but this hook is not in it (yet): the saved session is
   * waiting for the unlock restore, or is still being read. The guardian's ring
   * is never built then, because the phone is in a child's hands.
   */
  childModeHeld = false,
): CarouselState {
  // Keyed on content: a new Set with the same keys is the same list.
  const allowKey = allowedPersonas ? [...allowedPersonas].map(k => k.toLowerCase()).sort().join(',') : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `allowKey` is the content of `allowedPersonas`
  const allowed = useMemo(() => allowedPersonas, [allowKey]);
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

  /**
   * The card a changing allow-list keeps on screen (`carouselRowKey`). The add
   * card is kept only when the user went there (`addChosenRef`): a moment
   * with no identity card (a list not decided yet) is not a choice. Forgotten
   * on lock, so an unlock lands afresh.
   */
  const shownKeyRef = useRef<string | null>(null);
  /** The user's last move (`navigateToCell` / `commitPosition`) was to the add card. */
  const addChosenRef = useRef(false);

  // Snap to the primary keypair's row on each unlock (identity null→non-null).
  // A ref guards against overriding user navigation on subsequent identity
  // reloads while unlocked (e.g. after a cross-device sync merges and re-sets
  // identity in React state); it resets on lock so the next unlock re-lands.
  const hasLandedRef = useRef(false);
  useEffect(() => {
    if (!identity) {
      hasLandedRef.current = false;
      shownKeyRef.current = null;
      addChosenRef.current = false;
      return;
    }
    if (hasLandedRef.current) return;
    hasLandedRef.current = true;
    const keypair = resolveLandingKeypair(identity);
    const targetRow = findRowForGuardianKeypair(identity, keypair, bots, allowed);
    if (targetRow !== TOP_ROW) {
      addChosenRef.current = false;
      setRow(targetRow);
    }
  }, [identity, bots, allowed]);

  const childDependant: DependantIdentity | null = useMemo(
    () => childDependantId
      ? dependants.find(d => d.id === childDependantId) ?? null
      : null,
    [childDependantId, dependants],
  );

  // Build rows — recomputes when identity or dependants change.
  // Returns [] when identity is null (pre-unlock), so the hook is safe to call
  // unconditionally before App.tsx's identity guard runs.
  //
  // While child mode is on the ring is only ever the child's. A lock empties the
  // dependants list for one read, so the child last shown is kept until it is
  // back (and an empty ring, not the guardian's, when there never was one).
  // Kept in display form only (names and public keys): no private key outlives the lock in it.
  const lastChildRef = useRef<DependantIdentity | null>(null);
  const childView = useMemo(() => (childDependant ? dependantDisplayView(childDependant) : null), [childDependant]);
  if (!childMode) lastChildRef.current = null;
  else if (childView) lastChildRef.current = childView;
  const shownChild = childMode ? childDependant ?? lastChildRef.current : null;
  const childRing = childMode || childModeHeld;
  const rows = useMemo(() => {
    if (!identity) return [];
    if (childRing) return shownChild ? buildChildRows(shownChild) : [];
    return buildRows(identity, dependants, bots, allowed);
  }, [identity, dependants, childRing, shownChild, bots, allowed]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // When the allow-list arrives, grows or shrinks, the ring keeps the card on
  // screen, not its row number: an extra persona's card must not turn into
  // its neighbour. A card no longer allowed gives way to the bound persona.
  // Decided while rendering, from the card last committed to the screen, so
  // no frame shows the wrong card.
  const [seenAllowKey, setSeenAllowKey] = useState(allowKey);
  let positioned = row;
  if (seenAllowKey !== allowKey) {
    setSeenAllowKey(allowKey);
    if (identity) {
      const key = shownKeyRef.current;
      let next = key ? rows.findIndex(r => carouselRowKey(r) === key) : -1;
      if (next < 0 && boundPersona) next = rows.findIndex(r => carouselRowKey(r) === `key:${boundPersona.toLowerCase()}`);
      if (next < 0) next = findRowForGuardianKeypair(identity, resolveLandingKeypair(identity), bots, allowed);
      if (next !== row && next >= 0 && next < rows.length) { positioned = next; setRow(next); }
    }
  }

  // Clamp row if rows array shrunk (e.g. dependant removed)
  const safeRow = rows.length > 0 && positioned < rows.length ? positioned : 0;

  const shownKey = rows.length > 0 ? carouselRowKey(rows[safeRow]) : null;
  useLayoutEffect(() => {
    if (!shownKey) return; // locked: nothing on screen to keep
    if (shownKey !== 'add') { addChosenRef.current = false; shownKeyRef.current = shownKey; }
    else if (addChosenRef.current) shownKeyRef.current = shownKey;
  }, [shownKey]);

  const activeIdentity = useMemo<ResolvedIdentity>(
    () => rows.length > 0
      ? resolveActiveIdentity(rows[safeRow])
      : { displayName: '', displayNameIsSet: false, publicKey: '', type: '', isDependant: false },
    [rows, safeRow],
  );

  const navigateToCell = useCallback((newRow: number, newCol: CarouselColumn) => {
    addChosenRef.current = rowsRef.current[newRow]?.type === 'add';
    setRow(newRow);
    setCol(newCol);
  }, []);

  const commitPosition = useCallback((r: number, c: CarouselColumn) => {
    addChosenRef.current = rowsRef.current[r]?.type === 'add';
    setRow(r);
    setCol(c);
    setAnimating(false);
  }, []);

  const enterChildMode = useCallback((dependantId: string) => {
    const dep = dependants.find(d => d.id === dependantId);
    if (!dep) return;
    setChildMode(true);
    setChildDependantId(dependantId);
    addChosenRef.current = false;
    setRow(0);
    setCol(0);
  }, [dependants]);

  const exitChildMode = useCallback(() => {
    setChildMode(false);
    setChildDependantId(null);
    // Exiting child mode returns to the top of the ring — the persona row.
    addChosenRef.current = false;
    setRow(TOP_ROW);
    setCol(0);
  }, []);

  const landOnPrimary = useCallback((next: SignetIdentity) => {
    const keypair = resolveLandingKeypair(next);
    addChosenRef.current = false;
    setRow(findRowForGuardianKeypair(next, keypair, bots, allowed));
    setCol(0);
  }, [bots, allowed]);

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
