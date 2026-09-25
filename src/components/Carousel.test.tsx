// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { Carousel } from './Carousel';
import type { CarouselRow } from '../types';

/**
 * Pre-mount regression cover for the swipe jitter fix.
 *
 * On device the incoming screen used to be created at RELEASE time and could
 * not be rasterised within a frame, so the compositor animated an invisible
 * layer and the new card popped in ~75% through the slide. The carousel now
 * mounts the neighbour as soon as the gesture locks an axis, so by release it
 * has already been painted. These tests pin that mount/unmount lifecycle.
 *
 * Fixture note: two `add` rows keep the render tree trivial (AddCard only) —
 * this file is about the screen lifecycle, not card contents.
 */

const rows: CarouselRow[] = [{ type: 'add' }, { type: 'add' }];

const resolvedAdd = {
  displayName: 'Add',
  displayNameIsSet: true,
  publicKey: '',
  type: 'Add',
  isDependant: false,
} as never;

function renderCarousel(overrides: Record<string, unknown> = {}) {
  const onCommit = vi.fn();
  const onAnimatingChange = vi.fn();
  const utils = render(
    <Carousel
      row={0}
      col={0}
      rows={rows}
      activeIdentity={resolvedAdd}
      animating={false}
      onCommit={onCommit}
      onAnimatingChange={onAnimatingChange}
      badge={null}
      onNavigateDeepPage={vi.fn()}
      onQRScanned={vi.fn()}
      onEnterChildMode={vi.fn()}
      onExitChildMode={vi.fn()}
      childMode={false}
      childDependant={null}
      onAddPersona={vi.fn()}
      {...overrides}
    />,
  );
  return { ...utils, onCommit, onAnimatingChange };
}

