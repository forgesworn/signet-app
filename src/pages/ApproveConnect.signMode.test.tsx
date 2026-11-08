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

function renderPage(onApprove = vi.fn((_s: unknown, _o: { askToSign: boolean }) => Promise.resolve())) {
  render(
    <ApproveConnect
      request={request}
      identity={identity}
      canSwitchGuardianPersona={true}
      availableGuardianPubkeys={[PERSONA]}
      requireNpConfirmation={true}
      onApprove={onApprove}
      onDeny={vi.fn()}
    />,
  );
  return onApprove;
}

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
    expect(onApprove.mock.calls[0][1]).toEqual({ askToSign: false });
  });

  it('passes askToSign true when "Ask me each time" is chosen', async () => {
    const onApprove = renderPage();
    fireEvent.click(screen.getByLabelText('Ask me each time it signs'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove.mock.calls[0][1]).toEqual({ askToSign: true });
  });
});
