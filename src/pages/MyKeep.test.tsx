// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { NostrEvent } from 'signet-protocol';
import { claimEvent, newKey, statusEvent } from '../lib/keep-fixtures';
import { KEEP_CLAIM_KIND, KEEP_RELAYS, KEEP_STATUS_KIND } from '../lib/keep-wire';

const fetchMock = vi.fn();
const onBack = vi.fn();
const scrollTo = vi.fn();
vi.mock('../lib/relay-service', () => ({
  fetchEventsWithReach: (...args: unknown[]) => fetchMock(...args),
}));

import { MyKeep } from './MyKeep';

const me = newKey();
const node = newKey();
const now = Math.floor(Date.now() / 1000);

/** A relay that holds `events` and answers by kind, as a real relay would. */
function relayHolding(events: NostrEvent[], reached = 2) {
  fetchMock.mockImplementation(async (filters: Array<{ kinds: number[]; authors: string[] }>) => ({
    events: events.filter(e => filters.some(f => f.kinds.includes(e.kind) && f.authors.includes(e.pubkey))),
    attempted: 2, reached,
  }));
}

beforeEach(() => {
  fetchMock.mockReset(); onBack.mockReset(); scrollTo.mockReset(); localStorage.clear();
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
});
afterEach(cleanup);