/** The gesture hook listens on `document`, so drive it there. */
function press(x: number, y: number) {
  act(() => {
    document.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
  });
}
function move(x: number, y: number) {
  act(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
  });
}
function release() {
  act(() => {
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}

function screenCount(container: HTMLElement) {
  return container.querySelectorAll('.carousel-screen').length;
}

describe('Carousel neighbour pre-mount', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('mounts only the current screen at rest', () => {
    const { container } = renderCarousel();
    expect(screenCount(container)).toBe(1);
  });

  it('mounts the neighbour once the drag passes the axis-lock threshold', () => {
    const { container } = renderCarousel();
    press(300, 400);
    move(296, 400); // 4px — under AXIS_LOCK_THRESHOLD (10), no axis yet
    expect(screenCount(container)).toBe(1);

    move(270, 400); // 30px — axis locks 'h', neighbour must appear
    expect(screenCount(container)).toBe(2);
    expect(container.querySelector('[data-testid="carousel-incoming-screen"]')).not.toBeNull();
    release();
  });

  it('unmounts the neighbour after a release below the swipe threshold', () => {
    const { container, onCommit } = renderCarousel();
    press(300, 400);
    move(270, 400); // 30px: past axis lock, under SWIPE_THRESHOLD (50)
    expect(screenCount(container)).toBe(2);

    release();
    // Still mounted while it animates back offscreen…
    expect(screenCount(container)).toBe(2);
    act(() => { vi.advanceTimersByTime(300); });
    // …then gone, with no navigation.
    expect(screenCount(container)).toBe(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('swaps the neighbour when the drag reverses direction mid-gesture', () => {
    const { container } = renderCarousel();
    press(300, 400);
    move(240, 400); // leftwards → next column (col 1)
    const leftward = container.querySelector('[data-testid="carousel-incoming-screen"]');
    expect(leftward).not.toBeNull();

    move(380, 400); // reversed → previous column (col 3)
    expect(screenCount(container)).toBe(2);
    release();
    act(() => { vi.advanceTimersByTime(400); });
  });

  it('commits through the already-mounted neighbour on a real swipe', () => {
    const { container, onCommit, onAnimatingChange } = renderCarousel();
    press(300, 400);
    move(200, 400); // 100px left — past SWIPE_THRESHOLD
    expect(screenCount(container)).toBe(2);

    release();
    expect(onAnimatingChange).toHaveBeenCalledWith(true);
    act(() => { vi.advanceTimersByTime(400); });
    // Horizontal wrap: col 0 → col 1, same row.
    expect(onCommit).toHaveBeenCalledWith(0, 1);
    expect(screenCount(container)).toBe(1);
  });

  it('mounts nothing for a tap (no axis lock)', () => {
    const { container } = renderCarousel();
    press(300, 400);
    move(303, 400);
    expect(screenCount(container)).toBe(1);
    release();
    expect(screenCount(container)).toBe(1);
  });
});

/**
 * The inline "add your name" editor must write to the slot of the ROW it is
 * rendered on. Before this, App.tsx derived the target from
 * `identity.primaryKeypair`, so naming a nameless real identity from its own
 * card renamed the persona instead — the visible half of the cross-device
 * activation bug (a remote activation arrives with no name, the NP row shows
 * the editor, and the fix has to land on the NP slot).
 */
describe('Carousel inline rename target', () => {
  const identity = {
    id: 'a'.repeat(64),
    mnemonic: '',
    naturalPerson: { publicKey: 'b'.repeat(64), privateKey: '', displayName: '' },
    persona: { publicKey: 'c'.repeat(64), privateKey: '', displayName: 'Anon' },
    extraPersonas: [{ publicKey: 'd'.repeat(64), privateKey: '', displayName: '', derivationName: 'persona-2' }],
    // Persona-primary: the case where the row's slot and the primary differ.
    primaryKeypair: 'persona' as const,
    isChild: false,
    createdAt: 0,
    encrypted: true,
  };

  const resolvedUnnamed = {
    displayName: 'Real identity',
    displayNameIsSet: false,
    publicKey: 'b'.repeat(64),
    type: 'Natural Person',
    isDependant: false,
  } as never;

  function renderRow(row: CarouselRow, onRenameActive: (target: string, name: string) => void) {
    return render(
      <Carousel
        row={0}
        col={0}
        rows={[row]}
        activeIdentity={resolvedUnnamed}
        animating={false}
        onCommit={vi.fn()}
        onAnimatingChange={vi.fn()}
        badge={null}
        onNavigateDeepPage={vi.fn()}
        onQRScanned={vi.fn()}
        onEnterChildMode={vi.fn()}
        onExitChildMode={vi.fn()}
        childMode={false}
        childDependant={null}
        onAddPersona={vi.fn()}
        onRenameActive={onRenameActive}
      />,
    );
  }

  function commit(container: HTMLElement, value: string) {
    const input = container.querySelector('.card-name-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  }

  it('renames the real-identity slot from the natural-person row, not the primary keypair', () => {
    const onRenameActive = vi.fn();
    const { container } = renderRow({ type: 'natural-person', identity }, onRenameActive);
    commit(container, 'Alice Smith');
    expect(onRenameActive).toHaveBeenCalledWith('natural-person', 'Alice Smith');
  });

  it("renames the extra's own slot from an extra-persona row", () => {
    const onRenameActive = vi.fn();
    const { container } = renderRow({ type: 'extra-persona', identity, personaIndex: 0 }, onRenameActive);
    commit(container, 'SilverFox');
    expect(onRenameActive).toHaveBeenCalledWith('d'.repeat(64), 'SilverFox');
  });
});

describe('five-column identity matrix', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());
  it('preserves the selected column when moving to another identity', () => {
    const { onCommit } = renderCarousel({ col: 2 });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    act(() => { vi.advanceTimersByTime(400); });
    expect(onCommit).toHaveBeenCalledWith(1, 2);
  });
  it('wraps backwards from identity to the fifth camera column', () => {
    const { onCommit, container } = renderCarousel();
    expect(container.querySelectorAll('.nav-dots-h .nav-dot')).toHaveLength(5);
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    act(() => { vi.advanceTimersByTime(400); });
    expect(onCommit).toHaveBeenCalledWith(0, 4);
  });
  it('does not navigate while arrow keys edit a search field', () => {
    const { onCommit, container } = renderCarousel();
    const input = document.createElement('input'); container.appendChild(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    act(() => { vi.advanceTimersByTime(400); });
    expect(onCommit).not.toHaveBeenCalled();
  });
});
