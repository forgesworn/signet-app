// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ContactPictureCrop } from '../components/ContactPictureCrop';
import { usePicturePick } from './usePicturePick';
import { useSwipeGesture } from './useSwipeGesture';

const loadPicture = async () => ({ src: 'blob:x', width: 1000, height: 500, release: () => {} });

/** A carousel-like host: document-level swipe listeners plus a `.settings-view` card holding a crop dialog. */
function Host({ onSwipe }: { onSwipe: (...a: unknown[]) => void }) {
  useSwipeGesture({ onSwipe, onSnapBack: () => {}, onDrag: () => {} });
  return (
    <div className="settings-view">
      <p data-testid="card-body">card</p>
      <ContactPictureCrop file={new Blob([new Uint8Array([1])])} onUse={() => {}} onCancel={() => {}} loadPicture={loadPicture} />
    </div>
  );
}

function touchPan(el: Element, from: number, to: number) {
  fireEvent.touchStart(el, { touches: [{ clientX: from, clientY: 200 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: (from + to) / 2, clientY: 202 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: to, clientY: 203 }] });
  fireEvent.touchEnd(el, { touches: [] });
}

describe('a modal dialog owns its gestures (persona crop inside the carousel)', () => {
  it('the crop dialog carries aria-modal', async () => {
    render(<Host onSwipe={vi.fn()} />);
    await screen.findByTestId('crop-stage');
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
  });

  it('a touch pan on the crop stage does not swipe the carousel', async () => {
    const onSwipe = vi.fn();
    render(<Host onSwipe={onSwipe} />);
    touchPan(await screen.findByTestId('crop-stage'), 200, 100);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('a mouse drag on the crop stage does not swipe the carousel (desktop frame)', async () => {
    const onSwipe = vi.fn();
    render(<Host onSwipe={onSwipe} />);
    const stage = await screen.findByTestId('crop-stage');
    fireEvent.mouseDown(stage, { clientX: 200, clientY: 200 });
    fireEvent.mouseMove(stage, { clientX: 100, clientY: 200 });
    fireEvent.mouseUp(stage, {});
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('a pan on the card behind the dialog still swipes (the guard is scoped to the modal)', async () => {
    const onSwipe = vi.fn();
    render(<Host onSwipe={onSwipe} />);
    touchPan(screen.getByTestId('card-body'), 200, 100);
    expect(onSwipe).toHaveBeenCalledWith('h', -1, -100, 3);
  });
});

describe('usePicturePick renders the crop screen outside its host', () => {
  it('portals into .desk-frame-app when present, so the carousel transform cannot trap it', async () => {
    const frame = document.createElement('div');
    frame.className = 'desk-frame-app';
    document.body.appendChild(frame);
    // A 3x2 PNG, so the header gate passes.
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR4nGM8wcXFwMDAwMDAxAADABByAOAp6i43AAAAAElFTkSuQmCC';
    function Picker() {
      const { onInputChange, cropScreen } = usePicturePick({ onPicked: () => {}, onError: () => {} });
      return <div data-testid="host"><input type="file" data-testid="file" onChange={onInputChange} />{cropScreen}</div>;
    }
    render(<Picker />);
    const file = new File([Uint8Array.from(atob(PNG), c => c.charCodeAt(0))], 'me.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('file'), { target: { files: [file] } });
    const dialog = await screen.findByRole('dialog');
    expect(frame.contains(dialog)).toBe(true);
    expect(screen.getByTestId('host').contains(dialog)).toBe(false);
    frame.remove();
  });
});
