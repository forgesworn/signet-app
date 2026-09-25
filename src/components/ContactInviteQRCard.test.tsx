// @vitest-environment jsdom
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContactInviteQRCard } from './ContactInviteQRCard';
import type { ContactInviteService } from '../lib/contact-invite-service';
import { createStoredContactInvite } from '../lib/contact-invite-store';
import { parseContactInviteLink } from '../lib/contact-invite-link';
vi.mock('./QRCode', () => ({ QRCode: ({ data }: { data: string }) => <output data-testid="qr">{data}</output> }));
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const invite = (key: string, name: string) => createStoredContactInvite({ identityPubkey: key, name, relays: ['wss://example.test'], mode: 'standing', now: 100 });
const vault = (rows: ReturnType<typeof invite>[]) => ({ v: 1 as const, directoryId: 'owner', invites: rows, arrivals: [], exchanges: [], outbox: [] });
describe('carousel contact invite', () => {
  it('shows only active standing invites for this identity, never their private name in the QR', async () => {
    const rows = [invite(B, 'Other persona'), { ...invite(A, 'Off'), enabled: false },
      { ...invite(A, 'Expired'), invite: { ...invite(A, 'Expired').invite, expiresAt: 200 } },
      { ...invite(A, 'Single'), mode: 'single-use' as const }, invite(A, 'Private conference')];
    const service = { read: vi.fn(async () => vault(rows)) } as unknown as ContactInviteService;
    render(<ContactInviteQRCard service={service} identityPubkey={A} name="Alice" relays={[]} version={0} publicCard={<p>Public key</p>} onManage={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    const link = screen.getByTestId('qr').textContent!;
    expect(link).not.toContain('Private conference');
    expect(parseContactInviteLink(link, 101)?.recipient).toBe(A);
    fireEvent.click(screen.getByRole('button', { name: 'Show public key instead' }));
    expect(screen.getByText('Public key')).toBeTruthy();
    expect(screen.queryByTestId('qr')).toBeNull();
  });
  it('clears the previous identity QR immediately while a new identity is loading', async () => {
    let finish!: (value: ReturnType<typeof vault>) => void;
    const read = vi.fn().mockResolvedValueOnce(vault([invite(A, 'Alice')])).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const service = { read } as unknown as ContactInviteService;
    const props = { service, name: 'Person', relays: [], version: 0, publicCard: null, onManage() {} };
    const view = render(<ContactInviteQRCard {...props} identityPubkey={A} />);
    await screen.findByTestId('qr');
    view.rerender(<ContactInviteQRCard {...props} identityPubkey={B} />);
    expect(screen.queryByTestId('qr')).toBeNull();
    await act(async () => finish(vault([invite(B, 'Bob')])));
    expect(parseContactInviteLink(screen.getByTestId('qr').textContent!, 101)?.recipient).toBe(B);
  });
});
