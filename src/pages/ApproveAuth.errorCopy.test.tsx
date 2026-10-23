// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ApproveAuth } from './ApproveAuth';
import type { SignetIdentity } from '../types';
import type { AuthRequest } from '../lib/qr-router';
import { SIGNER_TIMEOUT_COPY, SIGNER_REAL_NAME_NEEDS_DEVICE_COPY } from '../lib/signer-error-copy';

afterEach(cleanup);

const mkRequest = (n: string): AuthRequest => ({
  type: 'signet-auth-request',
  relays: [],
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

  describe('A2: real-name first use on a Heartwood', () => {
    const npIdentity = {
      ...identity,
      naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'Real Name' },
      primaryKeypair: 'natural-person',
      naturalPersonActive: true,
    } as unknown as SignetIdentity;
    const npPage = (onApprove: () => Promise<void>, flag: boolean) => (
      <ApproveAuth
        request={mkRequest('f')}
        hasCredentialForSelection={() => false}
        identity={npIdentity}
        canSwitchGuardianPersona={true}
        consumerHint={null}
        requireNpConfirmation={false}
        preferPersonaForSignIns={false}
        onApprove={onApprove}
        onDeny={vi.fn()}
        realNameNeedsHeartwood={flag}
      />
    );

    const pickRealName = () => {
      const row = screen.getAllByText('Real Name').map(el => el.closest('button')).find((b): b is HTMLButtonElement => !!b && b.textContent !== 'Approve');
      expect(row).toBeTruthy();
      fireEvent.click(row!);
    };

    it('a timed-out real-name sign-in says it needs the Heartwood', async () => {
      render(npPage(vi.fn(() => Promise.reject(new Error('timeout'))), true));
      pickRealName();
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
      await waitFor(() => expect(screen.getByText(SIGNER_REAL_NAME_NEEDS_DEVICE_COPY)).toBeTruthy());
    });

    it('without the flag the generic timeout line stays', async () => {
      render(npPage(vi.fn(() => Promise.reject(new Error('timeout'))), false));
      pickRealName();
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
      await waitFor(() => expect(screen.getByText(SIGNER_TIMEOUT_COPY)).toBeTruthy());
    });

    it('a persona sign-in keeps the generic line even with the flag', async () => {
      const onApprove = vi.fn(() => Promise.reject(new Error('timeout')));
      render(<ApproveAuth request={mkRequest('f')} hasCredentialForSelection={() => false} identity={identity}
        canSwitchGuardianPersona={true} consumerHint={null} requireNpConfirmation={true}
        onApprove={onApprove} onDeny={vi.fn()} realNameNeedsHeartwood />);
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
      await waitFor(() => expect(screen.getByText(SIGNER_TIMEOUT_COPY)).toBeTruthy());
    });
  });
});
