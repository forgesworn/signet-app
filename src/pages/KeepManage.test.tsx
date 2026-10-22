// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { getPublicKey } from 'nostr-tools/pure';
import { unwrapEvent } from 'nostr-tools/nip59';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';
import type { EffectiveContact } from '../types';

let row: unknown = null;
vi.mock('../lib/db', () => ({
  loadKeepsRow: async () => (row === null ? null : JSON.parse(JSON.stringify(row))),
  saveKeepsRow: async (value: unknown) => { row = JSON.parse(JSON.stringify(value)); },
}));
vi.mock('../lib/relay-service', () => ({
  fetchEventsWithReach: vi.fn(async () => ({ events: [], attempted: 1, reached: 1 })),
  subscribeEvents: vi.fn(() => () => undefined),
}));
const published: NostrEvent[] = [];
vi.mock('../lib/relay-publish', async () => {
  const actual = await vi.importActual<typeof import('../lib/relay-publish')>('../lib/relay-publish');
  return { ...actual, publishWrappedToRelays: async (wrap: NostrEvent, relays: readonly string[]) => { published.push(wrap); return relays.map(() => true); } };
});

import { MyKeep } from './MyKeep';
import { LocalSigningBackend } from '../lib/signing-backend';
import type { KeepHost } from './KeepManage';

const KEEP_SK = hexToBytes('0'.repeat(63) + '1');
const K = getPublicKey(KEEP_SK);
const OWNER_HEX = '0'.repeat(63) + '2';
const O = getPublicKey(hexToBytes(OWNER_HEX));
const FRIEND = getPublicKey(hexToBytes('0'.repeat(63) + '3'));
const CODE = '33'.repeat(16);
const LINK = `signet-keep:pair?k=${K}&c=${CODE}&n=Kitchen%20Keep&r=wss%3A%2F%2Frelay.example.com`;

const contact = (id: string, name: string, tier: 'kin' | 'kith' | 'ken', pubkey: string): EffectiveContact => ({
  directoryId: 'owner', contactId: id, type: 'person', displayName: name, tier, roles: [],
  identities: [{ itemId: 'i' + id, pubkey, provenance: 'direct', verification: 'proven', addedAt: 1 }],
  contactMethods: [], accessGrants: [], lifecycle: 'active', createdAt: 1, updatedAt: 1,
  createdByActorRole: 'owner', createdByOperationId: 'o', vouches: [], ceilings: [], blocks: [],
  listMemberships: [{ ownerIdentityPubkey: O, addedAt: 1 }], effectiveTier: tier, tierSource: 'direct', blocked: false, blockedBy: [],
});

function host(over: Partial<KeepHost> = {}): KeepHost {
  return {
    deps: { encryptionKey: 'key', backendFor: p => (p === O ? new LocalSigningBackend(OWNER_HEX) : null) },
    canSign: p => p === O,
    activePersona: { pubkey: O, name: 'Anon' },
    personaNames: { [O]: 'Anon' },
    contacts: [contact('1', 'Dave', 'kin', FRIEND), contact('2', 'Kenny', 'ken', 'ee'.repeat(32))],
    confirmClaim: vi.fn(async () => true),
    ...over,
  };
}

const pairedKeep = (over: object = {}) => ({
  keep: K, name: 'Kitchen Keep', relays: ['wss://relay.example.com'], claimedBy: O, personas: [O],
  status: 'paired', claimedAt: 1, invites: [], ...over,
});

const share = vi.fn();
beforeEach(() => {
  row = null; published.length = 0; share.mockReset(); share.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'share', { value: share, configurable: true });
  window.scrollTo = vi.fn() as never;
  localStorage.clear();
});
afterEach(cleanup);

const renderKeep = (h: KeepHost | undefined = host()) => render(<MyKeep ownedPubkeys={[O]} scope="id1" onBack={vi.fn()} keepHost={h} />);
const lastRumor = () => unwrapEvent(published[published.length - 1] as never, KEEP_SK);

