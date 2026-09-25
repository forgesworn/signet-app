// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ApproveAuth, WAITING_FOR_SIGNER_COPY, CHOSEN_UNAVAILABLE_COPY, type AuthSelection } from './ApproveAuth';
import { ROUTED_APPROVAL_WAIT_MS } from '../lib/await-routed-backend';
import type { SignetIdentity, ConsumerHint } from '../types';
import type { AuthRequest } from '../lib/qr-router';

/**
 * The user's explicit pick must survive a lock/unlock remount and transient
 * list changes; the resolver's default applies only before they touch the
 * picker; the accept= allowlist still filters.
 */

afterEach(() => { cleanup(); vi.useRealTimers(); });

const PERSONA = 'b'.repeat(64);
const TREE = 'd'.repeat(64);
const IMPORTED = 'e'.repeat(64);

const request: AuthRequest = {
  type: 'signet-auth-request',
  requestId: 'f'.repeat(32),
  challenge: 'c'.repeat(64),
  origin: 'https://example.com',
  timestamp: Date.now(),
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
  consumerHint?: ConsumerHint | null;
  onApprove?: (s: AuthSelection) => Promise<void>;
} = {}) {
  return (
    <ApproveAuth
      request={request}
      hasCredentialForSelection={() => false}
      identity={identity}
      canSwitchGuardianPersona={true}
      availableGuardianPubkeys={o.available ?? [PERSONA, TREE, IMPORTED]}
      waitingGuardianPubkeys={o.waiting}
      consumerHint={o.consumerHint ?? null}
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
  .find((b): b is HTMLButtonElement => !!b && b.textContent !== 'Approve')!;
const isSelected = (name: string) => rowFor(name).className.includes('btn-tile-selected');
const approveButton = () => screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;

describe('ApproveAuth — the user\'s choice is final', () => {
  it('survives a lock/unlock remount (App holds the choice per request)', () => {
    let held: { selection: AuthSelection | null } | undefined;
    const { unmount } = render(page({ onUserChoice: (s) => { held = { selection: s }; } }));
    fireEvent.click(rowFor('Tree Extra'));
    expect(held?.selection).toEqual({ source: 'guardian', keypairType: TREE });
    unmount();                      // the lock clears identity state → page unmounts
    render(page({ userChoice: held }));
    expect(isSelected('Tree Extra')).toBe(true);
    expect(isSelected('C1 Burner')).toBe(false);
  });

  it('a list temporarily missing the chosen slot keeps it chosen, shows it waiting and disables Approve', () => {
    const onApprove = vi.fn(() => Promise.resolve());
    render(page({
      available: [IMPORTED],        // locked: only the locally keyed slot survived the old filter
      userChoice: { selection: { source: 'guardian', keypairType: TREE } },
      onApprove,
    }));
    expect(isSelected('Imported Extra')).toBe(false);
    expect(rowFor('Tree Extra')).toBeTruthy();
    expect(screen.getByText(WAITING_FOR_SIGNER_COPY)).toBeTruthy();
    expect(approveButton().disabled).toBe(true);
    fireEvent.click(approveButton());
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('a chosen slot whose route is not back is marked waiting and Approve stays disabled', () => {
    const { rerender } = render(page({
      waiting: [TREE],
      userChoice: { selection: { source: 'guardian', keypairType: TREE } },
    }));
    expect(isSelected('Tree Extra')).toBe(true);
    expect(approveButton().disabled).toBe(true);
    rerender(page({ waiting: [], userChoice: { selection: { source: 'guardian', keypairType: TREE } } }));
    expect(isSelected('Tree Extra')).toBe(true);
    expect(approveButton().disabled).toBe(false);
  });

  it('the resolver default applies before the user touches the picker, and follows the list as it settles', () => {
    const { rerender } = render(page({ available: [IMPORTED] }));
    expect(isSelected('Imported Extra')).toBe(true);
    rerender(page({ available: [PERSONA, TREE, IMPORTED] }));
    expect(isSelected('C1 Burner')).toBe(true);   // persona-first default once it is listed
  });

  it('keeps the accept= allowlist: only allowed kinds are offered', () => {
    render(page({ consumerHint: { allow: ['extra-persona'] } }));
    expect(screen.queryByText('C1 Burner')).toBeNull();
    expect(rowFor('Tree Extra')).toBeTruthy();
    expect(rowFor('Imported Extra')).toBeTruthy();
  });

  it('a chosen slot gone for good stops saying "waiting" after the bounded window', async () => {
    vi.useFakeTimers();
    render(page({ available: [PERSONA, IMPORTED], userChoice: { selection: { source: 'guardian', keypairType: TREE } } }));
    expect(screen.getByText(WAITING_FOR_SIGNER_COPY)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(ROUTED_APPROVAL_WAIT_MS); });
    expect(screen.queryByText(WAITING_FOR_SIGNER_COPY)).toBeNull();
    expect(screen.getByText(CHOSEN_UNAVAILABLE_COPY)).toBeTruthy();
    expect(approveButton().disabled).toBe(true);
    fireEvent.click(rowFor('C1 Burner'));
    expect(approveButton().disabled).toBe(false);
  });
});
