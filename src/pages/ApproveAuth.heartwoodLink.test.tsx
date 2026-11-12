// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ApproveAuth } from './ApproveAuth';
import type { SignetIdentity } from '../types';
import type { AuthRequest } from '../lib/qr-router';
import type { SignInAppPermission } from '../lib/sign-in-app-permission';
import { handoffWarning } from '../lib/heartwood-handoff';
import { signInLinkUnverifiedOriginCopy } from '../lib/heartwood-signin-link';

/**
 * "How {site} signs": the straight-to-Heartwood choice is offered only when the
 * app says it can be, is never the default, warns while selected, and reaches
 * onApprove only when chosen.
 */

afterEach(cleanup);

const base: AuthRequest = {
  type: 'signet-auth-request',
  relays: [],
  requestId: 'f'.repeat(32),
  challenge: 'c'.repeat(64),
  origin: 'https://kithmoot.com',
  timestamp: Date.now(),
};
// How a request arrives decides what can be offered: a redirect callback is held to the origin;
// a relay/QR request names its own; a bare same-device request has nowhere to put a link.
const redirectRequest = { ...base, callbackUrl: 'https://kithmoot.com/cb' } as AuthRequest;
const relayRequest = { ...base, relay: 'wss://relay.example', sessionPubkey: 'd'.repeat(64) } as AuthRequest;
const bareRequest = base;
const request = redirectRequest;

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
    expect(can).toHaveBeenCalledWith(PERSONA, 'persona');
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

  it('names the second option Through My Signet when the in-page Bunker is on, on a relay request', () => {
    renderPage({ request: relayRequest, canSignOnHeartwood: () => true, bunkerServerOn: true });
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

describe('ApproveAuth — straight to my Heartwood: where the request came from', () => {
  it('on a redirect request the second option is always Sign in only, even with the in-page Bunker on', () => {
    renderPage({ request: redirectRequest, canSignOnHeartwood: () => true, bunkerServerOn: true });
    expect(screen.getByLabelText(/Sign in only/)).toBeTruthy();
    expect(screen.queryByText(/Through My Signet/)).toBeNull();
  });

  it('is never offered for a request with nowhere to put a link (no callback, no relay)', () => {
    const can = vi.fn(() => true);
    renderPage({ request: bareRequest, canSignOnHeartwood: can });
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('is never offered for the real identity, and the app is not even asked', () => {
    const can = vi.fn(() => true);
    const active = { ...identity, naturalPersonActive: true, naturalPerson: { ...identity.naturalPerson, displayName: 'Real Name' } } as unknown as SignetIdentity;
    renderPage({ canSignOnHeartwood: can, identity: active, requireNpConfirmation: false, consumerHint: { allow: ['natural-person'] }, defaultSelection: { source: 'guardian', keypairType: 'natural-person' } });
    expect(screen.getAllByText(/Real Name/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(can).not.toHaveBeenCalled();
  });

  it('says the origin is unverified under Straight on a relay/QR request, whether or not Straight is selected', () => {
    renderPage({ request: relayRequest, canSignOnHeartwood: () => true });
    const copy = signInLinkUnverifiedOriginCopy('kithmoot.com');
    expect(copy).toBe("My Signet can't confirm this request came from kithmoot.com. Choose this only if you started signing in on kithmoot.com yourself.");
    expect(screen.getByText(copy)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Straight to my Heartwood/));
    expect(screen.getByText(copy)).toBeTruthy();
  });

  it('does not say it on a redirect request, where the callback is held to the origin', () => {
    renderPage({ request: redirectRequest, canSignOnHeartwood: () => true });
    expect(screen.queryByText(/can't confirm this request came from/)).toBeNull();
  });
});
