// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ApprovalOverlay } from './ApprovalOverlay';
import type { AuthRequest } from '../lib/qr-router';
import type { ResolvedIdentity } from '../lib/carousel-utils';

afterEach(cleanup);

const request: AuthRequest = {
  type: 'signet-auth-request',
  relays: [],
  requestId: 'f'.repeat(32),
  challenge: 'c'.repeat(64),
  origin: 'https://kithmoot.com',
  timestamp: Date.now(),
};

const active = { displayName: 'Tree Persona', displayNameIsSet: true, publicKey: 'b'.repeat(64), type: 'Persona', isDependant: false } as ResolvedIdentity;

function renderOverlay(props: Partial<React.ComponentProps<typeof ApprovalOverlay>> = {}) {
  const onOpenFullPicker = vi.fn();
  const onApprove = vi.fn();
  render(
    <ApprovalOverlay
      request={request}
      siteName="kithmoot.com"
      activeIdentity={active}
      consumerHint={null}
      requireNpConfirmation={true}
      onOpenFullPicker={onOpenFullPicker}
      onApprove={onApprove}
      onDeny={vi.fn()}
      {...props}
    />,
  );
  return { onOpenFullPicker, onApprove };
}

describe('ApprovalOverlay — let it sign on my Heartwood', () => {
  it('has no extra link when the hand-off is not offered', () => {
    renderOverlay();
    expect(screen.queryByText(/sign on my Heartwood/)).toBeNull();
  });

  it('adds one secondary link to the full picker when offered, and Approve still approves as before', () => {
    const { onOpenFullPicker, onApprove } = renderOverlay({ heartwoodLinkOffered: true });
    fireEvent.click(screen.getByText('Let it sign on my Heartwood…'));
    expect(onOpenFullPicker).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });
});
