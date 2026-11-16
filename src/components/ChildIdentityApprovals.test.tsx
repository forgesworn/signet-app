// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ChildIdentityApprovals } from './ChildIdentityApprovals';
import { CHILD_READY_COPY as COPY } from '../lib/child-ready-copy';
import { deviceShortNpub, type ReadyRow } from '../lib/child-ready-check';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32), C = 'cc'.repeat(32);
const row = (pubkey: string, name: string, state: ReadyRow['state'], extra: Partial<ReadyRow> = {}): ReadyRow =>
  ({ pubkey, name, who: 'child', state, verified: false, ...extra });

describe('ChildIdentityApprovals (ready checklist)', () => {
  it('lists every identity as waiting for a press / ready / skipped, with the Heartwood card identity line', () => {
    render(<ChildIdentityApprovals rows={[row(A, 'Ally', 'waiting'), row(B, 'Gamer', 'ready'), row(C, 'Sky', 'skipped')]} onRetry={() => {}} />);
    expect(within(screen.getByTestId(`ready-row-${A}`)).getByText(COPY.state.waiting)).toBeTruthy();
    expect(within(screen.getByTestId(`ready-row-${B}`)).getByText(COPY.state.ready)).toBeTruthy();
    expect(within(screen.getByTestId(`ready-row-${C}`)).getByText(COPY.state.skipped)).toBeTruthy();
    expect(screen.getByText(COPY.onHeartwood(deviceShortNpub(A)))).toBeTruthy();
    expect(deviceShortNpub(A)).toMatch(/^npub1[a-z0-9]{8}\.\.$/);
  });

  it('offers Later on a pending child row and reports it; never on the guardian row, which shows no npub', () => {
    const onDefer = vi.fn();
    render(<ChildIdentityApprovals rows={[row(A, 'Ally', 'waiting'), row(B, 'You', 'waiting', { who: 'guardian' })]} onDefer={onDefer} />);
    expect(screen.getAllByText(COPY.later)).toHaveLength(1);
    expect(screen.queryByText(COPY.onHeartwood(deviceShortNpub(B)))).toBeNull();
    fireEvent.click(screen.getByText(COPY.later));
    expect(onDefer).toHaveBeenCalledWith(A);
  });

  it('a failed row offers Try again, a skipped one Approve now', () => {
    const onRetry = vi.fn();
    render(<ChildIdentityApprovals rows={[row(A, 'Ally', 'waiting', { failed: true }), row(B, 'Gamer', 'skipped')]} onRetry={onRetry} />);
    fireEvent.click(screen.getByText(COPY.retry));
    fireEvent.click(screen.getByText(COPY.approveNow));
    expect(onRetry.mock.calls).toEqual([[A], [B]]);
  });

  it('only the row waiting on the device says to press and hold', () => {
    render(<ChildIdentityApprovals rows={[row(A, 'Ally', 'waiting', { probing: true }), row(B, 'Gamer', 'waiting')]} />);
    expect(screen.getAllByText(COPY.pressAndHold)).toHaveLength(1);
    expect(within(screen.getByTestId(`ready-row-${A}`)).getByText(COPY.pressAndHold)).toBeTruthy();
  });
});
