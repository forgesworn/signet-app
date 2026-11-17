// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ApprovalOverlay } from './ApprovalOverlay';
import type { AuthRequest } from '../lib/qr-router';
import { SIGN_IN_LINK_NEEDS_UPDATE_OVERLAY_COPY } from '../lib/heartwood-signin-link';
import { SIGNER_WAITING_COPY } from '../lib/signer-error-copy';
import { HEARTWOOD_WAIT_HINT_DELAY_MS } from './HeartwoodWaitHint';
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

  it('when offered and pre-selected, the primary button is Continue, opens the full picker and never approves; no secondary link', () => {
    const { onOpenFullPicker, onApprove } = renderOverlay({ heartwoodLinkOffered: true });
    expect(screen.queryByText('Let it sign on my Heartwood…')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onOpenFullPicker).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('when offered but not pre-selected, adds one secondary link to the full picker and Approve still approves as before', () => {
    const { onOpenFullPicker, onApprove } = renderOverlay({ heartwoodLinkOffered: true, heartwoodByDefault: false });
    fireEvent.click(screen.getByText('Let it sign on my Heartwood…'));
    expect(onOpenFullPicker).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('not offered: unchanged even with the default flag on', () => {
    const { onApprove } = renderOverlay({ heartwoodByDefault: true });
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });
});

describe('ApprovalOverlay — straight to my Heartwood needs an update', () => {
  it('shows a non-interactive line and leaves Approve as it was', () => {
    const { onApprove, onOpenFullPicker } = renderOverlay({ heartwoodNeedsUpdate: true });
    expect(screen.getByTestId('overlay-straight-needs-update').textContent).toBe(SIGN_IN_LINK_NEEDS_UPDATE_OVERLAY_COPY);
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onOpenFullPicker).not.toHaveBeenCalled();
  });

  it('is hidden when the link is offered', () => {
    renderOverlay({ heartwoodNeedsUpdate: true, heartwoodLinkOffered: true, heartwoodByDefault: false });
    expect(screen.queryByTestId('overlay-straight-needs-update')).toBeNull();
  });

  it('is hidden when the prop is false or absent', () => {
    renderOverlay({ heartwoodNeedsUpdate: false });
    expect(screen.queryByTestId('overlay-straight-needs-update')).toBeNull();
    cleanup();
    renderOverlay();
    expect(screen.queryByTestId('overlay-straight-needs-update')).toBeNull();
  });
});

describe('ApprovalOverlay — Heartwood press hint', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('says to press the Heartwood button after a few seconds of Signing…', () => {
    vi.useFakeTimers();
    renderOverlay({ heartwoodSigner: true });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByRole('button', { name: 'Signing…' })).toBeTruthy();
    expect(screen.queryByText(SIGNER_WAITING_COPY)).toBeNull();
    act(() => { vi.advanceTimersByTime(HEARTWOOD_WAIT_HINT_DELAY_MS); });
    expect(screen.getByText(SIGNER_WAITING_COPY)).toBeTruthy();
  });

  it('stays silent without heartwoodSigner', () => {
    vi.useFakeTimers();
    renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    act(() => { vi.advanceTimersByTime(HEARTWOOD_WAIT_HINT_DELAY_MS * 3); });
    expect(screen.queryByText(SIGNER_WAITING_COPY)).toBeNull();
  });
});
