// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ContactPictureCrop } from './ContactPictureCrop';
import type { CropPicture } from '../lib/picture-crop-loader';
import { CROP_HINT, CROP_TITLE, OWN_PICTURE_UNREADABLE_COPY } from '../lib/contacts-v2-copy';

// A 1000 x 500 photo in a 360 px frame (jsdom's window is 1024 wide): the
// widest square is 500 px, so 1 screen px = 500/360 source px and the default
// square is x 250..750.
const FILE = new Blob([new Uint8Array([1])]);
const PER_PX = 500 / 360;

function picture(over: Partial<CropPicture> = {}): CropPicture {
  return { src: 'blob:photo', width: 1000, height: 500, release: vi.fn(), ...over };
}

async function open(p: CropPicture = picture()) {
  const onUse = vi.fn();
  const onCancel = vi.fn();
  const loadPicture = vi.fn(async () => p);
  const view = render(<ContactPictureCrop file={FILE} onUse={onUse} onCancel={onCancel} loadPicture={loadPicture} />);
  const stage = await screen.findByTestId('crop-stage');
  return { ...view, onUse, onCancel, loadPicture, stage, picture: p };
}

const used = (onUse: ReturnType<typeof vi.fn>) => onUse.mock.calls[0][0] as { x: number; y: number; side: number };
const pointer = (id: number, x: number, y = 100) => ({ pointerId: id, clientX: x, clientY: y });

