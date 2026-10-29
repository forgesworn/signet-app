// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CarouselRow } from '../types';

// The camera card must only ever be told it is live when it is the screen the
// user is looking at: never the incoming neighbour, never mid-transition.
vi.mock('./CameraCard', () => ({
  CameraCard: ({ live }: { live?: boolean }) => <div data-testid="camera-card" data-live={String(live)} />,
}));

import { Carousel } from './Carousel';

const identity = {
  id: 'a'.repeat(64),
  mnemonic: '',
  naturalPerson: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Real' },
  persona: { publicKey: 'c'.repeat(64), privateKey: '', displayName: 'Anon' },
  extraPersonas: [],
  primaryKeypair: 'persona' as const,
  isChild: false,
  createdAt: 0,
  encrypted: true,
};
const rows: CarouselRow[] = [
  { type: 'natural-person', identity },
  { type: 'natural-person', identity },
];
const resolved = { displayName: 'Real', displayNameIsSet: true, publicKey: 'b'.repeat(64), type: 'Natural Person', isDependant: false } as never;

function renderAtCamera(animating: boolean) {
  return render(
    <Carousel
      row={0}
      col={4}
      rows={rows}
      activeIdentity={resolved}
      animating={animating}
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
    />,
  );
}

describe('Carousel camera card liveness', () => {
  it('is live when the camera screen is current and at rest', () => {
    const { getByTestId } = renderAtCamera(false);
    expect(getByTestId('camera-card')).toHaveAttribute('data-live', 'true');
  });

  it('is not live while the carousel is animating', () => {
    const { getByTestId } = renderAtCamera(true);
    expect(getByTestId('camera-card')).toHaveAttribute('data-live', 'false');
  });

  it('never marks the pre-mounted incoming neighbour live', () => {
    const { container } = renderAtCamera(false);
    act(() => { document.dispatchEvent(new MouseEvent('mousedown', { clientX: 200, clientY: 400, bubbles: true })); });
    act(() => { document.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 360, bubbles: true })); });
    const incoming = container.querySelector('[data-testid="carousel-incoming-screen"]');
    expect(incoming).not.toBeNull();
    const incomingCam = incoming!.querySelector('[data-testid="camera-card"]');
    expect(incomingCam).toHaveAttribute('data-live', 'false');
    const current = Array.from(container.querySelectorAll('[data-testid="camera-card"]')).filter(el => !incoming!.contains(el));
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute('data-live', 'true');
    act(() => { document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  });
});
