// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { GuardianSettings } from './GuardianSettings';
import type { DependantIdentity } from '../types';

function dep(direct: boolean): DependantIdentity {
  return {
    id: 'c'.repeat(64), guardianPubkey: '1'.repeat(64), displayName: 'Sam',
    naturalPerson: { publicKey: 'c'.repeat(64), privateKey: '', displayName: 'Sam' },
    persona: { publicKey: 'd'.repeat(64), privateKey: '', displayName: 'Sam' },
    derivationPath: 'dependant-0', createdAt: 1, autonomyStage: 'request-approve',
    primaryKeypair: 'persona',
    ...(direct ? { childDevice: { mode: 'heartwood-direct', slotLabel: 'l', secretFingerprint: 'ab', slotIndex: 1, clientPubkey: 'e'.repeat(64), boundPersona: 'd'.repeat(64), pairedAt: 1 } } : {}),
  } as DependantIdentity;
}

function renderIt(direct: boolean, viewer: 'guardian' | 'child' = 'guardian') {
  const onOpenPermissions = vi.fn();
  render(
    <GuardianSettings
      activeDependant={dep(direct)}
      onSwitchDependantPrimary={() => {}}
      requestAuth={async () => null}
      ownerTier="standard"
      onUpdatePhoto={() => {}}
      currentContactPolicy="kin-only"
      onUpdateContactPolicy={() => {}}
      currentDefaultChildCeiling="ken"
      onUpdateDefaultChildCeiling={() => {}}
      viewer={viewer}
      onOpenPermissions={onOpenPermissions}
    />,
  );
  return onOpenPermissions;
}

describe('GuardianSettings — child phone permissions', () => {
  it('shows the paired status, Permissions and the apps on the phone for a direct-paired child', () => {
    const open = renderIt(true);
    expect(screen.getByText("Sam's phone is paired to your Heartwood.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }));
    fireEvent.click(screen.getByRole('button', { name: "Apps on Sam's phone" }));
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('is absent for a phone-paired (or unpaired) child and for the child viewer', () => {
    renderIt(false);
    expect(screen.queryByRole('button', { name: 'Permissions' })).toBeNull();
  });

  it('is absent for the child viewer', () => {
    renderIt(true, 'child');
    expect(screen.queryByRole('button', { name: 'Permissions' })).toBeNull();
  });
});
