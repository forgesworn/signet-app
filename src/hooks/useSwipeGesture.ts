import { useRef, useEffect, useCallback } from 'react';

type Axis = 'h' | 'v' | null;

interface SwipeCallbacks {
  /** Called when a swipe exceeds threshold. dx/dy is the drag distance. */
  onSwipe: (axis: 'h' | 'v', direction: -1 | 1, dx: number, dy: number) => void;
  /** Called when drag didn't exceed threshold — snap back. */
  onSnapBack: () => void;
  /** Called during drag with current offset. Use for live transform updates. */
  onDrag: (axis: 'h' | 'v', dx: number, dy: number) => void;
  /** Called on tap (no significant drag movement). */
  onTap?: () => void;
  /** Called when long-press drag engages on an interactive target. */
  onLongPressEngage?: () => void;
  /** Called when the press ends with drag still active (for cleanup of long-press visuals). */
  onLongPressRelease?: () => void;
  /** Whether gesture handling is currently disabled (e.g. during animation). */
  disabled?: boolean;
}

const AXIS_LOCK_THRESHOLD = 10; // px before axis is locked
const SWIPE_THRESHOLD = 50; // px to trigger swipe
const TAP_THRESHOLD = 10; // max movement for a tap
const LONG_PRESS_MS = 400; // hold duration before interactive targets enter drag mode
const LONG_PRESS_MOVE_CANCEL = 8; // px of movement that cancels the pending long-press timer

/**
 * CSS selector for interactive / native-scroll zones that normally block
 * a swipe. A press on one of these starts a long-press timer — if the user
 * holds still for LONG_PRESS_MS the swipe engages, letting them scroll out
 * of a densely-buttoned surface like the per-identity settings column.
 *
 * NB: `.settings-view` is deliberately NOT in this list. It's the outer
 * shell of the Settings card (col-2 per-identity card, nearly-full-viewport
 * with a dense `.settings-row` grid) — putting it here meant users could
 * only swipe from the ~40px gap above/below the card. The inner
 * `.settings-row` / `button` elements are still listed, so dense button
 * grids keep the long-press gate; the blank header / padding area
 * between rows engages swipe immediately. Same class of bug as
 * the same one but for the real settings cards.
 */
const INTERACTIVE_ZONE_SELECTOR = '.settings-row, .gear-fab, button, .approval-actions, input, select, textarea';

/**
 * Hook that attaches touch/mouse gesture handling to the document.
 * Tracks swipe gestures with axis locking and threshold detection.
 *
 * Two activation modes:
 *   - Immediate: press lands on a non-interactive area → drag starts on move.
 *   - Long-press: press lands on a button / input / scroll zone → 400ms hold
 *     without significant movement engages drag. A tap or quick drag passes
 *     the event through to the underlying element as normal.
 */
