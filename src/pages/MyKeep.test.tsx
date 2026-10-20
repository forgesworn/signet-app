// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { NostrEvent } from 'signet-protocol';
import { claimEvent, newKey, statusEvent } from '../lib/keep-fixtures';
import { KEEP_CLAIM_KIND, KEEP_RELAYS, KEEP_STATUS_KIND } from '../lib/keep-wire';

const fetchMock = vi.fn();
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

beforeEach(() => { fetchMock.mockReset(); localStorage.clear(); });
afterEach(cleanup);

describe('MyKeep', () => {
  it('shows the loading text first', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<MyKeep ownedPubkeys={[me.pk]} />);
    expect(screen.getByText(/Looking for your Keep/)).toBeInTheDocument();
  });

  it('shows the empty state with plain copy and the footnote', async () => {
    relayHolding([]);
    render(<MyKeep ownedPubkeys={[me.pk]} />);
    expect(await screen.findByText('No Keep yet.')).toBeInTheDocument();
    expect(screen.getByText('A Keep is a small device at home that looks after your things. You can set one up with the Bothy app.')).toBeInTheDocument();
    expect(screen.getByText('Managing a Keep from here is coming later.')).toBeInTheDocument();
  });

  it('queries claims by authors (never #p) on the Bothy relays, then statuses by node', async () => {
    const claim = claimEvent(me, node.pk);
    relayHolding([claim]);
    render(<MyKeep ownedPubkeys={[me.pk]} />);
    await screen.findByTestId('keep-row');
    const [claimCall, statusCall] = fetchMock.mock.calls;
    expect(claimCall[0]).toEqual([expect.objectContaining({ kinds: [KEEP_CLAIM_KIND], authors: [me.pk] })]);
    expect(JSON.stringify(claimCall[0])).not.toContain('#p');
    expect(claimCall[1]).toEqual({ relays: [...KEEP_RELAYS] });
    expect(statusCall[0]).toEqual([expect.objectContaining({ kinds: [KEEP_STATUS_KIND], authors: [node.pk] })]);
  });

  it('shows the error state with a working retry', async () => {
    relayHolding([], 0);
    render(<MyKeep ownedPubkeys={[me.pk]} />);
    expect(await screen.findByText("Couldn't reach the network. Try again.")).toBeInTheDocument();
    relayHolding([claimEvent(me, node.pk)]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('keep-row')).toBeInTheDocument();
  });

  it('lists an online home device with name, region, free space and software', async () => {
    const claim = claimEvent(me, node.pk, { name: 'Kitchen box', region: 'Scotland', role: 'box' });
    relayHolding([claim, statusEvent(node, claim.id, { createdAt: now - 60, free: 20 * 2 ** 30, software: 'bothy-node/0.1.0' })]);
    render(<MyKeep ownedPubkeys={[me.pk]} />);
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
    render(<MyKeep ownedPubkeys={[me.pk]} />);
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
    render(<MyKeep ownedPubkeys={[me.pk]} />);
    expect(await screen.findByTestId('keep-row')).toHaveTextContent('Not seen yet');
  });

  it('a local nickname overrides the name, persists on this device only, and can be cleared', async () => {
    const claim = claimEvent(me, node.pk, { name: 'Kitchen box' });
    relayHolding([claim]);
    const { unmount } = render(<MyKeep ownedPubkeys={[me.pk]} />);
    await screen.findByTestId('keep-row');
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Nickname'), { target: { value: 'Study' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByTestId('keep-row')).toHaveTextContent('Study');
    expect(screen.getByTestId('keep-row')).not.toHaveTextContent('Kitchen box');
    // Local storage only: nothing was published and the read path made no other call.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();

    render(<MyKeep ownedPubkeys={[me.pk]} />);
    expect(await screen.findByTestId('keep-row')).toHaveTextContent('Study');
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Nickname'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByTestId('keep-row')).toHaveTextContent('Kitchen box'));
  });
});
