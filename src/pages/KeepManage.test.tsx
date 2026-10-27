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
let lookupsRow: unknown = null;
vi.mock('../lib/db', () => ({
  loadKeepsRow: async () => (row === null ? null : JSON.parse(JSON.stringify(row))),
  saveKeepsRow: async (value: unknown) => { row = JSON.parse(JSON.stringify(value)); },
  loadKeepLookupsRow: async () => (lookupsRow === null ? null : JSON.parse(JSON.stringify(lookupsRow))),
  saveKeepLookupsRow: async (value: unknown) => { lookupsRow = JSON.parse(JSON.stringify(value)); },
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
import { expiryText, type KeepHost } from './KeepManage';

const KEEP_SK = hexToBytes('0'.repeat(63) + '1');
const K = getPublicKey(KEEP_SK);
const OWNER_HEX = '0'.repeat(63) + '2';
const O = getPublicKey(hexToBytes(OWNER_HEX));
const FRIEND = getPublicKey(hexToBytes('0'.repeat(63) + '3'));
const BOB_HEX = '0'.repeat(63) + '4';
const BOB = getPublicKey(hexToBytes(BOB_HEX));
const SKS: Record<string, string> = { [O]: OWNER_HEX, [BOB]: BOB_HEX };
void SKS;
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
    deps: {
      encryptionKey: 'key', backendFor: p => (p === O ? new LocalSigningBackend(OWNER_HEX) : null),
      eligiblePersonas: () => [O], personaName: () => 'Anon',
    },
    canSign: p => p === O,
    activePersona: { pubkey: O, name: 'Anon' },
    personaNames: { [O]: 'Anon' },
    personas: [{ pubkey: O, name: 'Anon', canSign: true }],
    contacts: [contact('1', 'Dave', 'kin', FRIEND), contact('2', 'Kenny', 'ken', 'ee'.repeat(32))],
    confirmClaim: vi.fn(async () => true),
    confirmOwnerChange: vi.fn(async () => true),
    ...over,
  };
}

// A K1d-shaped record whose owner has Games off, so these tests are about the members' invites only.
const pairedKeep = (over: object = {}) => ({
  keep: K, name: 'Kitchen Keep', relays: ['wss://relay.example.com'], claimedBy: O, personas: [O],
  status: 'paired', claimedAt: 1, invites: [], links: { [O]: { sections: [], addedRev: 0, active: true } }, ...over,
});

const share = vi.fn();
beforeEach(() => {
  row = null; lookupsRow = null; published.length = 0; share.mockReset(); share.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'share', { value: share, configurable: true });
  window.scrollTo = vi.fn() as never;
  localStorage.clear();
});
afterEach(cleanup);

