// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ApproveAuth } from './ApproveAuth';
import type { SignetIdentity } from '../types';
import type { AuthRequest } from '../lib/qr-router';
import type { SignInAppPermission } from '../lib/sign-in-app-permission';
import { handoffWarning } from '../lib/heartwood-handoff';

/**
 * "How {site} signs": the straight-to-Heartwood choice is offered only when the
 * app says it can be, is never the default, warns while selected, and reaches
 * onApprove only when chosen.
 */

afterEach(cleanup);

const request: AuthRequest = {
  type: 'signet-auth-request',
  relays: [],
  requestId: 'f'.repeat(32),
  challenge: 'c'.repeat(64),
  origin: 'https://kithmoot.com',
  timestamp: Date.now(),
};

const PERSONA = 'b'.repeat(64);
const identity = {
  id: 'a'.repeat(64),
  mnemonic: '',
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
  persona: { publicKey: PERSONA, privateKey: '', displayName: 'Tree Persona' },
  primaryKeypair: 'persona',
  isChild: false,
  createdAt: 0,
  naturalPersonActive: false,
} as unknown as SignetIdentity;

const WARNING = handoffWarning({ kind: 'wide', covers: 'everything' })!;

function renderPage(props: Partial<React.ComponentProps<typeof ApproveAuth>> = {}) {
  const onApprove = vi.fn(async () => {});
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
      {...props}
    />,
  );
  return onApprove;
}

describe('ApproveAuth — straight to my Heartwood', () => {
  it('shows no choice when it is not offered', () => {
    renderPage();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByText('Straight to my Heartwood')).toBeNull();
  });

  it('shows no choice when the app says it cannot be given for this pubkey', () => {
    const can = vi.fn(() => false);
    renderPage({ canSignOnHeartwood: can });
    expect(can).toHaveBeenCalledWith(PERSONA);
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('shows the group when offered, with the second option the default (Sign in only, Bunker off)', () => {
    renderPage({ canSignOnHeartwood: () => true });
    expect(screen.getByRole('radiogroup', { name: 'How kithmoot.com signs' })).toBeTruthy();
    const straight = screen.getByLabelText(/Straight to my Heartwood/) as HTMLInputElement;
    const second = screen.getByLabelText(/Sign in only/) as HTMLInputElement;
    expect(straight.checked).toBe(false);
    expect(second.checked).toBe(true);
    expect(screen.getByText("kithmoot.com learns who you are but can't sign anything for you.")).toBeTruthy();
    expect(screen.getByText(/kithmoot\.com signs with your Heartwood directly, and My Signet can be closed\. The first time it signs, your Heartwood asks you to hold its button down once\./)).toBeTruthy();
  });

  it('names the second option Through My Signet when the in-page Bunker is on', () => {
    renderPage({ canSignOnHeartwood: () => true, bunkerServerOn: true });
    const second = screen.getByLabelText(/Through My Signet/) as HTMLInputElement;
    expect(second.checked).toBe(true);
    expect(screen.getByText('My Signet has to stay open to answer.')).toBeTruthy();
    expect(screen.queryByText(/Sign in only/)).toBeNull();
  });

  it('shows the warning only while Straight is selected', () => {
    renderPage({ canSignOnHeartwood: () => true });
    expect(screen.queryByText(WARNING)).toBeNull();
    fireEvent.click(screen.getByLabelText(/Straight to my Heartwood/));
    expect(screen.getByText(WARNING)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Sign in only/));
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it('approves exactly as before by default (no fourth argument)', async () => {
    const onApprove = renderPage({ canSignOnHeartwood: () => true });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove.mock.calls[0]).toHaveLength(2);
  });

  it('passes the choice to onApprove when Straight is selected', async () => {
    const onApprove = renderPage({ canSignOnHeartwood: () => true });
    fireEvent.click(screen.getByLabelText(/Straight to my Heartwood/));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove).toHaveBeenCalledWith({ source: 'guardian', keypairType: 'persona' }, true, undefined, true);
  });

  it('is not offered on the combined online-play sign-in', () => {
    const appPermission = { v: 1, permission: 'online-play' } as unknown as SignInAppPermission;
    renderPage({ canSignOnHeartwood: () => true, appPermission });
    expect(screen.queryByRole('radiogroup', { name: /signs/ })).toBeNull();
  });
});
