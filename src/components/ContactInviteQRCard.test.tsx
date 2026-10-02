// @vitest-environment jsdom
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ContactInviteQRCard } from './ContactInviteQRCard';
import type { ContactInviteService } from '../lib/contact-invite-service';
import { createStoredContactInvite } from '../lib/contact-invite-store';
import { parseContactInviteLink } from '../lib/contact-invite-link';
import type { ResolvedIdentity } from '../lib/carousel-utils';
import type { QRCardSlots } from './QRCard';
vi.mock('./QRCode', () => ({ QRCode: ({ data }: { data: string }) => <output data-testid="qr">{data}</output> }));
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const invite = (key: string, name: string) => createStoredContactInvite({ identityPubkey: key, name, relays: ['wss://example.test'], mode: 'standing', now: 100 });
const vault = (rows: ReturnType<typeof invite>[], arrivals: unknown[] = []) => ({ v: 1 as const, directoryId: 'owner', invites: rows, arrivals, exchanges: [], outbox: [] });
const resolved = (key: string): ResolvedIdentity => ({ displayName: 'Alice', displayNameIsSet: true, publicKey: key, type: 'Persona', isDependant: false });
const renderPublicCard = (slots?: QRCardSlots): ReactNode => <div><p>Public key card</p>{slots?.tabs}{slots?.footer}</div>;
const asService = (s: unknown) => s as ContactInviteService;
const base = { relays: [], version: 0, renderPublicCard, onManage() {}, locked: false, onRequestUnlock() {} };
const tabButton = (name: string) => screen.getAllByRole('button', { name }).find(b => b.getAttribute('aria-pressed') !== null)!;

beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });
afterEach(() => vi.restoreAllMocks());

