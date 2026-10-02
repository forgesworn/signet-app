// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QRCard } from './QRCard';
import type { ResolvedIdentity } from '../lib/carousel-utils';
import { encodeNpub, hexToBytes } from '../lib/signet';
vi.mock('./QRCode', () => ({ QRCode: ({ data }: { data: string }) => <output data-testid="qr">{data}</output> }));
const KEY = 'a'.repeat(64);
const resolved: ResolvedIdentity = {
  displayName: 'Alice', displayNameIsSet: true, publicKey: KEY, type: 'Persona', isDependant: false, slotTarget: 'persona',
  avatarHash: 'h', avatarBlossomUrl: 'https://blossom.example', avatarKey: 'k',
};
describe('QRCard (pure npub)', () => {
  it('always shows the bare npub with no options, even with a name and a private avatar', () => {
    render(<QRCard resolved={resolved} badge={null} tabs={<div>tabs</div>} footer={<div>foot</div>} />);
    expect(screen.getByTestId('qr').textContent).toBe(encodeNpub(hexToBytes(KEY)));
    expect(screen.getByText('Works in any Nostr app.')).toBeTruthy();
    expect(screen.getByText('tabs')).toBeTruthy();
    expect(screen.getByText('foot')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/Only MySignet/)).toBeNull();
    expect(screen.queryByText(/Add my name|Share avatar/)).toBeNull();
  });
});
