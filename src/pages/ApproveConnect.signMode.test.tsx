// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ApproveConnect } from './ApproveConnect';
import type { SignetIdentity } from '../types';
import type { NostrConnectRequest } from '../lib/nip46';

afterEach(cleanup);

const PERSONA = 'b'.repeat(64);
const request: NostrConnectRequest = {
  clientPubkey: '1'.repeat(64),
  relayUrl: 'wss://relay.example.com',
  relayUrls: ['wss://relay.example.com'],
  secret: 's3cret',
  appName: 'Test App',
};
const identity = {
  id: 'a'.repeat(64),
  mnemonic: '',
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
  persona: { publicKey: PERSONA, privateKey: '', displayName: 'C1 Burner' },
  primaryKeypair: 'persona',
  isChild: false,
  createdAt: 0,
  naturalPersonActive: false,
} as unknown as SignetIdentity;

function renderPage(
  onApprove = vi.fn((_s: unknown, _o: { askToSign: boolean; viaHeartwood?: boolean }) => Promise.resolve()),
  canHandOffToHeartwood?: (pk: string) => boolean,
  waitingGuardianPubkeys?: string[],
  req: NostrConnectRequest = request,
) {
  render(
    <ApproveConnect
      request={req}
      identity={identity}
      canSwitchGuardianPersona={true}
      availableGuardianPubkeys={[PERSONA]}
      requireNpConfirmation={true}
      onApprove={onApprove}
      onDeny={vi.fn()}
      canHandOffToHeartwood={canHandOffToHeartwood}
      waitingGuardianPubkeys={waitingGuardianPubkeys}
    />,
  );
  return onApprove;
}

const scoped: NostrConnectRequest = { ...request, permissions: ['sign_event:1', 'nip44_encrypt'] };

describe('ApproveConnect sign-mode control', () => {
  it('offers both options with automatic selected by default, and the crypto line', () => {
    renderPage();
    const auto = screen.getByLabelText('Sign automatically for this app') as HTMLInputElement;
    const ask = screen.getByLabelText('Ask me each time it signs') as HTMLInputElement;
    expect(auto.checked).toBe(true);
    expect(ask.checked).toBe(false);
    expect(screen.getByText('Encrypting and decrypting stay automatic either way.')).toBeTruthy();
  });

  it('approves with askToSign false by default', async () => {
    const onApprove = renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove.mock.calls[0][1]).toEqual({ askToSign: false, viaHeartwood: false });
  });

  it('passes askToSign true when "Ask me each time" is chosen', async () => {
    const onApprove = renderPage();
    fireEvent.click(screen.getByLabelText('Ask me each time it signs'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove.mock.calls[0][1]).toEqual({ askToSign: true, viaHeartwood: false });
  });

  it('with a Heartwood that holds the key, defaults to Straight to my Heartwood for an app that asks for nothing the phone asks about', async () => {
    const onApprove = renderPage(undefined, (pk) => pk === PERSONA, undefined, scoped);
    expect(screen.queryByRole('note')).toBeNull();
    expect((screen.getByLabelText(/Straight to my Heartwood/) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove.mock.calls[0][1]).toEqual({ askToSign: false, viaHeartwood: true });
  });

  it('can still go through My Signet when a Heartwood is offered', async () => {
    const onApprove = renderPage(undefined, () => true);
    fireEvent.click(screen.getByLabelText('Through My Signet, ask me each time it signs'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove.mock.calls[0][1]).toEqual({ askToSign: true, viaHeartwood: false });
  });

  it('a key whose phone route is still coming back can go straight to the Heartwood', async () => {
    const onApprove = renderPage(undefined, () => true, [PERSONA], scoped);
    expect(screen.getByText('Waiting for your Heartwood…')).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(onApprove).toHaveBeenCalled());
    expect(onApprove.mock.calls[0][1]).toEqual({ askToSign: false, viaHeartwood: true });
  });

  it('the same waiting key holds Approve again once Through My Signet is chosen', () => {
    renderPage(undefined, () => true, [PERSONA], scoped);
    fireEvent.click(screen.getByLabelText('Through My Signet, automatically'));
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('an app with no permission list is still offered the Heartwood, but My Signet stays the default', async () => {
    const onApprove = renderPage(undefined, () => true);
    expect((screen.getByLabelText(/Straight to my Heartwood/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Through My Signet, automatically') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.click(screen.getByLabelText(/Straight to my Heartwood/));
    expect(screen.getByRole('note').textContent).toBe(
      'Your Heartwood will sign anything this app asks, without a press, including profile changes, deletions and pairing other devices.');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove.mock.calls[0][1]).toEqual({ askToSign: false, viaHeartwood: true });
  });

  it('an app that lists deletions is warned about just those, and the phone-side line goes', () => {
    renderPage(undefined, () => true, undefined, { ...request, permissions: ['sign_event:1', 'sign_event:5'] });
    expect(screen.getByText(/deletions still need a separate approval/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Straight to my Heartwood/));
    expect(screen.getByRole('note').textContent).toBe('Your Heartwood will sign deletions for this app, without a press.');
    expect(screen.queryByText(/deletions still need a separate approval/)).toBeNull();
  });
});
