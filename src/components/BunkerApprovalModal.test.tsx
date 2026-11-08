// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BunkerApprovalModal } from './BunkerApprovalModal';
import { BunkerPanel } from './BunkerPanel';
import type { PendingApproval, PendingCryptoApproval, PendingSignApproval } from '../hooks/useBunkerServer';

function approval(over: Partial<PendingSignApproval> & { dependantId?: string | null } = {}): PendingApproval {
  const { dependantId = null, ...rest } = over;
  return {
    handle: 7,
    route: { pubkey: 'b'.repeat(64), dependantId },
    method: 'sign_event',
    client: { appName: 'Some App', appUrl: 'https://example.com', existing: true, pubkey: 'c'.repeat(64) },
    description: 'note',
    alwaysAvailable: true,
    template: { pubkey: 'b'.repeat(64), kind: 31337, created_at: 1, content: '', tags: [] },
    ...rest,
  };
}
afterEach(cleanup);

function cryptoApproval(over: Partial<PendingCryptoApproval> = {}): PendingCryptoApproval {
  return {
    handle: 9,
    route: { pubkey: 'b'.repeat(64), dependantId: null },
    method: 'nip44_decrypt',
    peerPubkey: 'b'.repeat(64),
    client: { appName: 'Stash', existing: false, pubkey: 'c'.repeat(64) },
    description: 'Decrypt data you encrypted to yourself',
    alwaysAvailable: true,
    ...over,
  };
}

function renderModal(a: PendingApproval, once = vi.fn(), always = vi.fn()) {
  render(<BunkerApprovalModal approval={a} onApproveOnce={once} onApproveAlways={always} onDeny={() => {}} />);
  return { once, always };
}

it('offers "Allow always" for an owner approval', () => {
  renderModal(approval());
  expect(screen.getByRole('button', { name: /Allow always for Some App/ })).toBeTruthy();
});

it('hides "Allow always" for a dependant approval it could not save (unclassified kind), keeping once and deny', () => {
  const { once, always } = renderModal(approval({ dependantId: 'd'.repeat(64), alwaysAvailable: false }));
  expect(screen.queryByRole('button', { name: /Allow always/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
  expect(once).toHaveBeenCalledWith(7);
  expect(always).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
});

it('still offers "Allow always" for a dependant approval that will be saved', () => {
  renderModal(approval({ dependantId: 'd'.repeat(64), alwaysAvailable: true }));
  expect(screen.getByRole('button', { name: /Allow always for Some App/ })).toBeTruthy();
});

it('hides the first-contact "Allow always" too when it would not be saved', () => {
  renderModal(approval({ dependantId: 'd'.repeat(64), alwaysAvailable: false, client: { appName: 'New App', existing: false, pubkey: 'c'.repeat(64) } }));
  expect(screen.queryByRole('button', { name: /Allow always/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy();
});

it('hides the Bunker panel "Always" button for an approval that would not be saved', () => {
  render(<BunkerPanel onClose={() => {}} bunkerAllowed onGoToSecurity={() => {}} stayAwakeUntil={null}
    onArmStayAwake={() => {}} onCloseStayAwake={() => {}} wakeLockSupported={false}
    pendingApprovals={[approval({ handle: 1 }), approval({ handle: 2, dependantId: 'd'.repeat(64), alwaysAvailable: false })]}
    onApproveOnce={() => {}} onApproveAlways={() => {}} onDeny={() => {}}
    dependantNameFor={() => undefined} hasDependants={false} serveStatus={{ phase: 'idle', routePubkeys: [], relayUrl: 'wss://example.com' } as never}
    locked={false} onRequestUnlockWithPendingArm={() => {}} onRequestUnlockForAlwaysOn={() => {}} isNative={false} backgroundServing={false} alwaysOnWanted={false} onSetBackgroundServing={async () => {}} />);
  expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(2);
  expect(screen.getAllByRole('button', { name: 'Always' })).toHaveLength(1);
});

it('shows the Bunker panel "Always" button for a dependant approval that will be saved', () => {
  render(<BunkerPanel onClose={() => {}} bunkerAllowed onGoToSecurity={() => {}} stayAwakeUntil={null}
    onArmStayAwake={() => {}} onCloseStayAwake={() => {}} wakeLockSupported={false}
    pendingApprovals={[approval({ handle: 3, dependantId: 'd'.repeat(64), alwaysAvailable: true })]}
    onApproveOnce={() => {}} onApproveAlways={() => {}} onDeny={() => {}}
    dependantNameFor={() => 'Sam'} hasDependants serveStatus={{ phase: 'idle', routePubkeys: [], relayUrl: 'wss://example.com' } as never}
    locked={false} onRequestUnlockWithPendingArm={() => {}} onRequestUnlockForAlwaysOn={() => {}} isNative={false} backgroundServing={false} alwaysOnWanted={false} onSetBackgroundServing={async () => {}} />);
  expect(screen.getAllByRole('button', { name: 'Always' })).toHaveLength(1);
});

it('frames an owner decrypt request as a decryption, says the app sees the result, and offers "Allow always" (#189)', () => {
  const { always } = renderModal(cryptoApproval());
  expect(screen.getByText('Decryption request')).toBeTruthy();
  expect(screen.getByRole('heading').textContent).toBe('Stash wants to: Decrypt data you encrypted to yourself.');
  expect(screen.getByText(/The app will see what it decrypts/)).toBeTruthy();
  expect(screen.queryByText(/Event kind/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Allow always for Stash/ }));
  expect(always).toHaveBeenCalledWith(9);
});

it('frames an owner encrypt request as an encryption (#189)', () => {
  renderModal(cryptoApproval({ method: 'nip44_encrypt', description: 'Encrypt data to yourself' }));
  expect(screen.getByText('Encryption request')).toBeTruthy();
  expect(screen.getByText(/encrypt with your key without asking again/)).toBeTruthy();
});
