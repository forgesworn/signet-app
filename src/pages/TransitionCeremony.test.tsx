// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TransitionCeremony } from './TransitionCeremony';
import type { ContactRecord, DependantIdentity } from '../types';
import type { IndependenceOptions } from '../lib/independence-transfer';

function dep(): DependantIdentity {
  return {
    id: 'c'.repeat(64), guardianPubkey: '1'.repeat(64), displayName: 'Sam',
    naturalPerson: { publicKey: 'c'.repeat(64), privateKey: 'e'.repeat(64), displayName: 'Sam' },
    persona: { publicKey: 'd'.repeat(64), privateKey: '', displayName: 'Sam' },
    // No derivationPath: `hasDerivedKeys` is false, so the ceremony skips
    // step 3 (key rotation) and goes straight from the guardian-authority
    // decision to the confirm step — keeps the test focused on the
    // confirm-time gate re-check.
    derivationPath: '', createdAt: 1, autonomyStage: 'full-control',
    primaryKeypair: 'persona',
  } as DependantIdentity;
}

async function driveToConfirmStep() {
  fireEvent.click(screen.getByRole('button', { name: 'Begin ceremony' }));
  fireEvent.click(await screen.findByRole('button', { name: /Keep guardian authority/ }));
  await screen.findByRole('button', { name: 'Confirm ceremony' });
}

describe('TransitionCeremony confirm-time gate re-check', () => {
  it('refuses to complete when the fresh onResolveGate call comes back blocked, even though the render-time gate allowed it', async () => {
    const onComplete = vi.fn(async () => {});
    const onResolveGate = vi.fn(async () => ({
      allowed: false,
      reason: "Contact transfer isn't available yet. Independence will be enabled once contacts can move with Sam.",
    }));

    render(
      <TransitionCeremony
        dependant={dep()}
        onComplete={onComplete}
        onBack={() => {}}
        // Render-time gate says allowed — proves the block comes from the
        // fresh re-check, not from `contactsGate` itself.
        contactsGate={{ allowed: true, reason: null }}
        contactsLoading={false}
        onResolveGate={onResolveGate}
      />,
    );

    await driveToConfirmStep();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm ceremony' }));

    await waitFor(() => expect(onResolveGate).toHaveBeenCalledTimes(1));
    expect(onComplete).not.toHaveBeenCalled();
    expect(await screen.findByText(
      "Contact transfer isn't available yet. Independence will be enabled once contacts can move with Sam.",
    )).toBeDefined();
  });

  it('completes when the fresh onResolveGate call comes back allowed', async () => {
    const onComplete = vi.fn(async () => {});
    const onResolveGate = vi.fn(async () => ({ allowed: true, reason: null }));

    render(
      <TransitionCeremony
        dependant={dep()}
        onComplete={onComplete}
        onBack={() => {}}
        contactsGate={{ allowed: true, reason: null }}
        contactsLoading={false}
        onResolveGate={onResolveGate}
      />,
    );

    await driveToConfirmStep();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm ceremony' }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });
});

describe('TransitionCeremony independent transfer', () => {
  async function reviewHandover(onTransfer: (opts: IndependenceOptions & { reviewRevision: string }) => Promise<void>) {
    const onComplete = vi.fn();
    render(<TransitionCeremony dependant={{ ...dep(), derivationPath: 'dependant-0' }}
      onComplete={onComplete} onBack={() => {}} contactsGate={{ allowed: false, reason: 'Contacts need transfer' }}
      contactsLoading={false} onResolveGate={async () => ({ allowed: false, reason: 'Contacts need transfer' })}
      onCreateIndependentWords={async () => 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'}
      onLoadTransferContacts={async () => ({ revision: 'reviewed', contacts: [{ contactId: 'a'.repeat(32), displayName: 'Alex', lifecycle: 'active', blocks: [] } as unknown as ContactRecord] })}
      onTransfer={onTransfer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Begin ceremony' }));
    fireEvent.click(screen.getByRole('button', { name: /Remove guardian authority/ }));
    fireEvent.click(screen.getByRole('button', { name: /Generate independent keys/ }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /I have written down/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const tier = await screen.findByRole('combobox', { name: 'Trust for Alex' });
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    fireEvent.change(tier, { target: { value: 'ken' } });
    fireEvent.click(screen.getByRole('radio', { name: /Keep a read-only encrypted archive/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm ceremony' }));
    return onComplete;
  }

  it('routes reviewed contacts through verified transfer before claiming completion', async () => {
    let resolve!: () => void;
    const onTransfer = vi.fn(() => new Promise<void>(r => { resolve = r; }));
    const onComplete = await reviewHandover(onTransfer);
    expect(onTransfer).toHaveBeenCalledWith(expect.objectContaining({ guardianCopy: 'archive', reviewRevision: 'reviewed',
      review: { ['a'.repeat(32)]: { tier: 'ken', keepBlocked: true } } }));
    expect(screen.queryByText('Ceremony complete')).toBeNull();
    resolve();
    expect(await screen.findByText('Ceremony complete')).toBeDefined();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('keeps confirmation open when recovery verification fails', async () => {
    const onComplete = await reviewHandover(vi.fn(async () => { throw new Error('Recovery verification failed'); }));
    expect(await screen.findByText('Recovery verification failed')).toBeDefined();
    expect(screen.queryByText('Ceremony complete')).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