describe('MyKeep', () => {
  it('shows the loading text first', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<MyKeep ownedPubkeys={[me.pk]} scope="id1" onBack={onBack} />);
    expect(screen.getByText(/Looking for your Keep/)).toBeInTheDocument();
  });

  it('shows the empty state with plain copy and the footnote', async () => {
    relayHolding([]);
    render(<MyKeep ownedPubkeys={[me.pk]} scope="id1" onBack={onBack} />);
    expect(await screen.findByText('No Keep yet.')).toBeInTheDocument();
    expect(screen.getByText('A Keep is a small device at home that looks after your things. You can set one up with the Bothy app.')).toBeInTheDocument();
    expect(screen.getByText('Managing a Keep from here is coming later.')).toBeInTheDocument();
  });

  it('queries claims by authors (never #p) on the Bothy relays, then statuses by node', async () => {
    const claim = claimEvent(me, node.pk);
    relayHolding([claim]);
    render(<MyKeep ownedPubkeys={[me.pk]} scope="id1" onBack={onBack} />);
    await screen.findByTestId('keep-row');
    const [claimCall, statusCall] = fetchMock.mock.calls;
    expect(claimCall[0]).toEqual([expect.objectContaining({ kinds: [KEEP_CLAIM_KIND], authors: [me.pk] })]);
    expect(JSON.stringify(claimCall[0])).not.toContain('#p');
    expect(claimCall[1]).toEqual({ relays: [...KEEP_RELAYS] });
    expect(statusCall[0]).toEqual([expect.objectContaining({ kinds: [KEEP_STATUS_KIND], authors: [node.pk] })]);
  });

  it('shows the error state with a working retry', async () => {
    relayHolding([], 0);
    render(<MyKeep ownedPubkeys={[me.pk]} scope="id1" onBack={onBack} />);
    expect(await screen.findByText("Couldn't reach the network. Try again.")).toBeInTheDocument();
    relayHolding([claimEvent(me, node.pk)]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('keep-row')).toBeInTheDocument();
  });

  it('lists an online home device with name, region, free space and software', async () => {
    const claim = claimEvent(me, node.pk, { name: 'Kitchen box', region: 'Scotland', role: 'box' });
    relayHolding([claim, statusEvent(node, claim.id, { createdAt: now - 60, free: 20 * 2 ** 30, software: 'bothy-node/0.1.0' })]);
    render(<MyKeep ownedPubkeys={[me.pk]} scope="id1" onBack={onBack} />);
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
    render(<MyKeep ownedPubkeys={[me.pk]} scope="id1" onBack={onBack} />);
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
    render(<MyKeep ownedPubkeys={[me.pk]} scope="id1" onBack={onBack} />);
    expect(await screen.findByTestId('keep-row')).toHaveTextContent('Not seen yet');
  });

  it('a local nickname overrides the name, persists on this device only, and can be cleared', async () => {
    const claim = claimEvent(me, node.pk, { name: 'Kitchen box' });
    relayHolding([claim]);
    const { unmount } = render(<MyKeep ownedPubkeys={[me.pk]} scope="id1" onBack={onBack} />);
    await screen.findByTestId('keep-row');
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Nickname'), { target: { value: 'Study' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByTestId('keep-row')).toHaveTextContent('Study');
    expect(screen.getByTestId('keep-row')).not.toHaveTextContent('Kitchen box');
    // Local storage only: nothing was published and the read path made no other call.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();

    render(<MyKeep ownedPubkeys={[me.pk]} scope="id1" onBack={onBack} />);
    expect(await screen.findByTestId('keep-row')).toHaveTextContent('Study');
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Nickname'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByTestId('keep-row')).toHaveTextContent('Kitchen box'));
  });

  it('starts at the top of the page when opened', async () => {
    relayHolding([]);
    render(<MyKeep ownedPubkeys={[me.pk]} scope="id1" onBack={onBack} />);
    await screen.findByText('No Keep yet.');
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('has an intro line, a footnote and a working Back to Settings button in the list', async () => {
    relayHolding([claimEvent(me, node.pk)]);
    render(<MyKeep ownedPubkeys={[me.pk]} scope="id1" onBack={onBack} />);
    await screen.findByTestId('keep-row');
    expect(screen.getByText('See the Keep you\u2019ve set up at home and whether it\u2019s online.')).toBeInTheDocument();
    expect(screen.getByText('Managing a Keep from here is coming later.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Settings' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('empty state has a Back to Settings button', async () => {
    relayHolding([]);
    render(<MyKeep ownedPubkeys={[me.pk]} scope="id1" onBack={onBack} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Back to Settings' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows the error state, not "No Keep yet", when the status lookup finds no relay', async () => {
    const claim = claimEvent(me, node.pk);
    fetchMock.mockResolvedValueOnce({ events: [claim], attempted: 2, reached: 2 })
      .mockResolvedValueOnce({ events: [], attempted: 2, reached: 0 });
    render(<MyKeep ownedPubkeys={[me.pk]} scope="id1" onBack={onBack} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach the network. Try again.");
    expect(screen.queryByText('No Keep yet.')).toBeNull();
  });

  it('keeps nicknames per identity', async () => {
    const claim = claimEvent(me, node.pk, { name: 'Kitchen box' });
    relayHolding([claim]);
    const first = render(<MyKeep ownedPubkeys={[me.pk]} scope="id1" onBack={onBack} />);
    await screen.findByTestId('keep-row');
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Nickname'), { target: { value: 'Study' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    first.unmount();
    render(<MyKeep ownedPubkeys={[me.pk]} scope="id2" onBack={onBack} />);
    expect(await screen.findByTestId('keep-row')).toHaveTextContent('Kitchen box');
  });

  describe('dev preview', () => {
    afterEach(() => { window.history.replaceState({}, '', '/'); });

    it('shows no banner and reads relays without the flag', async () => {
      relayHolding([]);
      render(<MyKeep ownedPubkeys={[me.pk]} scope="id1" onBack={onBack} />);
      await screen.findByText('No Keep yet.');
      expect(screen.queryByTestId('keep-preview-banner')).not.toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalled();
    });

    it('with ?keep-preview shows the banner and both sample Keeps, without any relay read', async () => {
      window.history.replaceState({}, '', '/?keep-preview');
      render(<MyKeep ownedPubkeys={[me.pk]} scope="id1" onBack={onBack} />);
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
      render(<MyKeep ownedPubkeys={[me.pk]} scope="id1" onBack={onBack} />);
      const [first] = await screen.findAllByTestId('keep-row');
      fireEvent.click(first.querySelector('button')!);
      fireEvent.change(screen.getByLabelText('Nickname'), { target: { value: 'Study' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.getAllByTestId('keep-row')[0]).toHaveTextContent('Study');
    });
  });
});

