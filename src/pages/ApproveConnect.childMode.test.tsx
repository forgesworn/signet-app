// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ApproveConnect } from './ApproveConnect';
import type { AuthSelection } from './ApproveAuth';
import type { SignetIdentity, DependantIdentity } from '../types';
import type { NostrConnectRequest } from '../lib/nip46';
import { CHILD_MODE_SIGN_IN_COPY } from '../lib/child-device-copy';

/**
 * A connect (`nostrconnect://` scanned on the carousel or the scan page, a
 * `?nostrconnect=` link) reaching the guardian's phone in child mode offers
 * only the child-mode dependant: never the guardian's identities, nor the
 * "add a persona" hint, nor a hand-off of a guardian key to the Heartwood.
 */

afterEach(cleanup);

const GUARDIAN_NP = 'a'.repeat(64);
const GUARDIAN_PERSONA = 'b'.repeat(64);
const GUARDIAN_EXTRA = 'd'.repeat(64);
const KID = 'ab'.repeat(32);
const KID_PERSONA = 'e'.repeat(64);

const request: NostrConnectRequest = {
  clientPubkey: '1'.repeat(64),
  relayUrl: 'wss://relay.example.com',
  relayUrls: ['wss://relay.example.com'],
  secret: 's3cret',
  appName: 'Test App',
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

const GUARDIAN_TEXT = /RunGuardian|Guardian Real Name|Guardian Extra|Settings|Straight to my Heartwood/;

function page(o: { childModeOnly?: boolean; dependants?: DependantIdentity[]; onApprove?: (s: AuthSelection) => Promise<void> } = {}) {
  return (
    <ApproveConnect
      request={request}
      identity={identity}
      canSwitchGuardianPersona={true}
      availableGuardianPubkeys={[GUARDIAN_NP, GUARDIAN_PERSONA, GUARDIAN_EXTRA]}
      dependants={o.dependants}
      defaultSelection={{ source: 'guardian', keypairType: 'persona' }}
      userChoice={{ selection: { source: 'guardian', keypairType: GUARDIAN_EXTRA } }}
      requireNpConfirmation={true}
      canHandOffToHeartwood={() => true}
      onApprove={o.onApprove ?? vi.fn(() => Promise.resolve())}
      onDeny={vi.fn()}
      childModeOnly={o.childModeOnly}
    />
  );
}

describe('ApproveConnect in child mode', () => {
  it('outside child mode the guardian\'s identities are offered (control)', () => {
    render(page({ dependants: [kid] }));
    expect(screen.getAllByText('RunGuardian').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Guardian Extra').length).toBeGreaterThan(0);
  });

  it('offers only the child, chosen by default even over an earlier guardian pick, and approves as the child', async () => {
    const onApprove = vi.fn((_s: AuthSelection) => Promise.resolve());
    render(page({ childModeOnly: true, dependants: [kid], onApprove }));
    expect(screen.queryByText(GUARDIAN_TEXT)).toBeNull();
    expect(screen.getAllByText('Kid Persona').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalled());
    expect(onApprove.mock.calls[0][0]).toEqual({ source: 'dependant', dependantId: KID, keypairType: 'persona' });
  });

  it('with no child identity on this phone, says so and offers nothing of the guardian\'s', () => {
    render(page({ childModeOnly: true }));
    expect(screen.queryByText(GUARDIAN_TEXT)).toBeNull();
    expect(screen.getByText(CHILD_MODE_SIGN_IN_COPY.connectNoChildIdentity)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
