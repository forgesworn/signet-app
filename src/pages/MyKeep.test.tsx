// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ComponentProps } from 'react';
import type { NostrEvent } from 'signet-protocol';
import { claimEvent, newKey, statusEvent } from '../lib/keep-fixtures';
import { KEEP_CLAIM_KIND, KEEP_RELAYS, KEEP_STATUS_KIND } from '../lib/keep-wire';

const fetchMock = vi.fn();
const onBack = vi.fn();
const scrollTo = vi.fn();
let keepsRow: unknown = null;
let lookupsRow: unknown = null;
vi.mock('../lib/relay-service', () => ({
  fetchEventsWithReach: (...args: unknown[]) => fetchMock(...args),
  subscribeEvents: vi.fn(() => () => undefined),
}));
vi.mock('../lib/db', () => ({
  loadKeepsRow: async () => (keepsRow === null ? null : JSON.parse(JSON.stringify(keepsRow))),
  saveKeepsRow: async (value: unknown) => { keepsRow = JSON.parse(JSON.stringify(value)); },
  loadKeepLookupsRow: async () => (lookupsRow === null ? null : JSON.parse(JSON.stringify(lookupsRow))),
  saveKeepLookupsRow: async (value: unknown) => { lookupsRow = JSON.parse(JSON.stringify(value)); },
}));

import { MyKeep } from './MyKeep';
import { accountPersonas } from '../lib/keep-personas';
import type { KeepHost } from './KeepManage';
import type { SignetIdentity } from '../types';

const me = newKey();
const other = newKey();
const node = newKey();
const now = Math.floor(Date.now() / 1000);

/** A relay that holds `events` and answers by kind, as a real relay would. */
function relayHolding(events: NostrEvent[], reached = 2) {
  fetchMock.mockImplementation(async (filters: Array<{ kinds: number[]; authors?: string[] }>) => ({
    events: events.filter(e => filters.some(f => f.kinds.includes(e.kind) && f.authors?.includes(e.pubkey))),
    attempted: 2, reached,
  }));
}

/** Every claim query sent so far (the Keep claim kind), as its `authors` list. */
const claimAuthors = () => fetchMock.mock.calls
  .flatMap(c => c[0] as Array<{ kinds: number[]; authors?: string[] }>)
  .filter(f => f.kinds.includes(KEEP_CLAIM_KIND))
  .map(f => f.authors);

function host(over: Partial<KeepHost> = {}): KeepHost {
  return {
    deps: { encryptionKey: 'key', backendFor: () => null },
    canSign: () => false,
    activePersona: null,
    personaNames: {},
    personas: [{ pubkey: me.pk, name: 'Anon', canSign: false }, { pubkey: other.pk, name: 'Work', canSign: false }],
    contacts: null,
    confirmClaim: vi.fn(async () => true),
    confirmOwnerChange: vi.fn(async () => true),
    ...over,
  };
}

/** A K1d-shaped saved Keep. */
const savedKeep = (keep: string, claimedBy: string, over: object = {}) => ({
  keep, name: 'Saved', relays: ['wss://relay.example.com'], claimedBy, personas: [claimedBy],
  status: 'paired', claimedAt: 1, invites: [], links: { [claimedBy]: { sections: [], addedRev: 0, active: true } }, ...over,
});

/** Opens the page for a key that an earlier lookup remembered, so it asks about just that key. */
const renderFor = (key: string, props: Partial<ComponentProps<typeof MyKeep>> = {}) => {
  lookupsRow = { keys: [key] };
  return render(<MyKeep scope="id1" onBack={onBack} keepHost={host()} {...props} />);
};

beforeEach(() => {
  fetchMock.mockReset(); onBack.mockReset(); scrollTo.mockReset(); localStorage.clear();
  keepsRow = null; lookupsRow = null;
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
});
afterEach(cleanup);

