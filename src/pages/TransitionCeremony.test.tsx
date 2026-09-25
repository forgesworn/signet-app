// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TransitionCeremony } from './TransitionCeremony';
import type { DependantIdentity } from '../types';

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
