// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { CardBackdropRow } from './CardBackdropRow';
import { ImageRow } from './ImageRow';
import { IdentityCard } from './IdentityCard';
import { clearPickerGrace, pickerGraceOnHide } from '../lib/picker-grace';

// Each file input the user can reach while unlocked arms the picker grace as
// it opens the system picker; without it the hide that picker causes locks
// the app and the pick lands on a detached node.

describe('file inputs arm the picker grace', () => {
  afterEach(() => { cleanup(); clearPickerGrace(); });

  it('the card backdrop row', () => {
    const { getByText } = render(<CardBackdropRow pubkey={'a'.repeat(64)} />);
    expect(pickerGraceOnHide()).toBe(false);
    fireEvent.click(getByText('Set'));
    expect(pickerGraceOnHide()).toBe(true);
  });

  it('the image row', () => {
    const { container } = render(
      <ImageRow url="" isSignetHosted={false} showPreview={false} uploading={false} hostname=""
        onPick={vi.fn()} onPickError={vi.fn()} onPasteUrl={vi.fn()} onShowPreview={vi.fn()} onRemove={vi.fn()} disabled={false} />,
    );
    fireEvent.click(container.querySelector('input[type="file"]')!);
    expect(pickerGraceOnHide()).toBe(true);
  });

  it('the backdrop button on the identity card', () => {
    const row = { type: 'persona', identity: { naturalPerson: { publicKey: 'a'.repeat(64) }, persona: { publicKey: 'b'.repeat(64) }, primaryKeypair: 'persona' } } as never;
    const resolved = { displayName: 'Sky', displayNameIsSet: true, publicKey: 'b'.repeat(64), type: 'Persona', isDependant: false } as never;
    const { getByLabelText } = render(<IdentityCard row={row} resolved={resolved} childMode={false} />);
    fireEvent.click(getByLabelText('Customise card backdrop'));
    expect(pickerGraceOnHide()).toBe(true);
  });
});
