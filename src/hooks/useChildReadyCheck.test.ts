// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../lib/heartwood-mgmt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/heartwood-mgmt')>();
  return { ...actual, listClients: vi.fn() };
});

import { listClients, type HeartwoodMgmtClient } from '../lib/heartwood-mgmt';
import { buildPersonaFirstDependant } from '../lib/dependant-record';
import type { ClientApproval, DeviceClientSlot } from '../lib/heartwood-mgmt-types';
import type { DependantIdentity } from '../types';
import { useChildReadyCheck, resetChildReadyCheckMemory, type UseChildReadyCheckOpts } from './useChildReadyCheck';
import { APPROVE_IDENTITY_PLAINTEXT } from './useChildDeviceLink';

const mList = vi.mocked(listClients);
const NP = 'a'.repeat(64), PERSONA = 'b'.repeat(64);
const CHILD = 'd'.repeat(64), GUARDIAN = 'e'.repeat(64), GNP = '1'.repeat(64), MASTER = '2'.repeat(64);
const op = { isOpen: true } as unknown as HeartwoodMgmtClient;

const dep: DependantIdentity = {
  ...buildPersonaFirstDependant({ guardianPubkey: GNP, enteredName: 'Lily', derivationPath: 'dependant-2',
    naturalPerson: { publicKey: NP, privateKey: '' }, persona: { publicKey: PERSONA, privateKey: '' }, createdAt: 1 }),
  childDevice: { mode: 'heartwood-direct', slotLabel: 'signet:child-device:v2:x', secretFingerprint: 'ab', slotIndex: 6,
    clientPubkey: CHILD, boundPersona: PERSONA, pairedAt: 1 },
};
function slot(over: Partial<DeviceClientSlot>): DeviceClientSlot {
  return { slotIndex: 0, label: '', secretFingerprint: 'x', autoApprove: true, signingApproved: true, strictPermissions: true, currentPubkey: null,
    authorizedPubkeys: [], allowedKinds: [], allowedMethods: [], escalate: false, petitionOnDeny: false, auditChildWrap: false, boundIdentity: null, ...over };
}
const grant = (client: string, ids: string[]): ClientApproval => ({ clientPubkey: client, approvedIdentities: ids, legacyIdentityTags: [] });
/** The device as `list_clients` reports it; `undefined` approvals = older firmware. */
function device(child: string[] | undefined, guardian: string[] | undefined): DeviceClientSlot[] {
  return [
    slot({ slotIndex: 6, secretFingerprint: 'ab', currentPubkey: CHILD, authorizedPubkeys: [CHILD], ...(child ? { clientApprovals: [grant(CHILD, child)] } : {}) }),
    slot({ slotIndex: 1, secretFingerprint: 'g', currentPubkey: GUARDIAN, authorizedPubkeys: [GUARDIAN], boundIdentity: MASTER, ...(guardian ? { clientApprovals: [grant(GUARDIAN, guardian)] } : {}) }),
  ];
}

function opts(over: Partial<UseChildReadyCheckOpts> = {}): UseChildReadyCheckOpts {
  return {
    dependant: dep, operator: op, guardianNpPubkey: GNP, guardianClientPubkey: GUARDIAN, npBackend: null,
    enabled: true, probeOnStart: false, startDelayMs: 0, pollMs: 20, pollForMs: 2_000, ...over,
  };
}

beforeEach(() => { mList.mockReset(); resetChildReadyCheckMemory(); });

