// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { IdentitySwitcher } from './IdentitySwitcher';
import { useSwipeGesture } from '../hooks/useSwipeGesture';

// The carousel's gesture listeners live on `document`, so a press on the sheet
// or its scrim reaches them unless the gesture hook recognises a modal. A tap
// that leaked through on a dependant's card would enter child mode.
function Harness({ onTap, onClose }: { onTap: () => void; onClose: () => void }) {
  useSwipeGesture({ onSwipe: () => {}, onSnapBack: () => {}, onDrag: () => {}, onTap });
  return <IdentitySwitcher rows={[]} current={0} onPick={() => {}} onClose={onClose} />;
}

describe('IdentitySwitcher', () => {
  afterEach(cleanup);

  it('dismissing by clicking the scrim closes the sheet without tapping the card behind', () => {
    const onTap = vi.fn();
    const onClose = vi.fn();
    const { container } = render(<Harness onTap={onTap} onClose={onClose} />);
    const scrim = container.querySelector('.identity-switcher-scrim')!;

    fireEvent.mouseDown(scrim, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.mouseUp(scrim, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.click(scrim);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onTap).not.toHaveBeenCalled();
  });

  it('a touch on the scrim does not tap the card behind', () => {
    const onTap = vi.fn();
    const { container } = render(<Harness onTap={onTap} onClose={() => {}} />);
    const scrim = container.querySelector('.identity-switcher-scrim')!;

    fireEvent.touchStart(scrim, { touches: [{ clientX: 20, clientY: 20 }] });
    fireEvent.touchEnd(scrim, { changedTouches: [{ clientX: 20, clientY: 20 }] });

    expect(onTap).not.toHaveBeenCalled();
  });
});
