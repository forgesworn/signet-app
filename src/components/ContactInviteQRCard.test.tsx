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
const invite = (key: string, name: string, caption?: string) => createStoredContactInvite({ identityPubkey: key, name, relays: ['wss://example.test'], mode: 'standing', now: 100, caption });
const vault = (rows: ReturnType<typeof invite>[], arrivals: unknown[] = []) => ({ v: 1 as const, directoryId: 'owner', invites: rows, arrivals, exchanges: [], outbox: [] });
const resolved = (key: string, set = true): ResolvedIdentity => ({ displayName: 'Alice', displayNameIsSet: set, publicKey: key, type: 'Persona', isDependant: false });
const renderPublicCard = (slots?: QRCardSlots): ReactNode => <div><p>Public key card</p>{slots?.tabs}{slots?.footer}</div>;
const asService = (s: unknown) => s as ContactInviteService;
const base = { relays: [], version: 0, renderPublicCard, onManage() {}, locked: false, onRequestUnlock() {} };
const tabButton = (name: string) => screen.getAllByRole('button', { name }).find(b => b.getAttribute('aria-pressed') !== null)!;

beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });
afterEach(() => vi.restoreAllMocks());

describe('carousel contact invite card', () => {
  it('shows only active standing invites for this identity, never their private name in the QR', async () => {
    const rows = [invite(B, 'Other persona', 'Alice'), { ...invite(A, 'Off', 'Alice'), enabled: false },
      { ...invite(A, 'Expired', 'Alice'), invite: { ...invite(A, 'Expired', 'Alice').invite, expiresAt: 200 } },
      { ...invite(A, 'Single', 'Alice'), mode: 'single-use' as const }, invite(A, 'Private conference', 'Alice')];
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
    const read = vi.fn().mockResolvedValueOnce(vault([invite(A, 'Alice', 'Alice')])).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const service = asService({ read, create: vi.fn(() => new Promise(() => {})) });
    const view = render(<ContactInviteQRCard {...base} service={service} identityPubkey={A} resolved={resolved(A)} />);
    await screen.findByTestId('qr');
    view.rerender(<ContactInviteQRCard {...base} service={service} identityPubkey={B} resolved={resolved(B)} />);
    expect(screen.queryByTestId('qr')).toBeNull();
    await act(async () => finish(vault([invite(B, 'Bob', 'Alice')])));
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
    const service = asService({ read: vi.fn(async () => vault([invite(A, 'Alice', 'Alice')])), create: vi.fn() });
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
    expect(create).toHaveBeenCalledWith(A, 'My contact card', [], 'standing', expect.any(Number), undefined, 'Alice');
    view.rerender(<ContactInviteQRCard {...base} service={service} identityPubkey={A} resolved={resolved(A)} version={1} />);
    await act(async () => { await Promise.resolve(); });
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => created(invite(A, 'My contact card', 'Alice')));
    expect(parseContactInviteLink((await screen.findByTestId('qr')).textContent!, 101)?.recipient).toBe(A);
  });

  it('reports a failed setup and retries only on request', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce(invite(A, 'My contact card', 'Alice'));
    const service = asService({ read: vi.fn(async () => vault([])), create });
    render(<ContactInviteQRCard {...base} service={service} identityPubkey={A} resolved={resolved(A)} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not set up your invite.');
    expect(create).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('qr');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('reports a read error while unlocked', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(vault([invite(A, 'Alice', 'Alice')]));
    render(<ContactInviteQRCard {...base} service={asService({ read, create: vi.fn() })} identityPubkey={A} resolved={resolved(A)} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load your invite.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('qr');
  });

  it('shows an invite select only with two or more live standing invites', async () => {
    const service = asService({ read: vi.fn(async () => vault([invite(A, 'First', 'Alice'), invite(A, 'Second', 'Alice')])), create: vi.fn() });
    render(<ContactInviteQRCard {...base} service={service} identityPubkey={A} resolved={resolved(A)} />);
    expect(await screen.findByRole('combobox', { name: /Invite/ })).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByText('Only you see invite names.')).toBeTruthy();
  });

  it('shows the waiting-request count with the same rule as the Invites page', async () => {
    const arrival = (over: Record<string, unknown>) => ({ id: Math.random().toString(), inviteId: 'x', identityPubkey: A, ...over });
    const onManage = vi.fn();
    const service = asService({ read: vi.fn(async () => vault([invite(A, 'Alice', 'Alice')], [
      arrival({}), arrival({}), arrival({ dismissedAt: 5 }), arrival({ channel: 'exchange' }), arrival({ identityPubkey: B }),
    ])), create: vi.fn() });
    render(<ContactInviteQRCard {...base} onManage={onManage} service={service} identityPubkey={A} resolved={resolved(A)} />);
    const row = await screen.findByRole('button', { name: /2 requests waiting/ });
    fireEvent.click(row);
    expect(onManage).toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: 'Manage invites' }).length).toBeGreaterThan(0);
  });

  it('remembers the tab per persona', async () => {
    const service = asService({ read: vi.fn(async () => vault([invite(A, 'Alice', 'Alice')])), create: vi.fn() });
    render(<ContactInviteQRCard {...base} service={service} identityPubkey={A} resolved={resolved(A)} />);
    await screen.findByTestId('qr');
    fireEvent.click(tabButton('Nostr npub'));
    expect(localStorage.getItem(`signet:qr-tab:${A}`)).toBe('npub');
    expect(screen.queryByTestId('qr')).toBeNull();
  });

  describe('"They\'ll see" name chip', () => {
    const read = (rows: ReturnType<typeof invite>[]) => asService({ read: vi.fn(async () => vault(rows)), create: vi.fn(async () => invite(A, 'My contact card', 'Alice')) });
    it('defaults on: shows the captioned invite and says what they will see', async () => {
      const rows = [invite(A, 'Plain'), invite(A, 'Named', 'Alice')];
      render(<ContactInviteQRCard {...base} service={read(rows)} identityPubkey={A} resolved={resolved(A)} />);
      const qr = await screen.findByTestId('qr');
      expect(parseContactInviteLink(qr.textContent!, 101)?.caption).toBe('Alice');
      expect(screen.getByText('Your name (Alice) and your npub')).toBeTruthy();
      expect(screen.getByRole('button', { name: /Your name/ }).getAttribute('aria-pressed')).toBe('true');
      expect(screen.queryByRole('combobox')).toBeNull(); // only matching invites count
    });
    it('off: shows the uncaptioned invite, remembers the choice per persona', async () => {
      const rows = [invite(A, 'Plain'), invite(A, 'Named', 'Alice')];
      render(<ContactInviteQRCard {...base} service={read(rows)} identityPubkey={A} resolved={resolved(A)} />);
      await screen.findByTestId('qr');
      fireEvent.click(screen.getByRole('button', { name: /Your name/ }));
      expect(parseContactInviteLink(screen.getByTestId('qr').textContent!, 101)?.caption).toBeUndefined();
      expect(screen.getByText('Your npub only')).toBeTruthy();
      expect(localStorage.getItem(`signet:qr-share-name:${A}`)).toBe('0');
    });
    it('starts off when remembered off, and creates an uncaptioned invite once if none exists', async () => {
      try { localStorage.setItem(`signet:qr-share-name:${A}`, '0'); } catch { /* ignore */ }
      const create = vi.fn(async () => invite(A, 'My contact card'));
      const service = asService({ read: vi.fn(async () => vault([invite(A, 'Named', 'Alice')])), create });
      render(<ContactInviteQRCard {...base} service={service} identityPubkey={A} resolved={resolved(A)} />);
      await screen.findByTestId('qr');
      expect(create).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith(A, 'My contact card', [], 'standing', expect.any(Number), undefined, undefined);
      expect(parseContactInviteLink(screen.getByTestId('qr').textContent!, 101)?.caption).toBeUndefined();
    });
    it('turning the chip on creates a captioned invite once when none matches', async () => {
      const create = vi.fn(async () => invite(A, 'My contact card', 'Alice'));
      const service = asService({ read: vi.fn(async () => vault([invite(A, 'Plain')])), create });
      try { localStorage.setItem(`signet:qr-share-name:${A}`, '0'); } catch { /* ignore */ }
      render(<ContactInviteQRCard {...base} service={service} identityPubkey={A} resolved={resolved(A)} />);
      await screen.findByTestId('qr');
      expect(create).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: /Your name/ }));
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect(create).toHaveBeenCalledWith(A, 'My contact card', [], 'standing', expect.any(Number), undefined, 'Alice');
      await waitFor(() => expect(parseContactInviteLink(screen.getByTestId('qr').textContent!, 101)?.caption).toBe('Alice'));
    });
    it('has no chip and says npub only when the name is not set', async () => {
      render(<ContactInviteQRCard {...base} service={read([invite(A, 'Plain')])} identityPubkey={A} resolved={resolved(A, false)} />);
      await screen.findByTestId('qr');
      expect(screen.queryByRole('button', { name: /Your name/ })).toBeNull();
      expect(screen.getByText('Your npub only')).toBeTruthy();
    });
  });

  it('while locked, Manage invites asks to unlock instead of opening the invites page', () => {
    const onManage = vi.fn(), onRequestUnlock = vi.fn();
    render(<ContactInviteQRCard {...base} service={asService({ read: vi.fn() })} identityPubkey={A} resolved={resolved(A)} locked onManage={onManage} onRequestUnlock={onRequestUnlock} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Manage invites' })[0]);
    expect(onManage).not.toHaveBeenCalled();
    expect(onRequestUnlock).toHaveBeenCalledTimes(1);
  });

  it('two mounts share one creation, and a matching invite made meanwhile is reused', async () => {
    const reads: ReturnType<typeof vault>[] = [vault([]), vault([]), vault([invite(A, 'Made elsewhere', 'Alice')])];
    let n = 0;
    const create = vi.fn(async () => { await Promise.resolve(); return invite(A, 'My contact card', 'Alice'); });
    const service = asService({ read: vi.fn(async () => reads[Math.min(n++, 2)]), create });
    render(<>
      <ContactInviteQRCard {...base} service={service} identityPubkey={A} resolved={resolved(A)} />
      <ContactInviteQRCard {...base} service={service} identityPubkey={A} resolved={resolved(A)} />
    </>);
    await waitFor(() => expect(screen.getAllByTestId('qr').length).toBeGreaterThan(0));
    await waitFor(() => expect(create.mock.calls.length).toBeLessThanOrEqual(1));
    expect(create.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('does not create when the vault already holds a matching invite at creation time', async () => {
    const { ensureStandingInvite } = await import('./ContactInviteQRCard');
    const existing = invite(A, 'Made elsewhere', 'Alice');
    const create = vi.fn();
    const service = asService({ read: vi.fn(async () => vault([existing])), create });
    expect(await ensureStandingInvite(service, A, [], 'Alice')).toBe(existing);
    expect(create).not.toHaveBeenCalled();
    const slow = asService({ read: vi.fn(async () => vault([])), create: vi.fn(async () => existing) });
    const [x, y] = await Promise.all([ensureStandingInvite(slow, A, [], 'Alice'), ensureStandingInvite(slow, A, [], 'Alice')]);
    expect(x).toBe(y);
    expect((slow as unknown as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledTimes(1);
  });
});