describe('MyKeep', () => {
  it('shows the loading text first', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    renderFor(me.pk);
    expect(screen.getByText(/Looking for your Keep/)).toBeInTheDocument();
  });

  it('shows the empty state with plain copy and the footnote, and asks the relays nothing', async () => {
    relayHolding([]);
    render(<MyKeep scope="id1" onBack={onBack} />);
    expect(await screen.findByText('No Keep yet.')).toBeInTheDocument();
    expect(screen.getByText('A Keep is a small device at home that looks after your things.')).toBeInTheDocument();
    expect(screen.getByText('Managing a Keep from here is coming later.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Bothy/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('locked: asks to unlock, never says "No Keep yet" or offers Add a Keep, and asks the relays nothing', async () => {
    relayHolding([]);
    const onUnlock = vi.fn();
    render(<MyKeep scope="id1" onBack={onBack} lock={{ state: 'locked', onUnlock }} />);
    expect(screen.getByTestId('keep-locked')).toBeInTheDocument();
    expect(screen.queryByText('No Keep yet.')).toBeNull();
    expect(screen.queryByText(/Looking for your Keep/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a Keep' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(onUnlock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Back to Settings' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unlocking: waits, with no empty state and no Add a Keep', async () => {
    relayHolding([]);
    render(<MyKeep scope="id1" onBack={onBack} lock={{ state: 'unlocking' }} />);
    expect(screen.getByTestId('keep-unlocking')).toBeInTheDocument();
    expect(screen.queryByText('No Keep yet.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull();
  });

  it('once unlocked, the list takes the place of the lock', async () => {
    relayHolding([]);
    const { rerender } = render(<MyKeep scope="id1" onBack={onBack} lock={{ state: 'locked', onUnlock: vi.fn() }} />);
    expect(screen.getByTestId('keep-locked')).toBeInTheDocument();
    rerender(<MyKeep scope="id1" onBack={onBack} keepHost={host()} />);
    expect(await screen.findByText('No Keep yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('keep-locked')).toBeNull();
  });

  it('queries claims by authors (never #p) on the Bothy relays, then statuses by node', async () => {
    const claim = claimEvent(me, node.pk);
    relayHolding([claim]);
    renderFor(me.pk);
    await screen.findByTestId('keep-row');
    const [claimCall, statusCall] = fetchMock.mock.calls;
    expect(claimCall[0]).toEqual([expect.objectContaining({ kinds: [KEEP_CLAIM_KIND], authors: [me.pk] })]);
    expect(JSON.stringify(claimCall[0])).not.toContain('#p');
    expect(claimCall[1]).toEqual({ relays: [...KEEP_RELAYS] });
    expect(statusCall[0]).toEqual([expect.objectContaining({ kinds: [KEEP_STATUS_KIND], authors: [node.pk] })]);
  });

  it('shows the error state with a working retry', async () => {
    relayHolding([], 0);
    renderFor(me.pk);
    expect(await screen.findByText("Couldn't reach the network. Try again.")).toBeInTheDocument();
    relayHolding([claimEvent(me, node.pk)]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('keep-row')).toBeInTheDocument();
  });

  it('lists an online home device with name, region, free space and software', async () => {
    const claim = claimEvent(me, node.pk, { name: 'Kitchen box', region: 'Scotland', role: 'box' });
    relayHolding([claim, statusEvent(node, claim.id, { createdAt: now - 60, free: 20 * 2 ** 30, software: 'bothy-node/0.1.0' })]);
    renderFor(me.pk);
    const row = await screen.findByTestId('keep-row');
    expect(row).toHaveTextContent('Kitchen box');
    expect(row).toHaveTextContent('Online');
    expect(row).toHaveTextContent('Home device · Scotland · 20 GB free · bothy-node 0.1.0');
  });

  it('shows last seen for an old status and "Not seen yet" with none; phone role; default name', async () => {
    const n2 = newKey();
    const a = claimEvent(me, node.pk, { name: 'Old one' });
    const b = claimEvent(me, n2.pk, { role: 'phone' });
    relayHolding([a, b, statusEvent(node, a.id, { createdAt: now - 3 * 3600 })]);
    renderFor(me.pk);
    const rows = await screen.findAllByTestId('keep-row');
    expect(rows).toHaveLength(2);
    const old = rows.find(r => r.textContent?.includes('Old one'))!;
    const bare = rows.find(r => !r.textContent?.includes('Old one'))!;
    expect(old).toHaveTextContent('Last seen 3 hours ago');
    expect(bare).toHaveTextContent('Your Keep');
    expect(bare).toHaveTextContent('Not seen yet');
    expect(bare).toHaveTextContent('Phone');
  });

  it('ignores a status that does not bind to the claim', async () => {
    const claim = claimEvent(me, node.pk);
    relayHolding([claim, statusEvent(node, 'ab'.repeat(32), { createdAt: now - 10 })]);
    renderFor(me.pk);
    expect(await screen.findByTestId('keep-row')).toHaveTextContent('Not seen yet');
  });

  it('a local nickname overrides the name, persists on this device only, and can be cleared', async () => {
    const claim = claimEvent(me, node.pk, { name: 'Kitchen box' });
    relayHolding([claim]);
    const { unmount } = renderFor(me.pk);
    await screen.findByTestId('keep-row');
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Nickname'), { target: { value: 'Study' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByTestId('keep-row')).toHaveTextContent('Study');
    expect(screen.getByTestId('keep-row')).not.toHaveTextContent('Kitchen box');
    // Local storage only: nothing was published and the read path made no other call.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();

    renderFor(me.pk);
    expect(await screen.findByTestId('keep-row')).toHaveTextContent('Study');
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Nickname'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByTestId('keep-row')).toHaveTextContent('Kitchen box'));
  });

  it('starts at the top of the page when opened', async () => {
    relayHolding([]);
    renderFor(me.pk);
    await screen.findByText('No Keep yet.');
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('has an intro line, a footnote and a working Back to Settings button in the list', async () => {
    relayHolding([claimEvent(me, node.pk)]);
    renderFor(me.pk);
    await screen.findByTestId('keep-row');
    expect(screen.getByText('See the Keep you\u2019ve set up at home and whether it\u2019s online.')).toBeInTheDocument();
    expect(screen.getByText('Keeps set up outside My Signet can\u2019t be managed from here yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Settings' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('empty state has a Back to Settings button', async () => {
    relayHolding([]);
    renderFor(me.pk);
    fireEvent.click(await screen.findByRole('button', { name: 'Back to Settings' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows the error state, not "No Keep yet", when the status lookup finds no relay', async () => {
    const claim = claimEvent(me, node.pk);
    fetchMock.mockResolvedValueOnce({ events: [claim], attempted: 2, reached: 2 })
      .mockResolvedValueOnce({ events: [], attempted: 2, reached: 0 });
    renderFor(me.pk);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach the network. Try again.");
    expect(screen.queryByText('No Keep yet.')).toBeNull();
  });

  it('keeps nicknames per identity', async () => {
    const claim = claimEvent(me, node.pk, { name: 'Kitchen box' });
    relayHolding([claim]);
    const first = renderFor(me.pk);
    await screen.findByTestId('keep-row');
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Nickname'), { target: { value: 'Study' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    first.unmount();
    renderFor(me.pk, { scope: "id2" });
    expect(await screen.findByTestId('keep-row')).toHaveTextContent('Kitchen box');
  });

  describe('dev preview', () => {
    afterEach(() => { window.history.replaceState({}, '', '/'); });

    it('shows no banner and reads relays without the flag', async () => {
      relayHolding([]);
      renderFor(me.pk);
      await screen.findByText('No Keep yet.');
      expect(screen.queryByTestId('keep-preview-banner')).not.toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalled();
    });

    it('with ?keep-preview shows the banner and both sample Keeps, without any relay read', async () => {
      window.history.replaceState({}, '', '/?keep-preview');
      renderFor(me.pk);
      const rows = await screen.findAllByTestId('keep-row');
      expect(screen.getByTestId('keep-preview-banner')).toHaveTextContent('Preview \u2014 sample Keeps, not real ones.');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveTextContent('Online');
      expect(rows[0]).toHaveTextContent('Home device · Scotland · 412 GB free · bothy-node 0.3.1');
      expect(rows[1]).toHaveTextContent('Last seen 3 days ago');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('lets a nickname be set on a sample Keep', async () => {
      window.history.replaceState({}, '', '/?keep-preview');
      renderFor(me.pk);
      const [first] = await screen.findAllByTestId('keep-row');
      fireEvent.click(first.querySelector('button')!);
      fireEvent.change(screen.getByLabelText('Nickname'), { target: { value: 'Study' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.getAllByTestId('keep-row')[0]).toHaveTextContent('Study');
    });
  });
});


describe('MyKeep: what the relays are asked', () => {
  const HEARTWOOD = newKey();
  const DORMANT = newKey();
  const node2 = newKey();
  const everyAuthor = () => fetchMock.mock.calls
    .flatMap(c => c[0] as Array<{ authors?: string[] }>)
    .flatMap(f => f.authors ?? []);

  it('opens with nothing saved and nothing remembered: no relay request at all, and a Look for my Keep button', async () => {
    relayHolding([]);
    render(<MyKeep scope="id1" onBack={onBack} keepHost={host()} heartwoodKey={HEARTWOOD.pk} />);
    expect(await screen.findByRole('button', { name: 'Look for my Keep' })).toBeInTheDocument();
    expect(screen.getByText('No Keep yet.')).toBeInTheDocument();
    await new Promise(r => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a lookup sends exactly the one key picked, remembers it encrypted, and turns the Settings row on', async () => {
    const claim = claimEvent(other, node.pk, { name: 'Kitchen box' });
    relayHolding([claim]);
    const onKeepsFound = vi.fn();
    render(<MyKeep scope="id1" onBack={onBack} keepHost={host()} onKeepsFound={onKeepsFound} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Look for my Keep' }));
    const picker = screen.getByTestId('keep-lookup-picker');
    expect(picker).toHaveTextContent('Anon');
    expect(picker).toHaveTextContent('Work');
    expect(picker).toHaveTextContent('Only the one you pick is sent to the network.');
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Work/ }));
    expect(await screen.findByTestId('keep-row')).toHaveTextContent('Kitchen box');
    expect(claimAuthors()).toEqual([[other.pk]]);
    expect(everyAuthor()).not.toContain(me.pk);
    expect(lookupsRow).toEqual({ keys: [other.pk] });
    await waitFor(() => expect(onKeepsFound).toHaveBeenCalledTimes(1));
  });

  it('a lookup that finds nothing says so, remembers nothing, and does not turn the row on', async () => {
    relayHolding([]);
    const onKeepsFound = vi.fn();
    render(<MyKeep scope="id1" onBack={onBack} keepHost={host()} onKeepsFound={onKeepsFound} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Look for my Keep' }));
    fireEvent.click(screen.getByRole('button', { name: /Anon/ }));
    expect(await screen.findByText('No Keep found under Anon. Try another.')).toBeInTheDocument();
    expect(claimAuthors()).toEqual([[me.pk]]);
    expect(lookupsRow).toBeNull();
    expect(onKeepsFound).not.toHaveBeenCalled();
    expect(screen.getByTestId('keep-lookup-picker')).toBeInTheDocument();
  });

  it('a lookup the network cannot answer says so and offers the picker again', async () => {
    relayHolding([], 0);
    render(<MyKeep scope="id1" onBack={onBack} keepHost={host()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Look for my Keep' }));
    fireEvent.click(screen.getByRole('button', { name: /Anon/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach the network. Try again.");
    expect(lookupsRow).toBeNull();
  });

  it('offers My Heartwood only when the app gives a Heartwood key, and queries that key alone', async () => {
    relayHolding([]);
    const { unmount } = render(<MyKeep scope="id1" onBack={onBack} keepHost={host()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Look for my Keep' }));
    expect(screen.queryByText('My Heartwood')).toBeNull();
    unmount();

    render(<MyKeep scope="id1" onBack={onBack} keepHost={host()} heartwoodKey={HEARTWOOD.pk} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Look for my Keep' }));
    expect(screen.getByRole('button', { name: /My Heartwood/ })).toHaveTextContent('If the Keep was set up with your Heartwood');
    fireEvent.click(screen.getByRole('button', { name: /My Heartwood/ }));
    await screen.findByText('No Keep found under My Heartwood. Try another.');
    expect(claimAuthors()).toEqual([[HEARTWOOD.pk]]);
  });

  it('a found Heartwood Keep is remembered under the Heartwood key and later opens ask for just that key', async () => {
    relayHolding([claimEvent(HEARTWOOD, node.pk, { name: 'Hall box' })]);
    const { unmount } = render(<MyKeep scope="id1" onBack={onBack} keepHost={host()} heartwoodKey={HEARTWOOD.pk} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Look for my Keep' }));
    fireEvent.click(screen.getByRole('button', { name: /My Heartwood/ }));
    expect(await screen.findByTestId('keep-row')).toHaveTextContent('Hall box');
    await waitFor(() => expect(lookupsRow).toEqual({ keys: [HEARTWOOD.pk] }));
    unmount();
    fetchMock.mockClear();
    render(<MyKeep scope="id1" onBack={onBack} keepHost={host()} />);
    expect(await screen.findByTestId('keep-row')).toHaveTextContent('Hall box');
    expect(claimAuthors()).toEqual([[HEARTWOOD.pk]]);
  });

  it('never offers the dormant real-name key: the picker is the account personas, and no request carries it', async () => {
    const identity = {
      id: DORMANT.pk, primaryKeypair: 'persona', naturalPersonActive: false, encrypted: false,
      naturalPerson: { publicKey: DORMANT.pk, privateKey: '', displayName: '' },
      persona: { publicKey: me.pk, privateKey: '', displayName: 'Anon' },
    } as unknown as SignetIdentity;
    const personas = accountPersonas(identity);
    expect(personas.map(p => p.pubkey)).toEqual([me.pk]);
    relayHolding([]);
    render(<MyKeep scope="id1" onBack={onBack} keepHost={host({ personas })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Look for my Keep' }));
    fireEvent.click(screen.getByRole('button', { name: /Anon/ }));
    await screen.findByText('No Keep found under Anon. Try another.');
    expect(everyAuthor()).toEqual([me.pk]);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(DORMANT.pk);
  });

  it('saved Keeps: each is read with only its own keys, one request each, never a union', async () => {
    keepsRow = [
      savedKeep(node.pk, me.pk, { personas: [me.pk] }),
      savedKeep(node2.pk, other.pk, {
        personas: [other.pk, HEARTWOOD.pk],
        links: { [other.pk]: { sections: [], addedRev: 0, active: true }, [HEARTWOOD.pk]: { sections: [], addedRev: 0, active: true } },
      }),
    ];
    relayHolding([claimEvent(me, node.pk, { name: 'First' }), claimEvent(other, node2.pk, { name: 'Second' })]);
    render(<MyKeep scope="id1" onBack={onBack} keepHost={host()} />);
    await waitFor(() => expect(screen.getAllByTestId('keep-row')).toHaveLength(2));
    const asks = claimAuthors();
    expect(asks).toHaveLength(2);
    expect(asks).toContainEqual([me.pk]);
    expect(asks).toContainEqual([other.pk, HEARTWOOD.pk].sort());
    expect(asks.every(a => a!.length <= 2)).toBe(true);
    expect(asks.flat()).not.toContain(DORMANT.pk);
  });

  it('remembered keys: one request per key, never combined, and no lookup button shown for them', async () => {
    lookupsRow = { keys: [me.pk, HEARTWOOD.pk] };
    relayHolding([]);
    render(<MyKeep scope="id1" onBack={onBack} keepHost={host()} />);
    await screen.findByText('No Keep yet.');
    const asks = claimAuthors();
    expect(asks).toHaveLength(2);
    expect(asks).toContainEqual([me.pk]);
    expect(asks).toContainEqual([HEARTWOOD.pk]);
  });

  it('turns the Settings row on when a Keep is already saved', async () => {
    keepsRow = [savedKeep(node.pk, me.pk)];
    relayHolding([]);
    const onKeepsFound = vi.fn();
    render(<MyKeep scope="id1" onBack={onBack} keepHost={host()} onKeepsFound={onKeepsFound} />);
    await screen.findByTestId('stored-keep-row');
    await waitFor(() => expect(onKeepsFound).toHaveBeenCalledTimes(1));
  });

  it('on lock the decrypted Keeps leave the page, and nothing is read for a locked app', async () => {
    keepsRow = [savedKeep(node.pk, me.pk, { name: 'Secret kitchen' })];
    relayHolding([]);
    const { rerender } = render(<MyKeep scope="id1" onBack={onBack} keepHost={host()} />);
    expect(await screen.findByTestId('stored-keep-row')).toHaveTextContent('Secret kitchen');
    fetchMock.mockClear();
    // The app locks: no key, so no host and the lock screen.
    rerender(<MyKeep scope="id1" onBack={onBack} lock={{ state: 'locked', onUnlock: vi.fn() }} />);
    expect(screen.getByTestId('keep-locked')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Secret kitchen');
    // Even without the lock screen, the held state is empty (nothing left in memory to show).
    rerender(<MyKeep scope="id1" onBack={onBack} />);
    expect(screen.queryByTestId('stored-keeps')).toBeNull();
    expect(document.body.textContent).not.toContain('Secret kitchen');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
