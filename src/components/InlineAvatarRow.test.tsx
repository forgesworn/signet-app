// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InlineAvatarRow } from './SettingsCard';
import { OWN_PICTURE_REFUSED_COPY, PERSONA_CROP_HINT } from '../lib/contacts-v2-copy';

const CROP = { x: 0.1, y: 0.2, side: 0.5 };
vi.mock('./ContactPictureCrop', () => ({
  ContactPictureCrop: ({ onUse, onCancel, hint }: { onUse: (c: typeof CROP) => void; onCancel: () => void; hint?: string }) => (
    <div role="dialog" aria-label="crop stub">
      <p>{hint}</p>
      <button onClick={() => onUse(CROP)}>Use this picture</button>
      <button onClick={onCancel}>Cancel crop</button>
    </div>
  ),
}));

const PNG_3x2 = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR4nGM8wcXFwMDAwMDAxAADABByAOAp6i43AAAAAElFTkSuQmCC';
const GIF = 'R0lGODdhAwACAIEAAMgKCgAAAAAAAAAAACwAAAAAAwACAAAIBgABCBwYEAA7';
const bytesOf = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

function setup() {
  const onSet = vi.fn(async () => {});
  const view = render(<InlineAvatarRow hasAvatar={false} onSet={onSet} />);
  const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
  return { onSet, input, ...view };
}

describe('InlineAvatarRow (private avatar picker)', () => {
  it('pick -> crop screen -> onSet gets the file AND the crop', async () => {
    const { input, onSet } = setup();
    const file = new File([bytesOf(PNG_3x2)], 'me.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByRole('dialog', { name: 'crop stub' })).toBeDefined();
    expect(screen.getByText(PERSONA_CROP_HINT)).toBeDefined();
    expect(onSet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use this picture' }));
    await waitFor(() => expect(onSet).toHaveBeenCalledWith(file, CROP));
  });

  it('a file the header gate refuses shows the error in the row and never opens the crop screen', async () => {
    const { input, onSet } = setup();
    fireEvent.change(input, { target: { files: [new File([bytesOf(GIF)], 'me.gif', { type: 'image/gif' })] } });
    expect(await screen.findByText(OWN_PICTURE_REFUSED_COPY)).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onSet).not.toHaveBeenCalled();
  });

  it('cancelling the crop saves nothing', async () => {
    const { input, onSet } = setup();
    fireEvent.change(input, { target: { files: [new File([bytesOf(PNG_3x2)], 'me.png', { type: 'image/png' })] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel crop' }));
    expect(onSet).not.toHaveBeenCalled();
  });
});
