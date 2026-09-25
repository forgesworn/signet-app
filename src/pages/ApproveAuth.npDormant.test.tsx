// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApproveAuth } from './ApproveAuth';
import type { SignetIdentity, ConsumerHint } from '../types';
import type { AuthRequest } from '../lib/qr-router';

/**
 * The empty state's natural-person fallback is the one remaining control that
 * can put the guardian's real identity on the wire after every picker row has
 * been filtered out. A dormant real identity must not be reachable from it
 * either (spec §6) — otherwise excluding the NP from the picker just moves the
 * leak one card down the page.
 */

const request: AuthRequest = {
  type: 'signet-auth-request',
  requestId: 'f'.repeat(32),
  challenge: 'c'.repeat(64),
  origin: 'https://example.com',
  timestamp: Date.now(),
};

function identityWith(o: Partial<SignetIdentity>): SignetIdentity {
  return {
    id: 'a'.repeat(64),
    mnemonic: '',
    naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
    persona: { publicKey: '', privateKey: '', displayName: '' },
    primaryKeypair: 'persona',
    isChild: false,
    createdAt: 0,
    ...o,
  } as SignetIdentity;
}

function renderEmptyState(identity: SignetIdentity, hint: ConsumerHint) {
  render(
    <ApproveAuth
      request={request}
      hasCredentialForSelection={() => false}
      identity={identity}
      canSwitchGuardianPersona={true}
      consumerHint={hint}
      requireNpConfirmation={true}
      onApprove={vi.fn()}
      onDeny={vi.fn()}
    />,
  );
}

describe('ApproveAuth empty state — dormant real identity', () => {
  it('does not offer the real-identity fallback while the slot is dormant', () => {
    renderEmptyState(
      identityWith({ naturalPersonActive: false }),
      { allow: ['persona'] },
    );
    expect(screen.queryByRole('button', { name: /instead/i })).toBeNull();
  });

  it('still offers the fallback once the real identity is activated', () => {
    renderEmptyState(
      identityWith({
        naturalPersonActive: true,
        naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: 'Real Name' },
      }),
      { allow: ['persona'] },
    );
    expect(screen.getByRole('button', { name: /Sign in with my Real Name instead/i })).toBeTruthy();
  });
});
