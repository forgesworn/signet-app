// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QRCard } from './QRCard';
import type { ResolvedIdentity } from '../lib/carousel-utils';
import { encodeNpub, hexToBytes } from '../lib/signet';
vi.mock('./QRCode', () => ({ QRCode: ({ data }: { data: string }) => <output data-testid="qr">{data}</output> }));
const KEY = 'a'.repeat(64);
const resolved: ResolvedIdentity = { displayName: 'Alice', displayNameIsSet: true, publicKey: KEY, type: 'Persona', isDependant: false, slotTarget: 'persona' };
describe('QRCard', () => {
  it('defaults to the bare npub and says it works anywhere', () => {
    render(<QRCard resolved={resolved} badge={null} tabs={<div>tabs</div>} />);
    expect(screen.getByTestId('qr').textContent).toBe(encodeNpub(hexToBytes(KEY)));
    expect(screen.getByText('Works in any Nostr app.')).toBeTruthy();
    expect(screen.getByText('tabs')).toBeTruthy();
    expect(screen.queryByText('Tap to choose what your QR shares')).toBeNull();
  });
  it('adding the name switches to the MySignet-only version', () => {
    render(<QRCard resolved={resolved} badge={null} />);
    expect(screen.getByText('Tap to choose what your QR shares')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add my name' }));
    expect(screen.getByText('Only MySignet can read this version.')).toBeTruthy();
    expect(screen.getByTestId('qr').textContent).toContain('signet-contact');
  });
});