describe('useChildReadyCheck (guardian)', () => {
  it('end of pairing: probes its own natural person once through the NP route, then trusts only the device', async () => {
    let state = device([], []);
    mList.mockImplementation(async () => state);
    const nip44Encrypt = vi.fn(async () => { state = device([], [GNP]); return 'x'; });
    const { result } = renderHook(() => useChildReadyCheck(opts({ probeOnStart: true, npBackend: { nip44Encrypt } })));
    await waitFor(() => expect(nip44Encrypt).toHaveBeenCalledTimes(1));
    expect(nip44Encrypt).toHaveBeenCalledWith(GNP, APPROVE_IDENTITY_PLAINTEXT);
    await waitFor(() => expect(result.current.rows.find(r => r.who === 'guardian')).toMatchObject({ state: 'ready', verified: true }));
    // The child's bound persona has had no press yet: still owed.
    expect(result.current.rows[0]).toMatchObject({ pubkey: PERSONA, state: 'waiting' });
    expect(result.current.owed).toBe(1);
    // Its press lands (the child's phone probed it): the poll sees it.
    state = device([PERSONA], [GNP]);
    await waitFor(() => expect(result.current.owed).toBe(0));
    expect(nip44Encrypt).toHaveBeenCalledTimes(1);
  });

  it('no NP route: no probe, recorded as not confirmed (still owed), never as done', async () => {
    mList.mockResolvedValue(device([PERSONA], []));
    const { result } = renderHook(() => useChildReadyCheck(opts({ probeOnStart: true, npBackend: null })));
    await waitFor(() => expect(result.current.rows.find(r => r.who === 'guardian')).toMatchObject({ state: 'waiting', failed: true }));
    expect(result.current.owed).toBe(1);
  });

  it('older firmware (no client_approvals): a probe answer is the fallback, marked unverified', async () => {
    mList.mockResolvedValue(device(undefined, undefined));
    const nip44Encrypt = vi.fn(async () => 'x');
    const { result } = renderHook(() => useChildReadyCheck(opts({ probeOnStart: true, npBackend: { nip44Encrypt } })));
    await waitFor(() => expect(result.current.rows.find(r => r.who === 'guardian')).toMatchObject({ state: 'ready', verified: false }));
    expect(result.current.owed).toBe(0);
    expect(result.current.unverified).toBe(true);
  });

  it('a failed probe (timeout or refusal) stays owed', async () => {
    mList.mockResolvedValue(device([PERSONA], []));
    const nip44Encrypt = vi.fn(async () => { throw new Error('timed out'); });
    const { result } = renderHook(() => useChildReadyCheck(opts({ probeOnStart: true, npBackend: { nip44Encrypt } })));
    await waitFor(() => expect(result.current.rows.find(r => r.who === 'guardian')).toMatchObject({ state: 'waiting', failed: true }));
    expect(result.current.owed).toBe(1);
  });

  it('already listed on the device: no probe at all', async () => {
    mList.mockResolvedValue(device([PERSONA], [GNP]));
    const nip44Encrypt = vi.fn(async () => 'x');
    const { result } = renderHook(() => useChildReadyCheck(opts({ probeOnStart: true, npBackend: { nip44Encrypt } })));
    await waitFor(() => expect(result.current.checked).toBe(true));
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
    expect(nip44Encrypt).not.toHaveBeenCalled();
    expect(result.current.owed).toBe(0);
  });

  it('elsewhere (Permissions): reads only; the probe is sent on Finish now', async () => {
    let state = device([PERSONA], []);
    mList.mockImplementation(async () => state);
    const nip44Encrypt = vi.fn(async () => { state = device([PERSONA], [GNP]); return 'x'; });
    const { result } = renderHook(() => useChildReadyCheck(opts({ probeOnStart: false, npBackend: { nip44Encrypt } })));
    await waitFor(() => expect(result.current.owed).toBe(1));
    expect(nip44Encrypt).not.toHaveBeenCalled();
    await act(async () => { await result.current.finishNow(); });
    expect(nip44Encrypt).toHaveBeenCalledTimes(1);
    expect(result.current.owed).toBe(0);
  });

  it('the automatic probe runs once per pairing, not on every remount', async () => {
    mList.mockResolvedValue(device([PERSONA], []));
    const nip44Encrypt = vi.fn(async () => { throw new Error('timed out'); });
    const first = renderHook(() => useChildReadyCheck(opts({ probeOnStart: true, npBackend: { nip44Encrypt } })));
    await waitFor(() => expect(nip44Encrypt).toHaveBeenCalledTimes(1));
    first.unmount();
    const second = renderHook(() => useChildReadyCheck(opts({ probeOnStart: true, npBackend: { nip44Encrypt } })));
    await waitFor(() => expect(second.result.current.checked).toBe(true));
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
    expect(nip44Encrypt).toHaveBeenCalledTimes(1);
  });

  it('disabled, or a device that cannot be read: no rows, no notice, nothing thrown', async () => {
    mList.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useChildReadyCheck(opts()));
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
    expect(result.current.rows).toEqual([]);
    expect(result.current.checked).toBe(false);
    const off = renderHook(() => useChildReadyCheck(opts({ enabled: false })));
    await act(async () => { await new Promise(r => setTimeout(r, 30)); });
    expect(off.result.current.rows).toEqual([]);
  });
});
