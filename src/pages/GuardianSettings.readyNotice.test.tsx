// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { DependantIdentity } from '../types';
import { GuardianSettings } from './GuardianSettings';

const base = {
  id: 'c'.repeat(64), guardianPubkey: '1'.repeat(64), displayName: 'Sam',
  naturalPerson: { publicKey: 'c'.repeat(64), privateKey: '', displayName: 'Sam' },
  persona: { publicKey: 'd'.repeat(64), privateKey: '', displayName: 'Sam' },
  derivationPath: 'dependant-0', createdAt: 1, autonomyStage: 'request-approve', primaryKeypair: 'persona',
} as DependantIdentity;
const direct = { ...base, childDevice: { mode: 'heartwood-direct', slotLabel: 'l', secretFingerprint: 'ab', slotIndex: 1, clientPubkey: 'e'.repeat(64), boundPersona: 'd'.repeat(64), pairedAt: 1 } } as DependantIdentity;

afterEach(() => cleanup());

function page(dep: DependantIdentity, viewer: 'guardian' | 'child' = 'guardian') {
  return render(
    <GuardianSettings activeDependant={dep} onSwitchDependantPrimary={() => {}} requestAuth={async () => null} ownerTier="standard"
      onUpdatePhoto={() => {}} currentContactPolicy="kin-only" onUpdateContactPolicy={() => {}} currentDefaultChildCeiling="ken"
      onUpdateDefaultChildCeiling={() => {}} viewer={viewer} readyNotice={<div data-testid="ready-notice">Not ready away from home</div>} />,
  );
}

describe('GuardianSettings — the ready check notice', () => {
  it('shows for a child paired straight to the Heartwood, on the guardian\'s phone', () => {
    page(direct);
    expect(screen.getByTestId('ready-notice')).toBeTruthy();
  });

  it('not for a dependant without a direct pairing, nor for the child viewer', () => {
    page(base);
    expect(screen.queryByTestId('ready-notice')).toBeNull();
    cleanup();
    page(direct, 'child');
    expect(screen.queryByTestId('ready-notice')).toBeNull();
  });
});
