// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { DependantIdentity } from '../types';
import type { HeartwoodMgmtClient } from '../lib/heartwood-mgmt';

vi.mock('../lib/heartwood-mgmt', async (orig) => ({
  ...(await orig<typeof import('../lib/heartwood-mgmt')>()),
  listClients: vi.fn().mockResolvedValue([]),
}));

import { GuardianSettings } from './GuardianSettings';

const dep = (over: Partial<DependantIdentity> = {}): DependantIdentity => ({
  id: 'c'.repeat(64), guardianPubkey: '1'.repeat(64), displayName: 'Sam',
  naturalPerson: { publicKey: 'c'.repeat(64), privateKey: '', displayName: 'Sam' },
  persona: { publicKey: 'd'.repeat(64), privateKey: '', displayName: 'Sam' },
  derivationPath: 'dependant-0', createdAt: 1, autonomyStage: 'request-approve', primaryKeypair: 'persona',
  ...over,
} as DependantIdentity);

const readiness = (signingMode = 'bunker') => ({
  signingMode, signerStatus: 'connected' as const, operator: {} as HeartwoodMgmtClient,
  operatorStatus: { capabilities: ['pairing_identity_v1'], masterNpubHex: 'a'.repeat(64), truncated: false },
});

function renderIt(opts: { dependant?: DependantIdentity; pairReadiness?: ReturnType<typeof readiness>; viewer?: 'guardian' | 'child' } = {}) {
  render(
    <GuardianSettings
      activeDependant={opts.dependant ?? dep()}
      onSwitchDependantPrimary={() => {}}
      requestAuth={async () => null}
      ownerTier="standard"
      onUpdatePhoto={() => {}}
      currentContactPolicy="kin-only"
      onUpdateContactPolicy={() => {}}
      currentDefaultChildCeiling="ken"
      onUpdateDefaultChildCeiling={() => {}}
      viewer={opts.viewer ?? 'guardian'}
      onPairDevice={() => {}}
      pairReadiness={opts.pairReadiness}
    />,
  );
}

beforeEach(() => cleanup());

describe('GuardianSettings — Before you pair checklist', () => {
  it('shows above Pair a device on the child-direct path when unpaired', () => {
    renderIt({ pairReadiness: readiness() });
    const list = screen.getByTestId('pair-readiness');
    const button = screen.getByRole('button', { name: 'Pair a device' });
    expect(button).toBeEnabled();
    expect(list.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps Pair a device enabled even with a failing row', () => {
    renderIt({ pairReadiness: { ...readiness(), operator: null as unknown as HeartwoodMgmtClient } });
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pair a device' })).toBeEnabled();
  });

  it('is hidden once a phone is paired', () => {
    renderIt({ dependant: dep({ bunkerEndpoint: { publicKey: 'e'.repeat(64), privateKey: '', createdAt: 1, authorizedClientPubkey: 'f'.repeat(64) } as DependantIdentity['bunkerEndpoint'] }), pairReadiness: readiness() });
    expect(screen.queryByTestId('pair-readiness')).toBeNull();
  });

  it('is hidden off bunker mode, for an imported dependant, and for the child viewer', () => {
    renderIt({ pairReadiness: readiness('local') });
    expect(screen.queryByTestId('pair-readiness')).toBeNull();
    cleanup();
    renderIt({ dependant: dep({ derivationPath: undefined }), pairReadiness: readiness() });
    expect(screen.queryByTestId('pair-readiness')).toBeNull();
    cleanup();
    renderIt({ viewer: 'child', pairReadiness: readiness() });
    expect(screen.queryByTestId('pair-readiness')).toBeNull();
    cleanup();
    renderIt();
    expect(screen.queryByTestId('pair-readiness')).toBeNull();
  });
});