export function useSwipeGesture({
  onSwipe,
  onSnapBack,
  onDrag,
  onTap,
  onLongPressEngage,
  onLongPressRelease,
  disabled,
}: SwipeCallbacks): void {
  const startX = useRef(0);
  const startY = useRef(0);
  const dx = useRef(0);
  const dy = useRef(0);
  const dragging = useRef(false);
  /** True when the current press is on an interactive zone and we're counting down to long-press engage. */
  const awaitingLongPress = useRef(false);
  const longPressEngaged = useRef(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const axis = useRef<Axis>(null);
  /** True when the touch started inside `.settings-view`. Vertical drags from
   *  here belong to native content scroll, not card swipe. Horizontal drags
   *  still engage as normal so the user can swipe horizontally to switch
   *  cards even mid-scroll. */
  const verticalSwipeBlocked = useRef(false);

  // Store callbacks in refs so the effect doesn't re-attach on every render
  const onSwipeRef = useRef(onSwipe);
  onSwipeRef.current = onSwipe;
  const onSnapBackRef = useRef(onSnapBack);
  onSnapBackRef.current = onSnapBack;
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;
  const onLongPressEngageRef = useRef(onLongPressEngage);
  onLongPressEngageRef.current = onLongPressEngage;
  const onLongPressReleaseRef = useRef(onLongPressRelease);
  onLongPressReleaseRef.current = onLongPressRelease;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const onStart = useCallback((clientX: number, clientY: number, target: EventTarget | null) => {
    if (disabledRef.current) return;

    const el = target instanceof Element ? target : null;
    const onInteractiveZone = !!el?.closest(INTERACTIVE_ZONE_SELECTOR);
    // Block vertical card-swipe inside scrollable identity-settings cards so
    // native content scroll wins (the `.settings-view` content can overflow).
    verticalSwipeBlocked.current = !!el?.closest('.settings-view');

    startX.current = clientX;
    startY.current = clientY;
    dx.current = 0;
    dy.current = 0;
    axis.current = null;

    if (onInteractiveZone) {
      // Wait for a deliberate hold before we take over. A quick tap or an
      // immediate drag on a button passes through to the element as normal.
      awaitingLongPress.current = true;
      longPressEngaged.current = false;
      dragging.current = false;
      clearLongPressTimer();
      longPressTimer.current = setTimeout(() => {
        longPressTimer.current = null;
        awaitingLongPress.current = false;
        longPressEngaged.current = true;
        dragging.current = true;
        onLongPressEngageRef.current?.();
      }, LONG_PRESS_MS);
    } else {
      // Blank / card area: engage drag immediately, same as before.
      awaitingLongPress.current = false;
      longPressEngaged.current = false;
      dragging.current = true;
    }
  }, [clearLongPressTimer]);

  const onMove = useCallback((clientX: number, clientY: number) => {
    if (disabledRef.current) return;

    const ndx = clientX - startX.current;
    const ndy = clientY - startY.current;

    // If the long-press timer is still counting down, movement either cancels
    // it (user is trying to tap / button-initiated drag) or lets it keep
    // running if they hold still.
    if (awaitingLongPress.current) {
      if (Math.abs(ndx) > LONG_PRESS_MOVE_CANCEL || Math.abs(ndy) > LONG_PRESS_MOVE_CANCEL) {
        awaitingLongPress.current = false;
        clearLongPressTimer();
      }
      return;
    }

    if (!dragging.current) return;

    dx.current = ndx;
    dy.current = ndy;

    // Lock axis after initial movement
    if (!axis.current && (Math.abs(dx.current) > AXIS_LOCK_THRESHOLD || Math.abs(dy.current) > AXIS_LOCK_THRESHOLD)) {
      const provisionalAxis: Axis = Math.abs(dx.current) > Math.abs(dy.current) ? 'h' : 'v';
      if (provisionalAxis === 'v' && verticalSwipeBlocked.current) {
        // Inside `.settings-view`: vertical drag belongs to native scroll.
        // Abandon the drag so onDrag never fires for this gesture; the
        // touchmove listener is passive so native scroll handles itself.
        dragging.current = false;
        return;
      }
      axis.current = provisionalAxis;
    }

    if (axis.current) {
      onDragRef.current(axis.current, dx.current, dy.current);
    }
  }, [clearLongPressTimer]);

  const onEnd = useCallback(() => {
    if (disabledRef.current) return;

    // Cancel any pending long-press: press ended before we engaged.
    if (awaitingLongPress.current) {
      awaitingLongPress.current = false;
      clearLongPressTimer();
      // Short tap on a button — let the button's own handler fire. We don't
      // invoke onTap because button clicks already trigger their own behaviour.
      return;
    }

    if (!dragging.current) return;
    dragging.current = false;

    // Capture before reset — used below to skip the tap fallback for
    // long-press release with sub-threshold movement (that gesture is
    // a drag-that-didn't-go-far, not a tap).
    const wasLongPress = longPressEngaged.current;
    if (longPressEngaged.current) {
      onLongPressReleaseRef.current?.();
      longPressEngaged.current = false;
    }

    const a = axis.current;
    const ddx = dx.current;
    const ddy = dy.current;
    axis.current = null;

    if (a === 'h' && Math.abs(ddx) > SWIPE_THRESHOLD) {
      onSwipeRef.current('h', ddx < 0 ? -1 : 1, ddx, ddy);
    } else if (a === 'v' && Math.abs(ddy) > SWIPE_THRESHOLD) {
      onSwipeRef.current('v', ddy < 0 ? -1 : 1, ddx, ddy);
    } else if (!wasLongPress && Math.abs(ddx) < TAP_THRESHOLD && Math.abs(ddy) < TAP_THRESHOLD) {
      onTapRef.current?.();
    } else {
      onSnapBackRef.current();
    }
  }, [clearLongPressTimer]);

  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      onStart(t.clientX, t.clientY, e.target);
    };
    const handleTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      onMove(t.clientX, t.clientY);
    };
    const handleTouchEnd = () => onEnd();
    const handleTouchCancel = () => {
      // Defensive cleanup if the OS cancels the touch mid-gesture.
      awaitingLongPress.current = false;
      dragging.current = false;
      longPressEngaged.current = false;
      clearLongPressTimer();
    };

    const handleMouseDown = (e: MouseEvent) => onStart(e.clientX, e.clientY, e.target);
    const handleMouseMove = (e: MouseEvent) => onMove(e.clientX, e.clientY);
    const handleMouseUp = () => onEnd();

    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchmove', handleTouchMove, { passive: true });
    document.addEventListener('touchend', handleTouchEnd);
    document.addEventListener('touchcancel', handleTouchCancel);
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchcancel', handleTouchCancel);
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      // A press that started an awaiting-long-press countdown but never
      // resolved (component unmounted mid-press) must not fire its
      // callback after the listeners above are gone.
      clearLongPressTimer();
    };
  }, [onStart, onMove, onEnd, clearLongPressTimer]);
}