const renderKeep = (h: KeepHost | undefined = host()) => render(<MyKeep scope="id1" onBack={vi.fn()} keepHost={h} />);
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
    expect(screen.getByRole('radio', { name: /All my personas/ })).toBeChecked();
    expect(published).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Make it my Keep' }));
    await screen.findByText('Waiting for the Keep');
    expect(h.confirmClaim).toHaveBeenCalledWith('Kitchen Keep', 'Anon');
    expect(published).toHaveLength(1);
    expect(lastRumor().tags).toEqual([['keep', K], ['code', CODE], ['scope', 'all']]);
    expect(screen.getByText('All of you')).toBeInTheDocument();
  });

  it('adding a stored Keep again with a new link pairs it again and waits for the Keep', async () => {
    row = [pairedKeep({ invites: [{ grant: '11'.repeat(16), secret: '22'.repeat(32), kind: 'guest', createdAt: 1, expiration: 2e9, status: 'active' }] })];
    renderKeep();
    fireEvent.click(await screen.findByRole('button', { name: 'Add a Keep' }));
    fireEvent.change(screen.getByLabelText('Keep link'), { target: { value: LINK } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make it my Keep' }));
    expect((await screen.findAllByText(/Waiting for the Keep/)).length).toBeGreaterThan(0);
    // A Keep stored without a choice is one for a single persona: adding it again starts there, not on All.
    expect(lastRumor().tags).toEqual([['keep', K], ['code', CODE], ['scope', 'one']]);
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
  it('is listed in the account-level list, labelled with who it is for', async () => {
    row = [pairedKeep()];
    renderKeep();
    const rowEl = await screen.findByTestId('stored-keep-row');
    expect(rowEl).toHaveTextContent('Kitchen Keep');
    expect(rowEl).toHaveTextContent('Connected');
    expect(rowEl).toHaveTextContent('Only Anon');
  });

  it('opening its page sends an unanswered invite again, once, and not a recent one', async () => {
    const now = Math.floor(Date.now() / 1000);
    const waiting = (grant: string, sentAt: number) => ({
      grant, secret: grant.repeat(2), kind: 'guest', createdAt: sentAt, sentAt, expiration: now + 86400, status: 'waiting',
    });
    row = [pairedKeep({ invites: [waiting('11'.repeat(16), now - 3600), waiting('55'.repeat(16), now - 60)] })];
    renderKeep();
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    await screen.findByRole('heading', { name: 'Games' });
    // The page also asks the Keep for its return passes (27668), once.
    await waitFor(() => expect(published).toHaveLength(2));
    await new Promise(r => setTimeout(r, 50));
    expect(published).toHaveLength(2);
    const sent = published.map(w => unwrapEvent(w as never, KEEP_SK));
    expect(sent.map(r => r.kind)).toEqual([27661, 27668]);
    expect(sent[0].tags).toContainEqual(['grant', '11'.repeat(16)]);
  });

  it('puts the members\' invites under a Games heading, after Linked personas, and builds no Backups section', async () => {
    row = [pairedKeep()];
    renderKeep();
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    expect(await screen.findByRole('heading', { name: 'Games' })).toBeInTheDocument();
    expect(screen.queryByText(/backup/i)).toBeNull();
    expect(screen.getByText('Who can play')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Linked personas' })).toBeInTheDocument();
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
    expect(screen.queryByRole('switch')).toBeNull();
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

describe('expiryText', () => {
  it('reads 24 hours for a 24 hour pass even when the clock reading is a little old', () => {
    expect(expiryText(1_000_000 + 86_400, 1_000_000)).toBe('Expires in 24 hours');
    expect(expiryText(1_000_000 + 86_400, 1_000_000 - 30)).toBe('Expires in 24 hours');
    expect(expiryText(1_000_000 + 86_379, 1_000_000)).toBe('Expires in 24 hours');
  });
  it('rounds to the nearest hour, never below one, and says Expired at the end', () => {
    expect(expiryText(1_000_000 + 5_400, 1_000_000)).toBe('Expires in 2 hours');
    expect(expiryText(1_000_000 + 600, 1_000_000)).toBe('Expires in 1 hour');
    expect(expiryText(1_000_000, 1_000_000)).toBe('Expired');
  });
});

describe('personas (K1e)', () => {
  const twoDeps = (): KeepHost['deps'] => ({
    encryptionKey: 'key',
    backendFor: p => (SKS[p] ? new LocalSigningBackend(SKS[p]) : null),
    eligiblePersonas: () => [O, BOB],
    personaName: p => (p === O ? 'Anon' : 'Bob'),
    now: undefined,
  });
  const two = (over: Partial<KeepHost> = {}): KeepHost => host({
    deps: twoDeps(),
    canSign: p => !!SKS[p],
    personaNames: { [O]: 'Anon', [BOB]: 'Bob' },
    personas: [{ pubkey: O, name: 'Anon', canSign: true }, { pubkey: BOB, name: 'Bob', canSign: true }],
    ...over,
  });
  const link = (over: object = {}) => ({
    ...pairedKeep(), scope: 'one', rev: 0, seen: [O],
    links: { [O]: { sections: ['games'], addedRev: 0, active: true } }, ...over,
  });
  const bothLinked = (invites: object[] = []) => link({
    scope: 'all', rev: 1, personas: [O, BOB], seen: [O, BOB], invites,
    links: { [O]: { sections: ['games'], addedRev: 0, active: true }, [BOB]: { sections: ['games'], addedRev: 1, active: true } },
  });
  const gamesInvite = (persona: string, over: object = {}) => ({
    grant: (persona === O ? '0a' : '0b').repeat(16), secret: (persona === O ? 'aa' : 'bb').repeat(32), kind: 'personal', persona,
    gamesFor: persona, label: 'x (owner)', createdAt: 1, sentAt: Math.floor(Date.now() / 1000), expiration: Math.floor(Date.now() / 1000) + 300 * 86400,
    status: 'active', ...over,
  });
  const kindsPublished = () => published.map(w => unwrapEvent(w as never, KEEP_SK).kind);

  it('Add a Keep asks All my personas (default) or Only this persona, and the claim carries the choice', async () => {
    renderKeep(two());
    fireEvent.click(await screen.findByRole('button', { name: 'Add a Keep' }));
    fireEvent.change(screen.getByLabelText('Keep link'), { target: { value: LINK } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('radio', { name: /All my personas/ })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /Only this persona/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Make it my Keep' }));
    await screen.findAllByText(/Waiting for the Keep/);
    expect(lastRumor().tags).toContainEqual(['scope', 'one']);
    expect((row as Array<{ scope: string }>)[0].scope).toBe('one');
  });

  it('adding a Keep that is already stored starts on the choice it has', async () => {
    row = [link({ status: 'paired' })]; // scope one
    renderKeep(two());
    fireEvent.click(await screen.findByRole('button', { name: 'Add a Keep' }));
    fireEvent.change(screen.getByLabelText('Keep link'), { target: { value: LINK } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('radio', { name: /Only this persona/ })).toBeChecked();
  });

  it('every Keep shows for every persona, labelled All of you or Only <names>', async () => {
    row = [link(), { ...bothLinked(), keep: 'cd'.repeat(32), name: 'Shed Keep' }];
    renderKeep(two({ activePersona: { pubkey: BOB, name: 'Bob' } }));
    const rows = await screen.findAllByTestId('stored-keep-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Only Anon');
    expect(rows[1]).toHaveTextContent('All of you');
  });

  it('signed in as a persona the Keep is not linked to: it shows, with no actions', async () => {
    row = [link()];
    renderKeep(two({ activePersona: { pubkey: BOB, name: 'Bob' } }));
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    expect(await screen.findByTestId('not-linked')).toHaveTextContent('Bob isn’t linked to this Keep');
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Guest pass' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Play here' })).toBeNull();
  });

  it('Linked personas has a switch per persona and the privacy note; switching Bob on sends the update, and his accept follows the update\'s ack', async () => {
    row = [link()];
    const h = two();
    renderKeep(h);
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    const section = (await screen.findByRole('heading', { name: 'Linked personas' })).closest('section')!;
    expect(section).toHaveTextContent('The Keep will be able to tell that these personas are the same person, and the relays it uses may be able to as well. Nobody else can.');
    const anon = within(section).getByRole('switch', { name: 'Anon' });
    expect(anon).toBeChecked();
    expect(anon).toBeDisabled(); // the only persona the Keep has confirmed
    const bob = within(section).getByRole('switch', { name: 'Bob' });
    expect(bob).not.toBeChecked();
    fireEvent.click(bob);
    await waitFor(() => expect(h.confirmOwnerChange).toHaveBeenCalledWith('Kitchen Keep', 'Bob', true));
    const owners = () => kindsPublished().filter(k => k === 27664 || k === 27665);
    await waitFor(() => expect(owners()).toEqual([27664]));
    expect(owners()).not.toContain(27665);
    const update = published.map(w => unwrapEvent(w as never, KEEP_SK)).find(r => r.kind === 27664)!;
    expect(update.tags).toEqual([['keep', K], ['rev', '1'], ['persona', O, 'games'], ['persona', BOB, 'games']]);
    await waitFor(() => expect(within(section).getByText('Waiting for the Keep')).toBeInTheDocument());
    // Linked by hand, the Keep was still claimed for Only this persona: the label follows that.
    expect(screen.getByTestId('keep-scope')).toHaveTextContent('Only Anon, Bob');
    expect(screen.getByTestId('keep-scope')).not.toHaveTextContent('All of you');
  });

  it('linking and unlinking a persona ask for the PIN first, and nothing is sent when it is not confirmed', async () => {
    row = [link()];
    const h = two({ confirmOwnerChange: vi.fn(async () => false) });
    renderKeep(h);
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    const section = (await screen.findByRole('heading', { name: 'Linked personas' })).closest('section')!;
    fireEvent.click(within(section).getByRole('switch', { name: 'Bob' }));
    await waitFor(() => expect(h.confirmOwnerChange).toHaveBeenCalledWith('Kitchen Keep', 'Bob', true));
    expect(await screen.findByText('Not confirmed. Nothing was sent.')).toBeInTheDocument();
    expect(kindsPublished()).not.toContain(27664); // no owners update (a games invite for the claimer may go)
    expect((row as Array<{ personas: string[] }>)[0].personas).toEqual([O]);
  });

  it('unlinking asks for the PIN as well; Games on or off and Try again do not', async () => {
    row = [{ ...bothLinked([gamesInvite(O), gamesInvite(BOB)]), rev: 1 }];
    const h = two();
    renderKeep(h);
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    const used = await screen.findByTestId('used-by');
    fireEvent.click(within(used).getByRole('switch', { name: 'Bob' }));
    await waitFor(() => expect(kindsPublished()).toContain(27664));
    expect(h.confirmOwnerChange).not.toHaveBeenCalled();
    const section = screen.getByRole('heading', { name: 'Linked personas' }).closest('section')!;
    fireEvent.click(within(section).getByRole('switch', { name: 'Bob' }));
    await waitFor(() => expect(h.confirmOwnerChange).toHaveBeenCalledWith('Kitchen Keep', 'Bob', false));
  });

  it('a persona without a local key cannot be linked: "Not available for this persona yet."', async () => {
    row = [link()];
    renderKeep(two({ personas: [{ pubkey: O, name: 'Anon', canSign: true }, { pubkey: BOB, name: 'Bob', canSign: false }] }));
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    const section = (await screen.findByRole('heading', { name: 'Linked personas' })).closest('section')!;
    const bob = within(section).getByRole('switch', { name: 'Bob' });
    expect(bob).toBeDisabled();
    expect(section).toHaveTextContent('Not available for this persona yet.');
  });

  it('Games has Used by with a switch per linked persona, and Used by off revokes that persona\'s invite', async () => {
    row = [bothLinked([gamesInvite(O), gamesInvite(BOB)])];
    renderKeep(two());
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    const usedBy = await screen.findByTestId('used-by');
    const bob = within(usedBy).getByRole('switch', { name: 'Bob' });
    expect(within(usedBy).getByRole('switch', { name: 'Anon' })).toBeChecked();
    expect(bob).toBeChecked();
    fireEvent.click(bob);
    await waitFor(() => expect(kindsPublished()).toEqual([27668, 27664, 27662]));
    const revoke = unwrapEvent(published[2] as never, KEEP_SK);
    expect(revoke.tags).toEqual([['keep', K], ['grant', '0b'.repeat(16)]]);
    await waitFor(() => expect(within(screen.getByTestId('used-by')).getByRole('switch', { name: 'Bob' })).not.toBeChecked());
  });

  it('Play here opens stampede://keep/<K>/<secret> for the signed-in persona, with the line about signing in as it', async () => {
    const openApp = vi.fn();
    row = [bothLinked([gamesInvite(O), gamesInvite(BOB)])];
    renderKeep(two({ openApp, activePersona: { pubkey: BOB, name: 'Bob' } }));
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    const block = await screen.findByTestId('play-here');
    expect(block).toHaveTextContent('Stampede must be installed and signed in as Bob');
    fireEvent.click(within(block).getByRole('button', { name: 'Play here' }));
    expect(openApp).toHaveBeenCalledWith(`stampede://keep/${K}/${'bb'.repeat(32)}`);
    expect(document.body.textContent).not.toContain('bb'.repeat(32));
  });

  it('Play here waits until the Keep says the persona can play, and is not offered on the web', async () => {
    const openApp = vi.fn();
    row = [bothLinked([gamesInvite(O), gamesInvite(BOB, { status: 'waiting' })])];
    const view = renderKeep(two({ openApp, activePersona: { pubkey: BOB, name: 'Bob' } }));
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    const block = await screen.findByTestId('play-here');
    expect(within(block).getByRole('button', { name: 'Play here' })).toBeDisabled();
    view.unmount();
    renderKeep(two({ activePersona: { pubkey: BOB, name: 'Bob' } }));
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    expect(within(await screen.findByTestId('play-here')).queryByRole('button', { name: 'Play here' })).toBeNull();
  });

  it('the owner personas\' own games invites are not listed under Who can play', async () => {
    row = [bothLinked([gamesInvite(O), gamesInvite(BOB)])];
    renderKeep(two());
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    await screen.findByTestId('used-by');
    expect(screen.queryAllByTestId('invite-row')).toHaveLength(0);
    expect(screen.getByText('No invites yet.')).toBeInTheDocument();
  });

  it('a Keep the Keep refused to update says so and offers Try again', async () => {
    row = [{ ...bothLinked([gamesInvite(O), gamesInvite(BOB)]), update: { rev: 2, signer: O, personas: [{ persona: O, sections: ['games'] }], sentAt: 5, failed: 'malformed' } }];
    renderKeep(two());
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    const section = (await screen.findByRole('heading', { name: 'Linked personas' })).closest('section')!;
    expect(within(section).getByRole('alert')).toHaveTextContent('did not take the change');
    fireEvent.click(within(section).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(kindsPublished()).toContain(27664));
  });
});

describe('return passes (K1f)', () => {
  const nowS = () => Math.floor(Date.now() / 1000);
  const PLAYER_A = getPublicKey(hexToBytes('0'.repeat(63) + '5'));
  const PLAYER_B = getPublicKey(hexToBytes('0'.repeat(63) + '6'));
  const G_FRIEND = '01'.repeat(16);
  const G_SEAT = '02'.repeat(16);
  const G_BARE = '03'.repeat(16);
  // The expiry text uses the device locale, so the expected text is made with the same formatter.
  const FRIEND_EXPIRY = nowS() + 20 * 86400;
  const pass = (grant: string, persona: string, over: object = {}) => ({
    grant, persona, state: 'active', expiration: nowS() + 20 * 86400, seenAt: nowS() - 2 * 86400, via: 'code', reportAt: nowS() - 86400, ...over,
  });
  const withPasses = (passes: object[], over: object = {}) => [pairedKeep({ passes, ...over })];
  const kindsPublished = () => published.map(w => unwrapEvent(w as never, KEEP_SK).kind);
  const open = async () => {
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    return screen.findByTestId('returning-players');
  };

  it('lists a returning player under Who can play: the contact\'s name, else the seat name, else a short npub; Active, expiry, last seen', async () => {
    row = withPasses([
      pass(G_FRIEND, FRIEND, { name: 'Seat name', expiration: FRIEND_EXPIRY }),
      pass(G_SEAT, PLAYER_A, { name: 'Seat name', seenAt: nowS() - 5 * 86400 }),
      pass(G_BARE, PLAYER_B, { seenAt: nowS() - 7200 }),
    ]);
    renderKeep();
    const block = await open();
    const rows = within(block).getAllByTestId('pass-row');
    expect(rows).toHaveLength(3);
    // Most recently seen first: PLAYER_B (2 hours ago, no name: short npub), then FRIEND (2 days: the contact Dave wins over
    // the seat name the Keep saw), then PLAYER_A (5 days: the seat name).
    const names = rows.map(r => r.firstElementChild!.textContent);
    expect(names).toEqual([expect.stringMatching(/^npub1[0-9a-z]+…[0-9a-z]{6}$/), 'Dave', 'Seat name']);
    expect(rows[0]).toHaveTextContent('Last seen 2 hours ago');
    expect(rows[1]).toHaveTextContent('Active');
    expect(rows[1]).toHaveTextContent(expiryText(FRIEND_EXPIRY, nowS()));
    expect(rows[1]).toHaveTextContent('Last seen 2 days ago');
    expect(rows[2]).toHaveTextContent('Last seen 5 days ago');
    // it is part of the Who can play block, below the invites
    const who = screen.getByText('Who can play');
    expect(who.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(block.closest('section')).toBe(who.closest('section'));
  });

  it('does not list revoked or expired passes, and says so when there is no one', async () => {
    row = withPasses([
      pass(G_FRIEND, FRIEND, { state: 'revoked' }),
      pass(G_SEAT, PLAYER_A, { state: 'expired' }),
      pass(G_BARE, PLAYER_B, { expiration: nowS() - 10 }),
    ]);
    renderKeep();
    const block = await open();
    expect(within(block).queryAllByTestId('pass-row')).toHaveLength(0);
    expect(block).toHaveTextContent('No one has come back yet.');
  });

  it('Revoke asks first; Cancel sends nothing; Confirm sends the revoke with the pass grant and shows Revoking', async () => {
    row = withPasses([pass(G_FRIEND, FRIEND)]);
    renderKeep();
    const block = await open();
    await waitFor(() => expect(kindsPublished()).toEqual([27668])); // opening asked for the passes
    fireEvent.click(within(block).getByRole('button', { name: 'Revoke' }));
    expect(within(block).getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    fireEvent.click(within(block).getByRole('button', { name: 'Cancel' }));
    expect(within(block).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    expect(kindsPublished()).toEqual([27668]);

    fireEvent.click(within(block).getByRole('button', { name: 'Revoke' }));
    fireEvent.click(within(block).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(kindsPublished()).toEqual([27668, 27662]));
    expect(unwrapEvent(published[1] as never, KEEP_SK).tags).toEqual([['keep', K], ['grant', G_FRIEND]]);
    await waitFor(() => expect(within(block).getByTestId('pass-row')).toHaveTextContent('Revoking, waiting for the Keep'));
    expect(within(block).getByRole('button', { name: 'Send revoke again' })).toBeInTheDocument();
    expect((row as Array<{ passes: Array<{ revokeSent?: boolean }> }>)[0].passes[0].revokeSent).toBe(true);
  });

  it('the Return passes switch is on by default with nothing under it, and the page asks the Keep for its passes', async () => {
    row = withPasses([]);
    renderKeep();
    const block = await open();
    expect(within(block).getByRole('switch', { name: 'Return passes' })).toBeChecked();
    expect(within(block).getByTestId('return-passes')).not.toHaveTextContent('Waiting');
    await waitFor(() => expect(kindsPublished()).toEqual([27668]));
    expect(unwrapEvent(published[0] as never, KEEP_SK).tags).toEqual([['keep', K]]);
  });

  it('turning it off sends 27666, shows Waiting for the Keep, and says what off means', async () => {
    row = withPasses([]);
    renderKeep();
    const block = await open();
    fireEvent.click(within(block).getByRole('switch', { name: 'Return passes' }));
    await waitFor(() => expect(kindsPublished()).toContain(27666));
    const rumor = unwrapEvent(published.find(w => unwrapEvent(w as never, KEEP_SK).kind === 27666) as never, KEEP_SK);
    expect(rumor.tags).toEqual([['keep', K], ['setrev', '1'], ['return_passes', 'off']]);
    await waitFor(() => expect(within(block).getByRole('switch', { name: 'Return passes' })).not.toBeChecked());
    expect(within(block).getByTestId('return-passes')).toHaveTextContent('Waiting for the Keep');
  });

  it('says "This Keep can’t do this yet" when the Keep has not answered after the resend window', async () => {
    const long = nowS() - 3600;
    row = withPasses([], { settings: { returnPasses: false, setrev: 1, composedAt: long, sentAt: nowS(), confirmed: false } });
    renderKeep();
    const block = await open();
    expect(within(block).getByTestId('return-passes')).toHaveTextContent('This Keep can’t do this yet');
    expect(within(block).getByRole('switch', { name: 'Return passes' })).not.toBeChecked();
  });

  it('shows nothing under the switch once the Keep has it', async () => {
    row = withPasses([], { settings: { returnPasses: false, setrev: 1, composedAt: nowS() - 3600, sentAt: nowS() - 3600, confirmed: true } });
    renderKeep();
    const block = await open();
    const sw = within(block).getByTestId('return-passes');
    expect(sw).not.toHaveTextContent('Waiting');
    expect(sw).not.toHaveTextContent('can’t do this yet');
    expect(sw).toHaveTextContent('Existing passes keep working');
  });

  it('is not offered to a persona that is not an owner of the Keep', async () => {
    row = withPasses([pass(G_FRIEND, FRIEND)]);
    renderKeep(host({ activePersona: { pubkey: BOB, name: 'Bob' }, personaNames: { [O]: 'Anon', [BOB]: 'Bob' } }));
    fireEvent.click(await screen.findByTestId('stored-keep-row'));
    await screen.findByTestId('not-linked');
    expect(screen.queryByTestId('returning-players')).toBeNull();
  });
});
