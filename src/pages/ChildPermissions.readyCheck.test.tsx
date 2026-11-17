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
import { useGuardianReadyChecks, type ChildReadyStore } from '../hooks/useChildReadyCheck';
import type { ChildReadyRecords } from '../lib/db';
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

const op = { isOpen: true } as unknown as HeartwoodMgmtClient;
function memStore(): ChildReadyStore {
  let data: ChildReadyRecords = {};
  return { load: async () => ({ ...data }), update: async (fn) => { const n = fn({ ...data }); if (n) data = n; } };
}

function renderRoute(nip44Encrypt = vi.fn(async () => 'x')) {
  const store = memStore();
  const props: Omit<ChildPermissionsGuardianRouteProps, 'readiness' | 'onWatchReadiness'> = {
    dependant: dep, childRules: [], approvedOnce: [], relays: ['wss://r.example'], encryptionKey: 'k'.repeat(64),
    pairing: {
      operator: op, operatorStatus: null, guardianNpPubkey: GNP,
      railRelay: 'wss://r.example', hwRelays: [], encryptionKey: 'k'.repeat(64), grants: [], onDependantUpdated: async () => {},
    },
    history: [], onRevokeRule: async () => {}, onBlockApp: async () => {}, onRemovePersona: async () => {}, onOpenStage: () => {}, onUnpaired: () => {},
  };
  // The App-level check, as App mounts it; the page only shows its result.
  function Harness() {
    const checks = useGuardianReadyChecks({
      enabled: true, dependants: [dep], operator: op, guardianClientPubkey: GUARDIAN, guardianNpPubkey: GNP,
      npBackend: { nip44Encrypt }, encryptionKey: 'k'.repeat(64), store, startDelayMs: 0, pollMs: 20, pollForMs: 500, retryDelaysMs: [],
    });
    return <ChildPermissionsGuardianRoute {...props} readiness={checks.forDependant(dep.id)} onWatchReadiness={() => checks.watch(dep.id)} />;
  }
  return render(<Harness />);
}

beforeEach(() => { mList.mockReset(); });

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
    expect(screen.queryByText(CHILD_READY_COPY.ready)).toBeNull();
  });

  it('the device cannot be read: "Can\'t confirm from this phone", never Ready, no count, no Finish now', async () => {
    mList.mockRejectedValue(new Error('offline'));
    renderRoute();
    expect(await screen.findByText(CHILD_READY_COPY.unknownHeading)).toBeTruthy();
    expect(screen.getByText(CHILD_READY_COPY.unknownBody('Lily'))).toBeTruthy();
    expect(screen.queryByText(CHILD_READY_COPY.ready)).toBeNull();
    expect(screen.queryByText(/still needed/)).toBeNull();
    expect(screen.queryByText(CHILD_READY_COPY.finishNow)).toBeNull();
  });
});
