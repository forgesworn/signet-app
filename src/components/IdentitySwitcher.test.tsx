// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { IdentitySwitcher, switcherRowLabel } from './IdentitySwitcher';
import type { CarouselRow } from '../types';
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

  describe('blurIdentityNames', () => {
    const rows = [
      { type: 'persona', identity: { naturalPerson: { publicKey: 'a'.repeat(64), displayName: 'Alice Real' }, persona: { publicKey: 'b'.repeat(64), displayName: 'Sky Hawk' }, primaryKeypair: 'persona' } },
    ] as unknown as CarouselRow[];

    it('blurs each name and its initial when the preference is on', () => {
      const { container } = render(<IdentitySwitcher rows={rows} current={0} onPick={() => {}} onClose={() => {}} blurIdentityNames />);
      const name = container.querySelector('.identity-switcher-name') as HTMLElement;
      const avatar = container.querySelector('.identity-switcher-avatar') as HTMLElement;
      expect(name.textContent).toBeTruthy();
      expect(name.style.filter).toContain('blur');
      expect(avatar.style.filter).toContain('blur');
    });

    it('leaves names sharp when the preference is off', () => {
      const { container } = render(<IdentitySwitcher rows={rows} current={0} onPick={() => {}} onClose={() => {}} />);
      expect((container.querySelector('.identity-switcher-name') as HTMLElement).style.filter).toBe('');
    });

    it('never blurs the Add row label', () => {
      const addRows = [{ type: 'add' }] as unknown as CarouselRow[];
      const { container } = render(<IdentitySwitcher rows={addRows} current={0} onPick={() => {}} onClose={() => {}} blurIdentityNames />);
      expect((container.querySelector('.identity-switcher-name') as HTMLElement).style.filter).toBe('');
    });
  });

  describe('focus', () => {
    const personaRow = (name: string, key: string) => ({
      type: 'persona',
      identity: { naturalPerson: { publicKey: 'a'.repeat(64), displayName: '' }, persona: { publicKey: key.repeat(64), displayName: name }, primaryKeypair: 'persona' },
    });
    const rows = [personaRow('One', 'b'), personaRow('Two', 'c'), { type: 'add' }] as unknown as CarouselRow[];

    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>opener</button>
          {open && <IdentitySwitcher rows={rows} current={1} onPick={() => {}} onClose={() => setOpen(false)} />}
        </>
      );
    }

    it('moves focus to the current row on open', () => {
      const { getByText, container } = render(<Host />);
      const opener = getByText('opener');
      opener.focus();
      fireEvent.click(opener);
      const current = container.ownerDocument.querySelector('.identity-switcher-row.is-current');
      expect(current).not.toBeNull();
      expect(document.activeElement).toBe(current);
    });

    it('keeps Tab inside the sheet in both directions', () => {
      const { getByText } = render(<Host />);
      const opener = getByText('opener');
      opener.focus();
      fireEvent.click(opener);
      const close = document.querySelector('.identity-switcher-head button') as HTMLElement;
      const rowButtons = Array.from(document.querySelectorAll<HTMLElement>('.identity-switcher-row'));
      const last = rowButtons[rowButtons.length - 1];

      last.focus();
      fireEvent.keyDown(last, { key: 'Tab' });
      expect(document.activeElement).toBe(close);

      close.focus();
      fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(last);

      opener.focus();
      fireEvent.keyDown(document.querySelector('.identity-switcher-scrim')!, { key: 'Tab' });
      expect(document.activeElement).toBe(close);
    });

    it('gives focus back to the opener on close', () => {
      const { getByText } = render(<Host />);
      const opener = getByText('opener');
      opener.focus();
      fireEvent.click(opener);
      expect(document.activeElement).not.toBe(opener);

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(document.querySelector('.identity-switcher')).toBeNull();
      expect(document.activeElement).toBe(opener);
    });
  });

  describe('Add row label', () => {
    const add = { type: 'add' } as unknown as CarouselRow;

    it('offers a persona or a dependant on the top-level ring', () => {
      expect(switcherRowLabel(add).name).toBe('Add persona or dependant');
      expect(switcherRowLabel(add, 'guardian').name).toBe('Add persona or dependant');
    });

    it('offers only a persona inside a dependant\'s child mode', () => {
      expect(switcherRowLabel(add, 'child').name).toBe('Add persona');
    });

    it('does not promise an add on a paired-child install, where the card is informational', () => {
      const label = switcherRowLabel(add, 'paired-child');
      expect(label.name).toBe('Personas are managed for you');
      expect(label.name).not.toMatch(/^Add/);
    });

    it('renders the label for the surface it is given', () => {
      const { container } = render(<IdentitySwitcher rows={[add]} current={0} onPick={() => {}} onClose={() => {}} surface="child" />);
      expect(container.querySelector('.identity-switcher-name')!.textContent).toBe('Add persona');
    });
  });
});