describe('Add a Keep', () => {
  it('pastes the link, asks "Make <name> your Keep?", confirms, sends the claim and waits', async () => {
    const h = host();
    renderKeep(h);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a Keep' }));
    fireEvent.change(screen.getByLabelText('Keep link'), { target: { value: LINK } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Make Kitchen Keep your Keep?')).toBeInTheDocument();
    expect(screen.getByText('Anon')).toBeInTheDocument();
    expect(published).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Make it my Keep' }));
    await screen.findByText('Waiting for the Keep');
    expect(h.confirmClaim).toHaveBeenCalledWith('Kitchen Keep', 'Anon');
    expect(published).toHaveLength(1);
    expect(lastRumor().tags).toEqual([['keep', K], ['code', CODE]]);
    expect(screen.getByText('Owned by Anon')).toBeInTheDocument();
  });

  it('adding a stored Keep again with a new link pairs it again and waits for the Keep', async () => {
    row = [pairedKeep({ invites: [{ grant: '11'.repeat(16), secret: '22'.repeat(32), kind: 'guest', createdAt: 1, expiration: 2e9, status: 'active' }] })];
    renderKeep();
    fireEvent.click(await screen.findByRole('button', { name: 'Add a Keep' }));
    fireEvent.change(screen.getByLabelText('Keep link'), { target: { value: LINK } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make it my Keep' }));
    expect((await screen.findAllByText(/Waiting for the Keep/)).length).toBeGreaterThan(0);
    expect(lastRumor().tags).toEqual([['keep', K], ['code', CODE]]);
    expect((row as Array<{ invites: unknown[] }>)[0].invites).toHaveLength(1);
  });

  it('says so when the link is not a Keep link', async () => {
    renderKeep();
    fireEvent.click(await screen.findByRole('button', { name: 'Add a Keep' }));
    fireEvent.change(screen.getByLabelText('Keep link'), { target: { value: 'https://example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent('not a Keep link');
  });

  it('sends nothing when the PIN check is declined', async () => {
    renderKeep(host({ confirmClaim: vi.fn(async () => false) }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add a Keep' }));
    fireEvent.change(screen.getByLabelText('Keep link'), { target: { value: LINK } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make it my Keep' }));
    await screen.findByText(/Nothing was sent/);
    expect(published).toHaveLength(0);
    expect(row).toBeNull();
  });

  it('a persona without a local key sees "Not available for this persona yet." and no confirm button', async () => {
    renderKeep(host({ canSign: () => false }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add a Keep' }));
    fireEvent.change(screen.getByLabelText('Keep link'), { target: { value: LINK } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Not available for this persona yet.');
    expect(screen.getByRole('button', { name: 'Make it my Keep' })).toBeDisabled();
  });
});

describe('an unreadable saved list', () => {
  it('says so plainly, offers no Add a Keep, and leaves the row alone', async () => {
    row = [pairedKeep({ status: 'some-future-status' })];
    const before = JSON.stringify(row);
    renderKeep();
    expect(await screen.findByTestId('keeps-unreadable')).toHaveTextContent(/could not be read/);
    expect(screen.queryByRole('button', { name: 'Add a Keep' })).toBeNull();
    expect(JSON.stringify(row)).toBe(before);
  });
});

describe('a claimed Keep', () => {
  it('is listed in the account-level list with the persona it belongs to', async () => {
    row = [pairedKeep()];
    renderKeep();
    const rowEl = await screen.findByTestId('stored-keep-row');
    expect(rowEl).toHaveTextContent('Kitchen Keep');
    expect(rowEl).toHaveTextContent('Connected');
    expect(rowEl).toHaveTextContent('Owned by Anon');
  });

  it('puts everything under a Games heading and builds nothing else', async () => {
    row = [pairedKeep()];
    renderKeep();
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    expect(await screen.findByRole('heading', { name: 'Games' })).toBeInTheDocument();
    expect(screen.queryByText(/backup/i)).toBeNull();
    expect(screen.getByText('Who can play')).toBeInTheDocument();
  });

  it('Invite a friend lists Kin and Kith only, sends the invite, opens the share sheet with the stampede link', async () => {
    row = [pairedKeep()];
    renderKeep();
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    fireEvent.click(await screen.findByRole('button', { name: 'Invite a friend' }));
    const options = screen.getAllByTestId('contact-option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Dave');
    expect(screen.queryByText('Kenny')).toBeNull();
    fireEvent.click(options[0]);
    await waitFor(() => expect(published).toHaveLength(1));
    const rumor = lastRumor();
    const tag = (n: string) => rumor.tags.find(t => t[0] === n)!;
    expect(rumor.kind).toBe(27661);
    expect(tag('p')[1]).toBe(FRIEND);
    expect(tag('name')[1]).toBe('Dave');
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share).toHaveBeenCalledWith({ text: `stampede://keep/${K}/${tag('secret')[1]}` });
    const invite = await screen.findByTestId('invite-row');
    expect(invite).toHaveTextContent('Dave');
    expect(invite).toHaveTextContent('Waiting for the Keep');
    expect(invite).toHaveTextContent(/Expires/);
    // The secret is never on the screen.
    expect(document.body.textContent).not.toContain(tag('secret')[1]);
  });

  it('Guest pass sends a guest invite and shares the link', async () => {
    row = [pairedKeep()];
    renderKeep();
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    fireEvent.click(await screen.findByRole('button', { name: 'Guest pass' }));
    await waitFor(() => expect(published).toHaveLength(1));
    expect(lastRumor().tags).toContainEqual(['guest']);
    await waitFor(() => expect(share).toHaveBeenCalled());
    expect((await screen.findByTestId('invite-row'))).toHaveTextContent('Guest pass');
  });

  it('copies the link when there is no share sheet', async () => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    row = [pairedKeep()];
    renderKeep();
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    fireEvent.click(await screen.findByRole('button', { name: 'Guest pass' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^stampede://keep/${K}/[0-9a-f]{64}$`))));
    expect(await screen.findByText('Link copied.')).toBeInTheDocument();
  });

  it('shows Active, Refused (reason) and Revoked, and Revoke sends the revoke', async () => {
    const mk = (n: number, o: object) => ({
      grant: n.toString(16).padStart(2, '0').repeat(16), secret: 'aa'.repeat(32), kind: 'guest', label: 'Guest pass',
      createdAt: 100 + n, expiration: Math.floor(Date.now() / 1000) + 3600, status: 'waiting', ...o,
    });
    row = [pairedKeep({ invites: [mk(1, { status: 'active' }), mk(2, { status: 'refused', reason: 'full' }), mk(3, { status: 'revoked' })] })];
    renderKeep();
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    const rows = await screen.findAllByTestId('invite-row');
    const text = rows.map(r => r.textContent).join('|');
    expect(text).toContain('Active');
    expect(text).toContain('Refused (the Keep is full)');
    expect(text).toContain('Revoked');
    const active = rows.find(r => r.textContent?.includes('Active'))!;
    expect(within(rows.find(r => r.textContent?.includes('Revoked'))!).queryByRole('button', { name: 'Revoke' })).toBeNull();
    fireEvent.click(within(active).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(published).toHaveLength(1));
    const rumor = lastRumor();
    expect(rumor.kind).toBe(27662);
    expect(rumor.tags).toEqual([['keep', K], ['grant', '01'.repeat(16)]]);
  });

  it('a Keep owned by a persona we cannot sign for shows "Not available for this persona yet."', async () => {
    row = [pairedKeep()];
    renderKeep(host({ canSign: () => false }));
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not available for this persona yet.');
    expect(screen.queryByRole('button', { name: 'Invite a friend' })).toBeNull();
  });

  it('a Keep still waiting offers Send again and Forget, and no invites', async () => {
    row = [pairedKeep({ status: 'pending', code: CODE })];
    renderKeep();
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    fireEvent.click(await screen.findByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(published).toHaveLength(1));
    expect(lastRumor().kind).toBe(27660);
    expect(screen.queryByRole('heading', { name: 'Games' })).toBeNull();
  });
});
