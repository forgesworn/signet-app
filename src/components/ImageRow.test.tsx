// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ImageRow, type ImageRowProps } from './ImageRow';
import { OWN_PICTURE_REFUSED_COPY, PERSONA_CROP_HINT, CROP_TITLE } from '../lib/contacts-v2-copy';

// The crop screen has its own tests; here it is a stub that shows what it was given and hands back a fixed crop.
const CROP = { x: 0.1, y: 0.2, side: 0.5 };
vi.mock('./ContactPictureCrop', () => ({
  ContactPictureCrop: ({ onUse, onCancel, title, hint }: { onUse: (c: typeof CROP) => void; onCancel: () => void; title?: string; hint?: string }) => (
    <div role="dialog" aria-label="crop stub">
      <h2>{title}</h2>
      <p>{hint}</p>
      <button onClick={() => onUse(CROP)}>Use this picture</button>
      <button onClick={onCancel}>Cancel crop</button>
    </div>
  ),
}));

const PNG_3x2 = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR4nGM8wcXFwMDAwMDAxAADABByAOAp6i43AAAAAElFTkSuQmCC';
const GIF = 'R0lGODdhAwACAIEAAMgKCgAAAAAAAAAAACwAAAAAAwACAAAIBgABCBwYEAA7';
const bytesOf = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const png = () => new File([bytesOf(PNG_3x2)], 'me.png', { type: 'image/png' });
const gif = () => new File([bytesOf(GIF)], 'me.gif', { type: 'image/gif' });

function setup(over: Partial<ImageRowProps> = {}) {
  const props: ImageRowProps = {
    url: '', isSignetHosted: false, showPreview: false, uploading: false, hostname: '',
    onPick: vi.fn(), onPickError: vi.fn(), onPasteUrl: vi.fn(), onShowPreview: vi.fn(), onRemove: vi.fn(), disabled: false,
    ...over,
  };
  const view = render(<ImageRow {...props} />);
  const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
  return { ...props, input, ...view };
}

describe('ImageRow', () => {
  it('picture: pick -> crop screen (persona wording) -> onPick gets the file AND the crop', async () => {
    const { input, onPick } = setup();
    const file = png();
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByRole('dialog', { name: 'crop stub' })).toBeDefined();
    expect(screen.getByText(CROP_TITLE)).toBeDefined();
    expect(screen.getByText(PERSONA_CROP_HINT)).toBeDefined();
    expect(PERSONA_CROP_HINT).toBe('Move and zoom until your face or logo sits in the circle. The square is what gets saved.');
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use this picture' }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(file, CROP);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('picture: cancelling the crop sends nothing', async () => {
    const { input, onPick } = setup();
    fireEvent.change(input, { target: { files: [png()] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel crop' }));
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('picture: a file the header gate refuses never opens the crop screen', async () => {
    const { input, onPick, onPickError } = setup();
    fireEvent.change(input, { target: { files: [gif()] } });
    await waitFor(() => expect(onPickError).toHaveBeenCalledWith(OWN_PICTURE_REFUSED_COPY));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('banner: no crop, the file goes straight through', () => {
    const { input, onPick } = setup({ aspect: 'wide' });
    const file = png();
    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(file, undefined);
  });
});