describe('carousel contact invite card', () => {
  it('shows only active standing invites for this identity, never their private name in the QR', async () => {
    const rows = [invite(B, 'Other persona'), { ...invite(A, 'Off'), enabled: false },
      { ...invite(A, 'Expired'), invite: { ...invite(A, 'Expired').invite, expiresAt: 200 } },
      { ...invite(A, 'Single'), mode: 'single-use' as const }, invite(A, 'Private conference')];
    const service = asService({ read: vi.fn(async () => vault(rows)), create: vi.fn() });
    render(<ContactInviteQRCard {...base} service={service} identityPubkey={A} resolved={resolved(A)} />);
    const qr = await screen.findByTestId('qr');
    expect(screen.queryByRole('combobox')).toBeNull(); // one live invite: no select
    expect(qr.textContent).not.toContain('Private conference');
    expect(parseContactInviteLink(qr.textContent!, 101)?.recipient).toBe(A);
    expect((service as unknown as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
  });

  it('clears the previous identity QR immediately while a new identity is loading', async () => {
    let finish!: (value: ReturnType<typeof vault>) => void;
    const read = vi.fn().mockResolvedValueOnce(vault([invite(A, 'Alice')])).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const service = asService({ read, create: vi.fn(() => new Promise(() => {})) });
    const view = render(<ContactInviteQRCard {...base} service={service} identityPubkey={A} resolved={resolved(A)} />);
    await screen.findByTestId('qr');
    view.rerender(<ContactInviteQRCard {...base} service={service} identityPubkey={B} resolved={resolved(B)} />);
    expect(screen.queryByTestId('qr')).toBeNull();
    await act(async () => finish(vault([invite(B, 'Bob')])));
    expect(parseContactInviteLink(screen.getByTestId('qr').textContent!, 101)?.recipient).toBe(B);
  });

  it('while locked: shows the npub tab, never reads the vault, and offers Unlock', () => {
    const read = vi.fn();
    const onRequestUnlock = vi.fn();
    try { localStorage.setItem(`signet:qr-tab:${A}`, 'mysignet'); } catch { /* ignore */ }
    render(<ContactInviteQRCard {...base} service={asService({ read })} identityPubkey={A} resolved={resolved(A)} locked onRequestUnlock={onRequestUnlock} />);
    expect(screen.getByText('Public key card')).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryByTestId('qr')).toBeNull();
    expect(screen.getByText('Unlock for your MySignet invite')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(onRequestUnlock).toHaveBeenCalledTimes(1);
    fireEvent.click(tabButton('MySignet'));
    expect(onRequestUnlock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('returns to the remembered tab once unlocked', async () => {
    const service = asService({ read: vi.fn(async () => vault([invite(A, 'Alice')])), create: vi.fn() });
    const view = render(<ContactInviteQRCard {...base} service={service} identityPubkey={A} resolved={resolved(A)} locked />);
    expect(screen.queryByTestId('qr')).toBeNull();
    view.rerender(<ContactInviteQRCard {...base} service={service} identityPubkey={A} resolved={resolved(A)} locked={false} />);
    await screen.findByTestId('qr');
  });

  it('creates a standing invite once when there is none, and shows progress meanwhile', async () => {
    let created!: (row: ReturnType<typeof invite>) => void;
    const create = vi.fn(() => new Promise<ReturnType<typeof invite>>(resolve => { created = resolve; }));
    const service = asService({ read: vi.fn(async () => vault([])), create });
    const view = render(<ContactInviteQRCard {...base} service={service} identityPubkey={A} resolved={resolved(A)} />);
    await screen.findByText('Setting up your invite…');
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith(A, 'My contact card', [], 'standing', expect.any(Number));
    view.rerender(<ContactInviteQRCard {...base} service={service} identityPubkey={A} resolved={resolved(A)} version={1} />);
    await act(async () => { await Promise.resolve(); });
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => created(invite(A, 'My contact card')));
    expect(parseContactInviteLink((await screen.findByTestId('qr')).textContent!, 101)?.recipient).toBe(A);
  });

  it('reports a failed setup and retries only on request', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce(invite(A, 'My contact card'));
    const service = asService({ read: vi.fn(async () => vault([])), create });
    render(<ContactInviteQRCard {...base} service={service} identityPubkey={A} resolved={resolved(A)} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not set up your invite.');
    expect(create).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('qr');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('reports a read error while unlocked', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(vault([invite(A, 'Alice')]));
    render(<ContactInviteQRCard {...base} service={asService({ read, create: vi.fn() })} identityPubkey={A} resolved={resolved(A)} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load your invite.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('qr');
  });

  it('shows an invite select only with two or more live standing invites', async () => {
    const service = asService({ read: vi.fn(async () => vault([invite(A, 'First'), invite(A, 'Second')])), create: vi.fn() });
    render(<ContactInviteQRCard {...base} service={service} identityPubkey={A} resolved={resolved(A)} />);
    expect(await screen.findByRole('combobox', { name: /Invite/ })).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByText('Only you see invite names.')).toBeTruthy();
  });

  it('shows the waiting-request count with the same rule as the Invites page', async () => {
    const arrival = (over: Record<string, unknown>) => ({ id: Math.random().toString(), inviteId: 'x', identityPubkey: A, ...over });
    const onManage = vi.fn();
    const service = asService({ read: vi.fn(async () => vault([invite(A, 'Alice')], [
      arrival({}), arrival({}), arrival({ dismissedAt: 5 }), arrival({ channel: 'exchange' }), arrival({ identityPubkey: B }),
    ])), create: vi.fn() });
    render(<ContactInviteQRCard {...base} onManage={onManage} service={service} identityPubkey={A} resolved={resolved(A)} />);
    const row = await screen.findByRole('button', { name: /2 requests waiting/ });
    fireEvent.click(row);
    expect(onManage).toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: 'Manage invites' }).length).toBeGreaterThan(0);
  });

  it('remembers the tab per persona', async () => {
    const service = asService({ read: vi.fn(async () => vault([invite(A, 'Alice')])), create: vi.fn() });
    render(<ContactInviteQRCard {...base} service={service} identityPubkey={A} resolved={resolved(A)} />);
    await screen.findByTestId('qr');
    fireEvent.click(tabButton('Nostr npub'));
    expect(localStorage.getItem(`signet:qr-tab:${A}`)).toBe('npub');
    expect(screen.queryByTestId('qr')).toBeNull();
  });
});
