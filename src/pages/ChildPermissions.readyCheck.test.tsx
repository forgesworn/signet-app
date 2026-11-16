// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

vi.mock('../lib/heartwood-mgmt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/heartwood-mgmt')>();
  return { ...actual, listClients: vi.fn() };
});
vi.mock('../hooks/useChildActivity', () => ({ useChildActivity: () => ({ apps: [], entries: [] }) }));
vi.mock('../hooks/useChildDevicePairing', () => ({ useChildDevicePairing: () => ({ unpair: vi.fn() }) }));

import { listClients, type HeartwoodMgmtClient } from '../lib/heartwood-mgmt';
import { buildPersonaFirstDependant } from '../lib/dependant-record';
import type { DeviceClientSlot } from '../lib/heartwood-mgmt-types';
import type { DependantIdentity } from '../types';
import { CHILD_READY_COPY } from '../lib/child-ready-copy';
import { resetChildReadyCheckMemory } from '../hooks/useChildReadyCheck';
import { ChildPermissionsGuardianRoute, type ChildPermissionsGuardianRouteProps } from './ChildPermissions';

const mList = vi.mocked(listClients);
const NP = 'a'.repeat(64), PERSONA = 'b'.repeat(64), CHILD = 'd'.repeat(64), GUARDIAN = 'e'.repeat(64), GNP = '1'.repeat(64);

const dep: DependantIdentity = {
  ...buildPersonaFirstDependant({ guardianPubkey: GNP, enteredName: 'Lily', derivationPath: 'dependant-2',
    naturalPerson: { publicKey: NP, privateKey: '' }, persona: { publicKey: PERSONA, privateKey: '' }, createdAt: 1 }),
  childDevice: { mode: 'heartwood-direct', slotLabel: 'signet:child-device:v2:x', secretFingerprint: 'ab', slotIndex: 6,
    clientPubkey: CHILD, boundPersona: PERSONA, pairedAt: 1 },
};
function device(childIds: string[], guardianIds: string[]): DeviceClientSlot[] {
  const base = { label: '', autoApprove: true, signingApproved: true, strictPermissions: true, allowedKinds: [], allowedMethods: [],
    escalate: false, petitionOnDeny: false, auditChildWrap: false };
  return [
    { ...base, slotIndex: 6, secretFingerprint: 'ab', currentPubkey: CHILD, authorizedPubkeys: [CHILD], boundIdentity: PERSONA,
      clientApprovals: [{ clientPubkey: CHILD, approvedIdentities: childIds, legacyIdentityTags: [] }] },
    { ...base, slotIndex: 1, secretFingerprint: 'g', currentPubkey: GUARDIAN, authorizedPubkeys: [GUARDIAN], boundIdentity: null,
      clientApprovals: [{ clientPubkey: GUARDIAN, approvedIdentities: guardianIds, legacyIdentityTags: [] }] },
  ];
}

function renderRoute(nip44Encrypt = vi.fn(async () => 'x')) {
  const props: ChildPermissionsGuardianRouteProps = {
    dependant: dep, childRules: [], approvedOnce: [], relays: ['wss://r.example'], encryptionKey: 'k'.repeat(64),
    pairing: {
      operator: { isOpen: true } as unknown as HeartwoodMgmtClient, operatorStatus: null, guardianNpPubkey: GNP,
      railRelay: 'wss://r.example', hwRelays: [], encryptionKey: 'k'.repeat(64), grants: [], onDependantUpdated: async () => {},
    },
    history: [], onRevokeRule: async () => {}, onBlockApp: async () => {}, onRemovePersona: async () => {}, onOpenStage: () => {}, onUnpaired: () => {},
    readyCheck: { guardianClientPubkey: GUARDIAN, npBackend: { nip44Encrypt } },
  };
  return render(<ChildPermissionsGuardianRoute {...props} />);
}

beforeEach(() => { mList.mockReset(); resetChildReadyCheckMemory(); });

describe('ChildPermissionsGuardianRoute — not ready away from home', () => {
  it('a press owed on either side shows the notice and the checklist on Finish now; no probe until then', async () => {
    mList.mockResolvedValue(device([], [GNP]));
    const nip44Encrypt = vi.fn(async () => 'x');
    renderRoute(nip44Encrypt);
    expect(await screen.findByText(CHILD_READY_COPY.notReadyHeading)).toBeTruthy();
    expect(screen.getByText(CHILD_READY_COPY.pressesOwed(1))).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByText(CHILD_READY_COPY.finishNow)); });
    expect(screen.getByTestId(`ready-row-${PERSONA}`)).toBeTruthy();
    expect(screen.getByText(CHILD_READY_COPY.childPressHint('Lily'))).toBeTruthy();
    // The guardian's own row is ready on the device: nothing to probe.
    expect(nip44Encrypt).not.toHaveBeenCalled();
  });

  it('everything listed on the device: no notice at all', async () => {
    mList.mockResolvedValue(device([PERSONA], [GNP]));
    renderRoute();
    await waitFor(() => expect(mList).toHaveBeenCalled());
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(screen.queryByText(CHILD_READY_COPY.notReadyHeading)).toBeNull();
  });
});
