// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Carousel } from './Carousel';
import { CarouselArrowProvider, useCarouselArrows, type CarouselArrowApi } from './CarouselArrowContext';
import type { CarouselRow } from '../types';

/**
 * Carousel behaviours around the card controls: a slide interrupted by an
 * unmount, the keyboard under the switcher and on a focused control, and the
 * "Viewing as" banner under the blur preference.
 */

const addRows: CarouselRow[] = [{ type: 'add' }, { type: 'add' }];

const dependantRows = [
  {
    type: 'dependant',
    dependant: {
      id: 'dep-1',
      guardianPubkey: '0'.repeat(64),
      displayName: 'Lily',
      naturalPerson: { publicKey: '0'.repeat(64), privateKey: '', displayName: 'Lily' },
      persona: { publicKey: '1'.repeat(64), privateKey: '', displayName: 'Lily' },
      derivationPath: 'dependant-0',
      createdAt: 0,
      autonomyStage: 'guardian-managed',
      primaryKeypair: 'natural-person',
    },
  },
  { type: 'add' },
] as unknown as CarouselRow[];

const resolvedAdd = { displayName: 'Add', displayNameIsSet: true, publicKey: '', type: 'Add', isDependant: false } as never;
const resolvedLily = {
  displayName: 'Lily', displayNameIsSet: true, publicKey: '0'.repeat(64), type: 'Dependant', isDependant: true, dependantId: 'dep-1',
} as never;

let arrowApi: CarouselArrowApi | null = null;
function ArrowProbe() {
  arrowApi = useCarouselArrows();
  return null;
}

function setup(overrides: Record<string, unknown> = {}) {
  const spies = {
    onCommit: vi.fn(),
    onAnimatingChange: vi.fn(),
    onEnterChildMode: vi.fn(),
  };
  const utils = render(
    <CarouselArrowProvider>
      <ArrowProbe />
      <Carousel
        row={0}
        col={0}
        rows={addRows}
        activeIdentity={resolvedAdd}
        animating={false}
        onNavigateDeepPage={vi.fn()}
        onQRScanned={vi.fn()}
        onExitChildMode={vi.fn()}
        childMode={false}
        childDependant={null}
        onAddPersona={vi.fn()}
        {...spies}
        {...overrides}
      />
    </CarouselArrowProvider>,
  );
  return { ...utils, ...spies };
}

const mouse = (type: string, x: number, y: number) => act(() => {
  document.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
});

describe('Carousel', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); arrowApi = null; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  describe('unmounting mid-slide', () => {
    it('clears the animating flag the slide set, so home is not left inert', () => {
      const { unmount, onAnimatingChange } = setup();
      mouse('mousedown', 300, 400);
      mouse('mousemove', 200, 400);
      mouse('mouseup', 200, 400);
      expect(onAnimatingChange).toHaveBeenLastCalledWith(true);

      unmount();

      expect(onAnimatingChange).toHaveBeenLastCalledWith(false);
    });

    it('does not touch the flag when nothing was sliding', () => {
      const { unmount, onAnimatingChange } = setup();
      unmount();
      expect(onAnimatingChange).not.toHaveBeenCalled();
    });
  });

  describe('keyboard', () => {
    it('ignores the arrow keys while the identity switcher is open', () => {
      const { onAnimatingChange } = setup();
      act(() => { arrowApi!.openSwitcher(); });

      fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
      fireEvent.keyDown(document.body, { key: 'ArrowDown' });

      expect(onAnimatingChange).not.toHaveBeenCalled();
    });

    it('still navigates with the arrow keys when the switcher is closed', () => {
      const { onAnimatingChange } = setup();
      fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
      expect(onAnimatingChange).toHaveBeenCalledWith(true);
    });

    it('does not run the card tap when Enter lands on a focused button', () => {
      const { onEnterChildMode } = setup({
        rows: dependantRows,
        activeIdentity: resolvedLily,
        children: <button type="button">Some control</button>,
      });
      const button = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Some control')!;

      fireEvent.keyDown(button, { key: 'Enter' });

      expect(onEnterChildMode).not.toHaveBeenCalled();
    });

    it('still runs the card tap on Enter elsewhere', () => {
      const { onEnterChildMode } = setup({ rows: dependantRows, activeIdentity: resolvedLily });
      fireEvent.keyDown(document.body, { key: 'Enter' });
      expect(onEnterChildMode).toHaveBeenCalledWith('dep-1');
    });
  });

  describe('Viewing as banner', () => {
    const childProps = { childMode: true, childDependant: { id: 'dep-1', displayName: 'Lily' } };

    it('blurs the name under the blur preference', () => {
      const { getByText } = setup({ ...childProps, blurIdentityNames: true });
      expect((getByText('Lily') as HTMLElement).style.filter).toContain('blur');
    });

    it('leaves the name sharp otherwise', () => {
      const { getByText } = setup(childProps);
      expect((getByText('Lily') as HTMLElement).style.filter).toBe('');
    });
  });
});
