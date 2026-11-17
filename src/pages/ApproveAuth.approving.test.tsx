// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { ApproveAuth } from './ApproveAuth';
import type { SignetIdentity } from '../types';
import type { AuthRequest } from '../lib/qr-router';
import { SIGNER_WAITING_COPY } from '../lib/signer-error-copy';
import { HEARTWOOD_WAIT_HINT_DELAY_MS } from '../components/HeartwoodWaitHint';

/**
 * The approval screen must always end usable: a failed approval re-enables
 * Approve with the reason, and a failure that arrives after a lock remounted
 * the page (App hands it over as initialError) does the same — never a
 * permanent "Signing…".
 */

afterEach(cleanup);

const request: AuthRequest = {
  type: 'signet-auth-request',
  relays: [],
  requestId: 'f'.repeat(32),
  challenge: 'c'.repeat(64),
  origin: 'https://example.com',
  timestamp: Date.now(),
};

const identity = {
  id: 'a'.repeat(64),
  mnemonic: '',
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
  persona: { publicKey: 'b'.repeat(64), privateKey: '', displayName: 'Tree Persona' },
  primaryKeypair: 'persona',
  isChild: false,
  createdAt: 0,
  naturalPersonActive: false,
} as unknown as SignetIdentity;

function renderPage(onApprove: () => Promise<void>, initialError?: string) {
  return render(
    <ApproveAuth
      request={request}
      hasCredentialForSelection={() => false}
      identity={identity}
      canSwitchGuardianPersona={true}
      consumerHint={null}
      requireNpConfirmation={true}
      onApprove={onApprove}
      onDeny={vi.fn()}
      initialError={initialError}
    />,
  );
}

describe('ApproveAuth — approving state always resolves', () => {
  it('re-enables Approve and shows the reason when the approval fails', async () => {
    const onApprove = vi.fn(() => Promise.reject(new Error('Unlock Signet to sign as this persona — your signer reconnects after unlock.')));
    renderPage(onApprove);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByText(/Unlock Signet to sign as this persona/)).toBeTruthy());
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('a late failure handed over as initialError clears "Signing…"', async () => {
    const onApprove = vi.fn(() => new Promise<void>(() => { /* orphaned by a remount */ }));
    const { rerender } = renderPage(onApprove);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Signing…' })).toBeTruthy());
    rerender(
      <ApproveAuth
        request={request}
        hasCredentialForSelection={() => false}
        identity={identity}
        canSwitchGuardianPersona={true}
        consumerHint={null}
        requireNpConfirmation={true}
        onApprove={onApprove}
        onDeny={vi.fn()}
        initialError="Your signer is not reachable right now. Check it is online, then try again."
      />,
    );
    await waitFor(() => expect(screen.getByText(/signer is not reachable/)).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables Deny while signing, so a mid-sign tap cannot send a second answer', async () => {
    const onDeny = vi.fn();
    render(
      <ApproveAuth
        request={request}
        hasCredentialForSelection={() => false}
        identity={identity}
        canSwitchGuardianPersona={true}
        consumerHint={null}
        requireNpConfirmation={true}
        onApprove={() => new Promise<void>(() => {})}
        onDeny={onDeny}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Signing…' })).toBeTruthy());
    const deny = screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement;
    expect(deny.disabled).toBe(true);
    fireEvent.click(deny);
    expect(onDeny).not.toHaveBeenCalled();
  });

  it('paired-child: Cancel stays live while the approval is waiting on the guardian', async () => {
    const onDeny = vi.fn();
    render(
      <ApproveAuth
        request={request}
        hasCredentialForSelection={() => false}
        identity={identity}
        canSwitchGuardianPersona={true}
        consumerHint={null}
        requireNpConfirmation={true}
        onApprove={() => new Promise<void>(() => {})}
        onDeny={onDeny}
        isPairedChild={true}
      />,
    );
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
      // The waiting surface offers Cancel after its long-wait threshold.
      await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    } finally {
      vi.useRealTimers();
    }
    const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it('an approval already in flight in App shows "Signing…" on a remounted page, not a fresh Approve', () => {
    const onApprove = vi.fn();
    render(
      <ApproveAuth
        request={request}
        hasCredentialForSelection={() => false}
        identity={identity}
        canSwitchGuardianPersona={true}
        consumerHint={null}
        requireNpConfirmation={true}
        onApprove={onApprove}
        onDeny={vi.fn()}
        externallyApproving={true}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Signing…' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onApprove).not.toHaveBeenCalled();
  });
});

describe('ApproveAuth — Heartwood press hint', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function renderSigner(heartwoodSigner: boolean) {
    render(
      <ApproveAuth
        request={request}
        hasCredentialForSelection={() => false}
        identity={identity}
        canSwitchGuardianPersona={true}
        consumerHint={null}
        requireNpConfirmation={true}
        onApprove={() => new Promise<void>(() => {})}
        onDeny={vi.fn()}
        heartwoodSigner={heartwoodSigner}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  }

  it('tells the user to press the Heartwood button after a few seconds of Signing…', () => {
    renderSigner(true);
    expect(screen.getByRole('button', { name: 'Signing…' })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(HEARTWOOD_WAIT_HINT_DELAY_MS - 1); });
    expect(screen.queryByText(SIGNER_WAITING_COPY)).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByText(SIGNER_WAITING_COPY)).toBeTruthy();
  });

  it('never shows the hint when the sign is not on a Heartwood', () => {
    renderSigner(false);
    expect(screen.getByRole('button', { name: 'Signing…' })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(HEARTWOOD_WAIT_HINT_DELAY_MS * 3); });
    expect(screen.queryByText(SIGNER_WAITING_COPY)).toBeNull();
  });
});
