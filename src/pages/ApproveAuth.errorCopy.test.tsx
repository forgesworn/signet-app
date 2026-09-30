// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ApproveAuth } from './ApproveAuth';
import type { SignetIdentity } from '../types';
import type { AuthRequest } from '../lib/qr-router';
import { SIGNER_TIMEOUT_COPY } from '../lib/signer-error-copy';

afterEach(cleanup);

const mkRequest = (n: string): AuthRequest => ({
  type: 'signet-auth-request',
  requestId: n.repeat(32),
  challenge: n.repeat(64),
  origin: 'https://example.com',
  timestamp: Date.now(),
});

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

function page(request: AuthRequest, onApprove: () => Promise<void>, initialError?: string) {
  return (
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
    />
  );
}

describe('ApproveAuth — signer error copy and reset', () => {
  it('shows plain copy, not a bare "timeout", when the Heartwood does not answer', async () => {
    const onApprove = vi.fn(() => Promise.reject(new Error('timeout')));
    render(page(mkRequest('f'), onApprove));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByText(SIGNER_TIMEOUT_COPY)).toBeTruthy());
    expect(screen.queryByText('timeout')).toBeNull();
  });

  it('maps a raw timeout handed over as initialError too', () => {
    render(page(mkRequest('f'), vi.fn(), 'timeout'));
    expect(screen.getByText(SIGNER_TIMEOUT_COPY)).toBeTruthy();
  });

  it('clears the previous error when a new request replaces the one on screen', async () => {
    const onApprove = vi.fn(() => Promise.reject(new Error('Something else went wrong')));
    const { rerender } = render(page(mkRequest('f'), onApprove));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByText('Something else went wrong')).toBeTruthy());
    rerender(page(mkRequest('e'), onApprove));
    await waitFor(() => expect(screen.queryByText('Something else went wrong')).toBeNull());
  });
});