describe('ContactPictureCrop', () => {
  it('opens on the largest centred square', async () => {
    const { onUse } = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Use this picture' }));
    expect(used(onUse)).toEqual({ x: 0.25, y: 0, side: 0.5 });
  });

  it('shows the photo scaled so the square fits, with the photo offset to the square', async () => {
    const { container } = await open();
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('blob:photo');
    expect(img.style.width).toBe('720px');
    expect(img.style.height).toBe('360px');
    expect(img.style.left).toBe('-180px');
    expect(img.style.imageOrientation).toBe('from-image');
    expect((screen.getByTestId('crop-square') as HTMLElement).style.width).toBe('360px');
  });

  it('cannot be used before the photo has opened', async () => {
    let finish: (p: CropPicture) => void = () => {};
    render(<ContactPictureCrop file={FILE} onUse={vi.fn()} onCancel={vi.fn()} loadPicture={() => new Promise(r => { finish = r; })} />);
    expect(screen.getByRole('button', { name: 'Use this picture' })).toHaveProperty('disabled', true);
    expect(screen.queryByTestId('crop-stage')).toBeNull();
    finish(picture());
    await screen.findByTestId('crop-stage');
    expect(screen.getByRole('button', { name: 'Use this picture' })).toHaveProperty('disabled', false);
  });

  it('says so, with nothing to crop, when the photo cannot be opened', async () => {
    render(<ContactPictureCrop file={FILE} onUse={vi.fn()} onCancel={vi.fn()} loadPicture={async () => { throw new Error('bad'); }} />);
    expect(await screen.findByText(OWN_PICTURE_UNREADABLE_COPY)).toBeDefined();
    expect(screen.queryByTestId('crop-stage')).toBeNull();
    expect(screen.getByRole('button', { name: 'Use this picture' })).toHaveProperty('disabled', true);
  });

  it('Cancel calls back, and the photo is released on unmount', async () => {
    const { onCancel, unmount, picture: p } = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    unmount();
    expect(p.release).toHaveBeenCalled();
  });

  it('a photo that opens after the screen was closed is released at once', async () => {
    const p = picture();
    let finish: (v: CropPicture) => void = () => {};
    const { unmount } = render(<ContactPictureCrop file={FILE} onUse={vi.fn()} onCancel={vi.fn()} loadPicture={() => new Promise(r => { finish = r; })} />);
    unmount();
    finish(p);
    await waitFor(() => expect(p.release).toHaveBeenCalled());
  });

  describe('zoom slider', () => {
    it('is labelled Zoom, and runs from the widest square to 64 source px', async () => {
      const { onUse } = await open();
      const slider = screen.getByLabelText('Zoom') as HTMLInputElement;
      expect(slider.value).toBe('0');
      fireEvent.change(slider, { target: { value: '1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Use this picture' }));
      const crop = used(onUse);
      expect(crop.side).toBeCloseTo(0.064);
      // Zoomed about the middle of the square: (500, 250) stays the middle.
      // (x is a fraction of the 1000 px width, y of the 500 px height, side of the width.)
      expect(crop.x * 1000 + crop.side * 1000 / 2).toBeCloseTo(500);
      expect(crop.y * 500 + crop.side * 1000 / 2).toBeCloseTo(250);
    });
  });

  describe('drag', () => {
    it('moves the photo with the pointer', async () => {
      const { stage, onUse } = await open();
      fireEvent.pointerDown(stage, pointer(1, 100));
      fireEvent.pointerMove(stage, pointer(1, 136));
      fireEvent.pointerUp(stage, pointer(1, 136));
      fireEvent.click(screen.getByRole('button', { name: 'Use this picture' }));
      // Dragging right by 36 px shows 36 * 500/360 more source px on the left.
      expect(used(onUse).x).toBeCloseTo((250 - 36 * PER_PX) / 1000);
      expect(used(onUse).side).toBe(0.5);
    });

    it('stops at the edge of the photo, so the square is never blank', async () => {
      const { stage, onUse } = await open();
      fireEvent.pointerDown(stage, pointer(1, 0));
      fireEvent.pointerMove(stage, pointer(1, 2000));
      fireEvent.pointerMove(stage, pointer(1, 2000, 5000));
      fireEvent.click(screen.getByRole('button', { name: 'Use this picture' }));
      expect(used(onUse)).toEqual({ x: 0, y: 0, side: 0.5 });
    });

    it('ignores moves from a pointer that was never pressed', async () => {
      const { stage, onUse } = await open();
      fireEvent.pointerMove(stage, pointer(7, 300));
      fireEvent.click(screen.getByRole('button', { name: 'Use this picture' }));
      expect(used(onUse)).toEqual({ x: 0.25, y: 0, side: 0.5 });
    });
  });

  describe('pinch', () => {
    it('spreading two pointers zooms in; pinching them together zooms back out to the widest square', async () => {
      const { stage, onUse } = await open();
      fireEvent.pointerDown(stage, pointer(1, 100));
      fireEvent.pointerDown(stage, pointer(2, 200));
      fireEvent.pointerMove(stage, pointer(2, 300));
      fireEvent.click(screen.getByRole('button', { name: 'Use this picture' }));
      expect(used(onUse).side).toBeCloseTo(0.25);

      onUse.mockClear();
      fireEvent.pointerMove(stage, pointer(2, 150));
      fireEvent.pointerMove(stage, pointer(2, 100));
      fireEvent.pointerMove(stage, pointer(2, 90));
      fireEvent.click(screen.getByRole('button', { name: 'Use this picture' }));
      expect(used(onUse).side).toBe(0.5);
    });

    it('after a finger lifts, the other one pans again', async () => {
      const { stage, onUse } = await open();
      fireEvent.pointerDown(stage, pointer(1, 100));
      fireEvent.pointerDown(stage, pointer(2, 200));
      fireEvent.pointerUp(stage, pointer(2, 200));
      fireEvent.pointerMove(stage, pointer(1, 136));
      fireEvent.click(screen.getByRole('button', { name: 'Use this picture' }));
      expect(used(onUse).x).toBeCloseTo((250 - 36 * PER_PX) / 1000);
    });
  });

  describe('wheel', () => {
    it('zooms in on a scroll up, and stops the page scrolling', async () => {
      const { stage, onUse } = await open();
      const event = createEvent.wheel(stage, { deltaY: -Math.log(2) / 0.002 });
      fireEvent(stage, event);
      expect(event.defaultPrevented).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Use this picture' }));
      expect(used(onUse).side).toBeCloseTo(0.25);
    });

    it('cannot zoom out past the widest square', async () => {
      const { stage, onUse } = await open();
      fireEvent.wheel(stage, { deltaY: 5000 });
      fireEvent.click(screen.getByRole('button', { name: 'Use this picture' }));
      expect(used(onUse)).toEqual({ x: 0.25, y: 0, side: 0.5 });
    });
  });

  it('uses the contact wording by default and the given title and hint when passed', async () => {
    const first = await open();
    expect(screen.getByText(CROP_HINT)).toBeDefined();
    expect(screen.getByRole('heading', { name: CROP_TITLE })).toBeDefined();
    first.unmount();
    render(<ContactPictureCrop file={FILE} onUse={vi.fn()} onCancel={vi.fn()} loadPicture={async () => picture()} title="My title" hint="My hint" />);
    expect(await screen.findByText('My hint')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'My title' })).toBeDefined();
  });
});
