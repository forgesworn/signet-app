// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ApproveAuth, type AuthSelection } from './ApproveAuth';
import type { SignetIdentity, ConsumerHint, DependantIdentity } from '../types';
import type { AuthRequest } from '../lib/qr-router';

/**
 * In child mode (the guardian has handed the phone to a child) the picker must
 * never offer the guardian's own identities, on the picker or on any fallback
 * of the empty state, while the child can still sign in as themselves.
 */

afterEach(cleanup);

const GUARDIAN_NP = 'a'.repeat(64);
const GUARDIAN_PERSONA = 'b'.repeat(64);
const GUARDIAN_EXTRA = 'd'.repeat(64);
const KID = 'ab'.repeat(32);
const KID_PERSONA = 'e'.repeat(64);

const request: AuthRequest = {
  type: 'signet-auth-request',
  relays: [],
  requestId: 'f'.repeat(32),
  challenge: 'c'.repeat(64),
  origin: 'https://example.com',
  timestamp: Date.now(),
};

const identity = {
  id: GUARDIAN_NP,
  mnemonic: '',
  naturalPerson: { publicKey: GUARDIAN_NP, privateKey: '', displayName: 'Guardian Real Name' },
  persona: { publicKey: GUARDIAN_PERSONA, privateKey: '', displayName: 'RunGuardian' },
  extraPersonas: [{ publicKey: GUARDIAN_EXTRA, privateKey: '', displayName: 'Guardian Extra', derivationName: 'persona-1' }],
  primaryKeypair: 'persona',
  isChild: false,
  createdAt: 0,
  naturalPersonActive: true,
} as unknown as SignetIdentity;

const kid = {
  id: KID,
  displayName: 'RunKid',
  dateOfBirth: '',
  naturalPerson: { publicKey: KID, privateKey: '', displayName: '' },
  persona: { publicKey: KID_PERSONA, privateKey: '', displayName: 'Kid Persona' },
  primaryKeypair: 'persona',
  naturalPersonActive: false,
} as unknown as DependantIdentity;

const GUARDIAN_TEXT = /RunGuardian|Guardian Real Name|Guardian Extra|instead|Add persona now|Activate my real identity/;

function page(o: { childModeOnly?: boolean; dependants?: DependantIdentity[]; hint?: ConsumerHint | null; onApprove?: (s: AuthSelection) => Promise<void> } = {}) {
  return (
    <ApproveAuth
      request={request}
      hasCredentialForSelection={() => false}
      identity={identity}
      canSwitchGuardianPersona={true}
      availableGuardianPubkeys={[GUARDIAN_NP, GUARDIAN_PERSONA, GUARDIAN_EXTRA]}
      dependants={o.dependants}
      defaultSelection={{ source: 'guardian', keypairType: 'persona' }}
      userChoice={{ selection: { source: 'guardian', keypairType: GUARDIAN_EXTRA } }}
      consumerHint={o.hint ?? null}
      requireNpConfirmation={true}
      onAddPersona={vi.fn(() => Promise.resolve())}
      onActivateRealIdentity={vi.fn()}
      onApprove={o.onApprove ?? vi.fn(() => Promise.resolve())}
      onDeny={vi.fn()}
      childModeOnly={o.childModeOnly}
    />
  );
}

describe('ApproveAuth in child mode', () => {
  it('outside child mode the guardian\'s identities are offered (control)', () => {
    render(page({ dependants: [kid] }));
    expect(screen.getAllByText('RunGuardian').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Guardian Extra').length).toBeGreaterThan(0);
  });

  it('offers only the child, chosen by default, and approves as the child', async () => {
    const onApprove = vi.fn((_s: AuthSelection) => Promise.resolve());
    render(page({ childModeOnly: true, dependants: [kid], onApprove }));
    expect(screen.queryByText(GUARDIAN_TEXT)).toBeNull();
    expect(screen.getAllByText('Kid Persona').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalled());
    expect(onApprove.mock.calls[0][0]).toEqual({ source: 'dependant', dependantId: KID, keypairType: 'persona' });
  });

  it.each<[string, ConsumerHint | null]>([
    ['no hint', null],
    ['a persona-only hint', { allow: ['persona'] }],
    ['a real-identity-only hint', { allow: ['natural-person'] }],
  ])('with no child to offer (%s), the empty state offers nothing of the guardian\'s', (_label, hint) => {
    render(page({ childModeOnly: true, hint }));
    expect(screen.queryByText(GUARDIAN_TEXT)).toBeNull();
    expect((screen.queryByRole('button', { name: 'Approve' }) as HTMLButtonElement | null)?.disabled ?? true).toBe(true);
  });
});
