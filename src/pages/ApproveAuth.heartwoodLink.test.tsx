// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ApproveAuth } from './ApproveAuth';
import type { SignetIdentity } from '../types';
import type { AuthRequest } from '../lib/qr-router';
import type { SignInAppPermission } from '../lib/sign-in-app-permission';
import { handoffWarning } from '../lib/heartwood-handoff';
import { signInLinkUnverifiedOriginCopy, SIGN_IN_LINK_NEEDS_UPDATE_COPY, SIGN_IN_LINK_DECRYPT_NOTE, type SignInLinkUnavailableReason } from '../lib/heartwood-signin-link';
import { signInLinkHoldCopy } from '../lib/heartwood-site-link';
import { SIGNER_WAITING_COPY } from '../lib/signer-error-copy';

/**
 * "How {site} signs": the straight-to-Heartwood choice is offered only when the
 * app says it can be, is pre-selected (unless `heartwoodByDefault` is false), warns while
 * selected, and reaches onApprove whenever it is the effective choice.
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

  it('shows the group when offered, with Straight pre-selected and the warning showing', () => {
    renderPage({ canSignOnHeartwood: () => true });
    expect(screen.getByRole('radiogroup', { name: 'How kithmoot.com signs' })).toBeTruthy();
    const straight = screen.getByLabelText(/Straight to my Heartwood/) as HTMLInputElement;
    const second = screen.getByLabelText(/Sign in only/) as HTMLInputElement;
    expect(straight.checked).toBe(true);
    expect(second.checked).toBe(false);
    expect(screen.getByText(WARNING)).toBeTruthy();
    expect(screen.getByText("kithmoot.com learns who you are but can't sign anything for you.")).toBeTruthy();
    expect(screen.getByText(/kithmoot\.com signs with your Heartwood directly, and My Signet can be closed\. The first time it signs, your Heartwood asks you to hold its button down once\./)).toBeTruthy();
  });

  it('with heartwoodByDefault false the second option is checked and there is no warning', () => {
    renderPage({ canSignOnHeartwood: () => true, heartwoodByDefault: false });
    expect((screen.getByLabelText(/Straight to my Heartwood/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/Sign in only/) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it('a heartwoodByDefault that changes after mount applies until the user picks', () => {
    const onApprove = vi.fn(async () => {});
    const props = { request, hasCredentialForSelection: () => false, identity, canSwitchGuardianPersona: true, consumerHint: null, requireNpConfirmation: true, onApprove, onDeny: vi.fn(), canSignOnHeartwood: () => true };
    const { rerender } = render(<ApproveAuth {...props} heartwoodByDefault={false} />);
    expect((screen.getByLabelText(/Sign in only/) as HTMLInputElement).checked).toBe(true);
    rerender(<ApproveAuth {...props} heartwoodByDefault={true} />);
    expect((screen.getByLabelText(/Straight to my Heartwood/) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText(/Sign in only/));
    rerender(<ApproveAuth {...props} heartwoodByDefault={true} />);
    expect((screen.getByLabelText(/Sign in only/) as HTMLInputElement).checked).toBe(true);
  });

  it('names the second option Through My Signet when the in-page Bunker is on, on a relay request', () => {
    renderPage({ request: relayRequest, canSignOnHeartwood: () => true, bunkerServerOn: true });
    const second = screen.getByLabelText(/Through My Signet/) as HTMLInputElement;
    expect(second.checked).toBe(false);
    expect(screen.getByText('My Signet has to stay open to answer.')).toBeTruthy();
    expect(screen.queryByText(/Sign in only/)).toBeNull();
  });

  it('shows the warning only while Straight is selected', () => {
    renderPage({ canSignOnHeartwood: () => true });
    expect(screen.getByText(WARNING)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Sign in only/));
    expect(screen.queryByText(WARNING)).toBeNull();
    fireEvent.click(screen.getByLabelText(/Straight to my Heartwood/));
    expect(screen.getByText(WARNING)).toBeTruthy();
  });

  it('approving untouched sends signOnHeartwood: true', async () => {
    const onApprove = renderPage({ canSignOnHeartwood: () => true });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove).toHaveBeenCalledWith({ source: 'guardian', keypairType: 'persona' }, true, undefined, true);
  });

  it('picking the other option approves exactly as before (no fourth argument)', async () => {
    const onApprove = renderPage({ canSignOnHeartwood: () => true });
    fireEvent.click(screen.getByLabelText(/Sign in only/));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove.mock.calls[0]).toHaveLength(2);
  });

  it('with heartwoodByDefault false, approving untouched sends no fourth argument', async () => {
    const onApprove = renderPage({ canSignOnHeartwood: () => true, heartwoodByDefault: false });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove.mock.calls[0]).toHaveLength(2);
  });

  it('a new request resets a pick back to the default', () => {
    const onApprove = vi.fn(async () => {});
    const props = { hasCredentialForSelection: () => false, identity, canSwitchGuardianPersona: true, consumerHint: null, requireNpConfirmation: true, onApprove, onDeny: vi.fn(), canSignOnHeartwood: () => true };
    const { rerender } = render(<ApproveAuth {...props} request={request} />);
    fireEvent.click(screen.getByLabelText(/Sign in only/));
    expect((screen.getByLabelText(/Sign in only/) as HTMLInputElement).checked).toBe(true);
    rerender(<ApproveAuth {...props} request={{ ...request, requestId: 'e'.repeat(32), challenge: 'd'.repeat(64) } as AuthRequest} />);
    expect((screen.getByLabelText(/Straight to my Heartwood/) as HTMLInputElement).checked).toBe(true);
  });

  it('is not offered on the combined online-play sign-in', () => {
    const appPermission = { v: 1, permission: 'online-play' } as unknown as SignInAppPermission;
    renderPage({ canSignOnHeartwood: () => true, appPermission });
    expect(screen.queryByRole('radiogroup', { name: /signs/ })).toBeNull();
  });
});

describe('ApproveAuth — straight to my Heartwood: the choice survives a remount of the same request', () => {
  const props = { request, hasCredentialForSelection: () => false, identity, canSwitchGuardianPersona: true, consumerHint: null, requireNpConfirmation: true, onDeny: vi.fn(), canSignOnHeartwood: () => true };

  it('a "Sign in only" pick is kept across an unmount/remount, even with an initialError, and approves with no fourth argument', async () => {
    let held: 'heartwood' | 'other' | null = null;
    const first = render(<ApproveAuth {...props} onApprove={vi.fn(async () => {})} onSignChoice={(c) => { held = c; }} />);
    fireEvent.click(screen.getByLabelText(/Sign in only/));
    expect(held).toBe('other');
    first.unmount();
    const onApprove = vi.fn(async () => {});
    render(<ApproveAuth {...props} onApprove={onApprove} signChoice={held} onSignChoice={() => {}} initialError="The sign failed." />);
    expect((screen.getByLabelText(/Sign in only/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/Straight to my Heartwood/) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText(WARNING)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove.mock.calls[0]).toHaveLength(2);
  });

  it('a "Straight" pick is kept across a remount when heartwoodByDefault is false', async () => {
    let held: 'heartwood' | 'other' | null = null;
    const first = render(<ApproveAuth {...props} heartwoodByDefault={false} onApprove={vi.fn(async () => {})} onSignChoice={(c) => { held = c; }} />);
    fireEvent.click(screen.getByLabelText(/Straight to my Heartwood/));
    expect(held).toBe('heartwood');
    first.unmount();
    const onApprove = vi.fn(async () => {});
    render(<ApproveAuth {...props} heartwoodByDefault={false} onApprove={onApprove} signChoice={held} onSignChoice={() => {}} initialError="The sign failed." />);
    expect((screen.getByLabelText(/Straight to my Heartwood/) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove).toHaveBeenCalledWith({ source: 'guardian', keypairType: 'persona' }, true, undefined, true);
  });
});

describe('ApproveAuth — straight to my Heartwood: nothing offered sends no fourth argument', () => {
  const EXTRA = 'e'.repeat(64);
  const withExtra = {
    ...identity,
    extraPersonas: [{ publicKey: EXTRA, privateKey: '', displayName: 'Tree Extra', derivationName: 'persona-1' }],
  } as unknown as SignetIdentity;

  it('with no canSignOnHeartwood, approving sends exactly two arguments', async () => {
    const onApprove = renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove.mock.calls[0]).toHaveLength(2);
  });

  it('with canSignOnHeartwood returning false, approving sends exactly two arguments', async () => {
    const onApprove = renderPage({ canSignOnHeartwood: () => false });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove.mock.calls[0]).toHaveLength(2);
  });

  it('switching to an identity where it is not offered hides the group and sends no fourth argument; switching back restores Straight', async () => {
    const onApprove = renderPage({ identity: withExtra, canSignOnHeartwood: (pk: string) => pk === PERSONA });
    expect((screen.getByLabelText(/Straight to my Heartwood/) as HTMLInputElement).checked).toBe(true);
    const rowFor = (name: string) => screen.getAllByText(name)
      .map(el => el.closest('button'))
      .find((b): b is HTMLButtonElement => !!b && b.textContent !== 'Approve')!;
    fireEvent.click(rowFor('Tree Extra'));
    expect(screen.queryByRole('radiogroup')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove.mock.calls[0]).toHaveLength(2);
    expect((onApprove.mock.calls[0] as unknown[])[0]).toEqual({ source: 'guardian', keypairType: EXTRA });
  });

  it('switching back to the identity where it is offered shows Straight checked again', () => {
    renderPage({ identity: withExtra, canSignOnHeartwood: (pk: string) => pk === PERSONA });
    const rowFor = (name: string) => screen.getAllByText(name)
      .map(el => el.closest('button'))
      .find((b): b is HTMLButtonElement => !!b && b.textContent !== 'Approve')!;
    fireEvent.click(rowFor('Tree Extra'));
    expect(screen.queryByRole('radiogroup')).toBeNull();
    fireEvent.click(rowFor('Tree Persona'));
    expect((screen.getByLabelText(/Straight to my Heartwood/) as HTMLInputElement).checked).toBe(true);
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
    expect(copy).toBe("My Signet can't confirm this request came from kithmoot.com. Use this only if you started signing in on kithmoot.com yourself.");
    expect(screen.getByText(copy)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Sign in only/));
    expect(screen.getByText(copy)).toBeTruthy();
  });

  it('does not say it on a redirect request, where the callback is held to the origin', () => {
    renderPage({ request: redirectRequest, canSignOnHeartwood: () => true });
    expect(screen.queryByText(/can't confirm this request came from/)).toBeNull();
  });
});

describe('ApproveAuth — straight to my Heartwood shown greyed out (no operator key)', () => {
  it('shows only the reason, with Straight disabled and unchecked and the other option checked', () => {
    const needs = vi.fn((): SignInLinkUnavailableReason | null => 'needs-update');
    renderPage({ heartwoodUnavailable: needs });
    expect(needs).toHaveBeenCalledWith(PERSONA, 'persona');
    expect(screen.getByRole('radiogroup', { name: 'How kithmoot.com signs' })).toBeTruthy();
    const straight = screen.getByLabelText(/Straight to my Heartwood/) as HTMLInputElement;
    const second = screen.getByLabelText(/Sign in only/) as HTMLInputElement;
    expect(straight.disabled).toBe(true);
    expect(straight.checked).toBe(false);
    expect(second.checked).toBe(true);
    expect(screen.getByTestId('sign-in-straight-unavailable').textContent).toBe(SIGN_IN_LINK_NEEDS_UPDATE_COPY);
    expect(screen.queryByText(WARNING)).toBeNull();
    expect(screen.queryByText(/signs with your Heartwood directly/)).toBeNull();
  });

  it('shows no unverified-origin note on a relay request', () => {
    renderPage({ request: relayRequest, heartwoodUnavailable: () => 'needs-update' });
    expect(screen.getByTestId('sign-in-straight-unavailable')).toBeTruthy();
    expect(screen.queryByText(/can't confirm this request came from/)).toBeNull();
  });

  it('approving never signs on the Heartwood, even with the default on', async () => {
    const onApprove = renderPage({ heartwoodUnavailable: () => 'needs-update', heartwoodByDefault: true });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove.mock.calls[0]).toHaveLength(2);
  });

  it('clicking the disabled Straight changes nothing', () => {
    renderPage({ heartwoodUnavailable: () => 'needs-update' });
    fireEvent.click(screen.getByLabelText(/Straight to my Heartwood/));
    expect((screen.getByLabelText(/Sign in only/) as HTMLInputElement).checked).toBe(true);
  });

  it('shows no group when the app says it does not need an update', () => {
    renderPage({ heartwoodUnavailable: () => null });
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('shows no group on a request that cannot carry a link, or on the combined online-play sign-in', () => {
    renderPage({ request: bareRequest, heartwoodUnavailable: () => 'needs-update' });
    expect(screen.queryByRole('radiogroup')).toBeNull();
    cleanup();
    const appPermission = { v: 1, permission: 'online-play' } as unknown as SignInAppPermission;
    renderPage({ heartwoodUnavailable: () => 'needs-update', appPermission });
    expect(screen.queryByRole('radiogroup', { name: /signs/ })).toBeNull();
  });

  it('when the offer holds, the offered layout wins over the greyed-out one', () => {
    renderPage({ canSignOnHeartwood: () => true, heartwoodUnavailable: () => 'needs-update' });
    expect((screen.getByLabelText(/Straight to my Heartwood/) as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByTestId('sign-in-straight-unavailable')).toBeNull();
  });
});

describe('ApproveAuth — each reason Straight is unavailable has its own line', () => {
  it.each<[SignInLinkUnavailableReason, string]>([
    ['needs-update', 'Your Heartwood needs a software update for this.'],
    ['not-owner', "This phone isn't paired with full access to your Heartwood."],
    ['no-answer', "Your Heartwood isn't answering."],
  ])('%s', (reason, copy) => {
    renderPage({ heartwoodUnavailable: () => reason });
    const line = screen.getByTestId('sign-in-straight-unavailable');
    expect(line.textContent).toBe(copy);
    expect(line.getAttribute('data-reason')).toBe(reason);
    expect((screen.getByLabelText(/Straight to my Heartwood/) as HTMLInputElement).disabled).toBe(true);
  });
});

describe('ApproveAuth — the hold line while the Heartwood makes the link', () => {
  it('shows the hold copy at once, in place of the generic hint, while a device mint waits', async () => {
    let finish: () => void = () => {};
    const onApprove = vi.fn(() => new Promise<void>(r => { finish = r; }));
    renderPage({ canSignOnHeartwood: () => true, heartwoodHoldHost: 'kithmoot.com', heartwoodSigner: true, onApprove });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByTestId('sign-in-straight-hold').textContent).toBe(signInLinkHoldCopy('kithmoot.com')));
    expect(screen.queryByText(SIGNER_WAITING_COPY)).toBeNull();
    finish();
  });

  it('no hold line when Straight is not the choice, or before the device is asked', async () => {
    const onApprove = vi.fn(() => new Promise<void>(() => {}));
    renderPage({ canSignOnHeartwood: () => true, heartwoodHoldHost: null, onApprove });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalled());
    expect(screen.queryByTestId('sign-in-straight-hold')).toBeNull();
  });
});

describe('ApproveAuth — what the link may do mentions decrypting (decision 10)', () => {
  it('the warning under Straight says the site can decrypt', () => {
    renderPage({ canSignOnHeartwood: () => true });
    expect(screen.getByTestId('sign-in-straight-decrypt').textContent).toBe(SIGN_IN_LINK_DECRYPT_NOTE);
  });
});
