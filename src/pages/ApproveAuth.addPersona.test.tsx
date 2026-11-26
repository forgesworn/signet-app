// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ApproveAuth } from './ApproveAuth';
import type { SignetIdentity } from '../types';
import type { AuthRequest } from '../lib/qr-router';

const request: AuthRequest = {
  type: 'signet-auth-request', relays: [], requestId: 'f'.repeat(32), challenge: 'c'.repeat(64),
  origin: 'https://example.com', timestamp: Date.now(),
};
// No persona yet: the empty state is where "Add persona now" is offered.
const identity = {
  id: 'a'.repeat(64), mnemonic: '', primaryKeypair: 'persona', isChild: false, createdAt: 0,
  naturalPerson: { publicKey: 'a'.repeat(64), privateKey: '', displayName: '' },
  persona: { publicKey: '', privateKey: '', displayName: '' },
} as SignetIdentity;

afterEach(() => cleanup());

function renderPicker(onAddPersona: (() => Promise<void>) | undefined) {
  render(
    <ApproveAuth request={request} hasCredentialForSelection={() => false} identity={identity} canSwitchGuardianPersona
      consumerHint={{ allow: ['persona'] }} requireNpConfirmation onApprove={vi.fn()} onDeny={vi.fn()}
      onAddPersona={onAddPersona} />,
  );
}

describe('ApproveAuth (sign-in picker) — Add persona now', () => {
  it('is offered when the phone can add a persona', () => {
    renderPicker(async () => {});
    expect(screen.getByRole('button', { name: 'Add persona now' })).toBeTruthy();
  });

  it('is not offered when onAddPersona is withheld (a child\'s phone)', () => {
    renderPicker(undefined);
    expect(screen.queryByRole('button', { name: 'Add persona now' })).toBeNull();
  });
});
