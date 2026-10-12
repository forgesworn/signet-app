// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChildIdentityApprovals } from './ChildIdentityApprovals';
import { CHILD_SIDE_COPY as KID } from '../lib/child-device-copy';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);

describe('ChildIdentityApprovals', () => {
  it('offers Later on a pending row and reports it', () => {
    const onDefer = vi.fn();
    render(<ChildIdentityApprovals personas={[{ pubkey: A, name: 'Gamer', approval: 'waiting' }]} onRetry={() => {}} onDefer={onDefer} />);
    fireEvent.click(screen.getByText(KID.approvals.later));
    expect(onDefer).toHaveBeenCalledWith(A);
  });

  it('shows a deferred row with Approve now once every row is approved or deferred', () => {
    const onRetry = vi.fn();
    render(<ChildIdentityApprovals personas={[
      { pubkey: A, name: 'Gamer', approval: 'deferred' },
      { pubkey: B, name: 'Alice', approval: 'approved' },
    ]} onRetry={onRetry} onDefer={() => {}} />);
    expect(screen.getByText(KID.approvals.finishedHeading)).toBeTruthy();
    expect(screen.getByText(KID.approvals.deferred)).toBeTruthy();
    expect(screen.queryByText('Alice')).toBeNull();
    fireEvent.click(screen.getByText(KID.approvals.approveNow));
    expect(onRetry).toHaveBeenCalledWith(A);
  });

  it('renders nothing when everything is approved', () => {
    const { container } = render(<ChildIdentityApprovals personas={[{ pubkey: A, name: 'Gamer', approval: 'approved' }]} onRetry={() => {}} />);
    expect(container.innerHTML).toBe('');
  });
});
