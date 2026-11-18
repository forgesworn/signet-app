// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { DependantIdentity } from '../types';
import { GuardianSettings } from './GuardianSettings';

const dep = {
  id: 'c'.repeat(64), guardianPubkey: '1'.repeat(64), displayName: 'Sam',
  naturalPerson: { publicKey: 'c'.repeat(64), privateKey: '', displayName: 'Sam' },
  persona: { publicKey: 'd'.repeat(64), privateKey: '', displayName: 'Sam' },
  derivationPath: 'dependant-0', createdAt: 1, autonomyStage: 'request-approve', primaryKeypair: 'persona',
} as DependantIdentity;

afterEach(() => cleanup());

function page(onUpdatePhoto?: () => void) {
  return render(
    <GuardianSettings activeDependant={dep} onSwitchDependantPrimary={() => {}} requestAuth={async () => null} ownerTier="standard"
      onUpdatePhoto={onUpdatePhoto} currentContactPolicy="kin-only" onUpdateContactPolicy={() => {}} currentDefaultChildCeiling="ken"
      onUpdateDefaultChildCeiling={() => {}} viewer="child" />,
  );
}

describe('GuardianSettings child viewer: the verification photo row', () => {
  it('is offered when the caller supplies the handler (the child on their own phone)', () => {
    const onUpdatePhoto = vi.fn();
    page(onUpdatePhoto);
    fireEvent.click(screen.getByRole('button', { name: /Set|Change/ }));
    expect(onUpdatePhoto).toHaveBeenCalledTimes(1);
  });

  it('is gone when there is no handler (child mode on the guardian\'s phone)', () => {
    page(undefined);
    expect(screen.queryByText('Verification photo')).toBeNull();
  });
});
