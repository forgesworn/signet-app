// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ApproveConnect } from './ApproveConnect';
import { WAITING_FOR_SIGNER_COPY, CHOSEN_UNAVAILABLE_COPY } from '../hooks/useApprovalPickerChoice';
import { ROUTED_APPROVAL_WAIT_MS } from '../lib/await-routed-backend';
import type { AuthSelection } from './ApproveAuth';
import type { SignetIdentity } from '../types';
import type { NostrConnectRequest } from '../lib/nip46';

/**
 * The NIP-46 connect picker follows the same rule as the sign-in picker: the
 * user's pick survives a lock remount and list changes, and a chosen slot
 * that is waiting or absent blocks Approve instead of being swapped.
 */

afterEach(() => { cleanup(); vi.useRealTimers(); });

const PERSONA = 'b'.repeat(64);
const TREE = 'd'.repeat(64);
const IMPORTED = 'e'.repeat(64);

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
  extraPersonas: [
    { publicKey: TREE, privateKey: '', displayName: 'Tree Extra', derivationName: 'persona-1' },
    { publicKey: IMPORTED, privateKey: '', displayName: 'Imported Extra', imported: true },
  ],
  primaryKeypair: 'persona',
  isChild: false,
  createdAt: 0,
  naturalPersonActive: false,
} as unknown as SignetIdentity;

function page(o: {
  available?: string[];
  waiting?: string[];
  userChoice?: { selection: AuthSelection | null };
  onUserChoice?: (s: AuthSelection | null) => void;
  onApprove?: (s: AuthSelection) => Promise<void>;
} = {}) {
  return (
    <ApproveConnect
      request={request}
      identity={identity}
      canSwitchGuardianPersona={true}
      availableGuardianPubkeys={o.available ?? [PERSONA, TREE, IMPORTED]}
      waitingGuardianPubkeys={o.waiting}
      requireNpConfirmation={true}
      userChoice={o.userChoice}
      onUserChoice={o.onUserChoice}
      onApprove={o.onApprove ?? vi.fn(() => Promise.resolve())}
      onDeny={vi.fn()}
    />
  );
}

const rowFor = (name: string) => screen.getAllByText(name)
  .map(el => el.closest('button'))
  .find((b): b is HTMLButtonElement => !!b)!;
const isSelected = (name: string) => rowFor(name).className.includes('btn-tile-selected');
const approveButton = () => screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;

describe('ApproveConnect — the user\'s choice is final', () => {
  it('survives a lock/unlock remount (App holds the choice per request)', () => {
    let held: { selection: AuthSelection | null } | undefined;
    const { unmount } = render(page({ onUserChoice: (s) => { held = { selection: s }; } }));
    fireEvent.click(rowFor('Tree Extra'));
    unmount();
    render(page({ userChoice: held, available: [IMPORTED] }));   // remounted on the shrunken list
    expect(isSelected('Imported Extra')).toBe(false);
    expect(rowFor('Tree Extra')).toBeTruthy();
    expect(screen.getByText(WAITING_FOR_SIGNER_COPY)).toBeTruthy();
    expect(approveButton().disabled).toBe(true);
  });

  it('a waiting chosen slot disables Approve until its route is back', () => {
    const onApprove = vi.fn(() => Promise.resolve());
    const choice = { selection: { source: 'guardian', keypairType: TREE } as AuthSelection };
    const { rerender } = render(page({ waiting: [TREE], userChoice: choice, onApprove }));
    expect(isSelected('Tree Extra')).toBe(true);
    expect(approveButton().disabled).toBe(true);
    rerender(page({ waiting: [], userChoice: choice, onApprove }));
    expect(approveButton().disabled).toBe(false);
    fireEvent.click(approveButton());
    expect(onApprove).toHaveBeenCalledWith({ source: 'guardian', keypairType: TREE });
  });

  it('the default applies before the user touches the picker', () => {
    render(page());
    expect(isSelected('C1 Burner')).toBe(true);
  });

  it('a chosen slot absent past the bounded wait reads as unavailable, Approve still disabled', async () => {
    vi.useFakeTimers();
    render(page({ available: [PERSONA, IMPORTED], userChoice: { selection: { source: 'guardian', keypairType: TREE } } }));
    expect(screen.getByText(WAITING_FOR_SIGNER_COPY)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(ROUTED_APPROVAL_WAIT_MS); });
    expect(screen.queryByText(WAITING_FOR_SIGNER_COPY)).toBeNull();
    expect(screen.getByText(CHOSEN_UNAVAILABLE_COPY)).toBeTruthy();
    expect(approveButton().disabled).toBe(true);
    // Picking another identity is the way on.
    fireEvent.click(rowFor('C1 Burner'));
    expect(approveButton().disabled).toBe(false);
  });

  it('a slot that goes missing a second time starts a fresh waiting window', async () => {
    vi.useFakeTimers();
    const choice = { selection: { source: 'guardian', keypairType: TREE } as AuthSelection };
    const missing = [PERSONA, IMPORTED];
    const { rerender } = render(page({ available: missing, userChoice: choice }));
    await act(async () => { await vi.advanceTimersByTimeAsync(ROUTED_APPROVAL_WAIT_MS); });
    expect(screen.getByText(CHOSEN_UNAVAILABLE_COPY)).toBeTruthy();
    rerender(page({ available: [PERSONA, TREE, IMPORTED], userChoice: choice }));   // back
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText(CHOSEN_UNAVAILABLE_COPY)).toBeNull();
    rerender(page({ available: missing, userChoice: choice }));                    // gone again
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(WAITING_FOR_SIGNER_COPY)).toBeTruthy();
    expect(screen.queryByText(CHOSEN_UNAVAILABLE_COPY)).toBeNull();
  });
});
