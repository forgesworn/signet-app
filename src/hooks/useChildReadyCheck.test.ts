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
import type { ChildReadyRecords } from '../lib/db';
import { useGuardianReadyChecks, pairingKeyOf, type ChildReadyStore, type UseGuardianReadyChecksOpts } from './useChildReadyCheck';
import { APPROVE_IDENTITY_PLAINTEXT } from './useChildDeviceLink';

const mList = vi.mocked(listClients);
const NP = 'a'.repeat(64), PERSONA = 'b'.repeat(64);
const CHILD = 'd'.repeat(64), GUARDIAN = 'e'.repeat(64), GNP = '1'.repeat(64), MASTER = '2'.repeat(64);
const op = { isOpen: true } as unknown as HeartwoodMgmtClient;

function makeDep(over: Partial<DependantIdentity> = {}, pairedAt = Date.now()): DependantIdentity {
  return {
    ...buildPersonaFirstDependant({ guardianPubkey: GNP, enteredName: 'Lily', derivationPath: 'dependant-2',
      naturalPerson: { publicKey: NP, privateKey: '' }, persona: { publicKey: PERSONA, privateKey: '' }, createdAt: 1 }),
    childDevice: { mode: 'heartwood-direct', slotLabel: 'signet:child-device:v2:x', secretFingerprint: 'ab', slotIndex: 6,
      clientPubkey: CHILD, boundPersona: PERSONA, pairedAt },
    ...over,
  };
}
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
function memStore(initial: ChildReadyRecords = {}) {
  let data: ChildReadyRecords = { ...initial };
  const store: ChildReadyStore & { data(): ChildReadyRecords } = {
    data: () => data,
    load: vi.fn(async () => ({ ...data })),
    update: vi.fn(async (fn) => { const n = fn({ ...data }); if (n) data = n; }),
  };
  return store;
}

function opts(over: Partial<UseGuardianReadyChecksOpts> = {}): UseGuardianReadyChecksOpts {
  return {
    enabled: true, dependants: [makeDep()], operator: op, guardianNpPubkey: GNP, guardianClientPubkey: GUARDIAN, npBackend: null,
    encryptionKey: 'k'.repeat(64), store: memStore(), startDelayMs: 0, pollMs: 20, pollForMs: 2_000, retryDelaysMs: [20, 20], ...over,
  };
}
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

beforeEach(() => { mList.mockReset(); });

describe('useGuardianReadyChecks (guardian, App-level)', () => {
  it('a fresh pairing: probes its own natural person once through the NP route with no screen open, then trusts only the device', async () => {
    let state = device([], []);
    mList.mockImplementation(async () => state);
    const nip44Encrypt = vi.fn(async () => { state = device([], [GNP]); return 'x'; });
    const dep = makeDep();
    const { result } = renderHook(() => useGuardianReadyChecks(opts({ dependants: [dep], npBackend: { nip44Encrypt } })));
    await waitFor(() => expect(nip44Encrypt).toHaveBeenCalledTimes(1));
    expect(nip44Encrypt).toHaveBeenCalledWith(GNP, APPROVE_IDENTITY_PLAINTEXT);
    await waitFor(() => expect(result.current.forDependant(dep.id)!.rows.find(r => r.who === 'guardian')).toMatchObject({ state: 'ready' }));
    // The child's bound persona has had no press yet: still owed.
    expect(result.current.forDependant(dep.id)!.rows[0]).toMatchObject({ pubkey: PERSONA, state: 'waiting' });
    expect(result.current.forDependant(dep.id)!.summary).toEqual({ kind: 'owed', owed: 1 });
    // Its press lands (the child's phone probed it): the poll sees it.
    state = device([PERSONA], [GNP]);
    await waitFor(() => expect(result.current.forDependant(dep.id)!.summary.kind).toBe('ready'));
    expect(nip44Encrypt).toHaveBeenCalledTimes(1);
    expect(result.current.approvedByDep[dep.id]).toEqual([PERSONA]);
  });

  it('saves "owed" BEFORE the probe goes out, so leaving, a lock or a restart mid-probe keeps it owed', async () => {
    mList.mockResolvedValue(device([PERSONA], []));
    const store = memStore();
    let release: () => void = () => {};
    const nip44Encrypt = vi.fn(() => new Promise<string>((res) => { release = () => res('x'); }));
    const dep = makeDep();
    const first = renderHook(() => useGuardianReadyChecks(opts({ dependants: [dep], npBackend: { nip44Encrypt }, store })));
    await waitFor(() => expect(nip44Encrypt).toHaveBeenCalledTimes(1));
    expect(store.data()[dep.id]).toMatchObject({ pairing: pairingKeyOf(dep), guardian: 'owed' });
    // "Restart" with the press never made: a new instance, the device unreachable this time.
    first.unmount();
    release();
    mList.mockReset();
    mList.mockRejectedValue(new Error('offline'));
    const second = renderHook(() => useGuardianReadyChecks(opts({ dependants: [dep], npBackend: { nip44Encrypt }, store })));
    await waitFor(() => expect(second.result.current.forDependant(dep.id)!.summary).toEqual({ kind: 'owed', owed: 1 }));
    expect(second.result.current.forDependant(dep.id)!.rows.find(r => r.who === 'guardian')).toMatchObject({ state: 'waiting' });
    await wait(60);
    // Once per pairing: not sent again on its own.
    expect(nip44Encrypt).toHaveBeenCalledTimes(1);
  });

  it('no NP route: no probe, owed with Try again, saved as no-route', async () => {
    mList.mockResolvedValue(device([PERSONA], []));
    const store = memStore();
    const dep = makeDep();
    const { result } = renderHook(() => useGuardianReadyChecks(opts({ dependants: [dep], npBackend: null, store })));
    await waitFor(() => expect(result.current.forDependant(dep.id)!.rows.find(r => r.who === 'guardian')).toMatchObject({ state: 'waiting', failed: true }));
    expect(result.current.forDependant(dep.id)!.owed).toBe(1);
    await waitFor(() => expect(store.data()[dep.id]?.guardian).toBe('no-route'));
  });

  it('older firmware (no client_approvals): the probe still collects the press, but nothing is called Ready: unknown', async () => {
    mList.mockResolvedValue(device(undefined, undefined));
    const nip44Encrypt = vi.fn(async () => 'x');
    const dep = makeDep();
    const { result } = renderHook(() => useGuardianReadyChecks(opts({ dependants: [dep], npBackend: { nip44Encrypt } })));
    await waitFor(() => expect(nip44Encrypt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.forDependant(dep.id)!.summary).toEqual({ kind: 'unknown' }));
    expect(result.current.forDependant(dep.id)!.rows.every(r => r.state === 'unknown')).toBe(true);
    // The child is not told anything it cannot know: no `approved`.
    expect(result.current.approvedByDep[dep.id]).toBeUndefined();
  });

  it('a failed probe (timeout or refusal) stays owed', async () => {
    mList.mockResolvedValue(device([PERSONA], []));
    const nip44Encrypt = vi.fn(async () => { throw new Error('timed out'); });
    const dep = makeDep();
    const { result } = renderHook(() => useGuardianReadyChecks(opts({ dependants: [dep], npBackend: { nip44Encrypt } })));
    await waitFor(() => expect(result.current.forDependant(dep.id)!.rows.find(r => r.who === 'guardian')).toMatchObject({ state: 'waiting', failed: true }));
    expect(result.current.forDependant(dep.id)!.owed).toBe(1);
  });

  it('already listed on the device: no probe at all', async () => {
    mList.mockResolvedValue(device([PERSONA], [GNP]));
    const nip44Encrypt = vi.fn(async () => 'x');
    const dep = makeDep();
    const { result } = renderHook(() => useGuardianReadyChecks(opts({ dependants: [dep], npBackend: { nip44Encrypt } })));
    await waitFor(() => expect(result.current.forDependant(dep.id)!.summary.kind).toBe('ready'));
    await wait(30);
    expect(nip44Encrypt).not.toHaveBeenCalled();
  });

  it('an older pairing (outside the window): reads only; the probe is sent on Finish now', async () => {
    let state = device([PERSONA], []);
    mList.mockImplementation(async () => state);
    const nip44Encrypt = vi.fn(async () => { state = device([PERSONA], [GNP]); return 'x'; });
    const dep = makeDep({}, 1);
    const { result } = renderHook(() => useGuardianReadyChecks(opts({ dependants: [dep], npBackend: { nip44Encrypt } })));
    await waitFor(() => expect(result.current.forDependant(dep.id)!.owed).toBe(1));
    await wait(30);
    expect(nip44Encrypt).not.toHaveBeenCalled();
    await act(async () => { await result.current.forDependant(dep.id)!.finishNow(); });
    expect(nip44Encrypt).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.forDependant(dep.id)!.summary.kind).toBe('ready'));
  });

  it('a failed read is unknown (never Ready, never "child gone") and is retried with backoff', async () => {
    mList.mockRejectedValue(new Error('offline'));
    const dep = makeDep({}, 1);
    const { result } = renderHook(() => useGuardianReadyChecks(opts({ dependants: [dep] })));
    await waitFor(() => expect(result.current.forDependant(dep.id)!.summary).toEqual({ kind: 'unknown' }));
    expect(result.current.forDependant(dep.id)!.checked).toBe(true);
    await waitFor(() => expect(mList.mock.calls.length).toBeGreaterThanOrEqual(3));
    // Bounded: one first try plus the two listed retries, then quiet.
    await wait(80);
    expect(mList).toHaveBeenCalledTimes(3);
  });

  it('a reply with an empty or missing client list is unknown, not "child gone"', async () => {
    const dep = makeDep({}, 1);
    mList.mockResolvedValue([]);
    const empty = renderHook(() => useGuardianReadyChecks(opts({ dependants: [dep] })));
    await waitFor(() => expect(empty.result.current.forDependant(dep.id)!.summary).toEqual({ kind: 'unknown' }));
    empty.unmount();
    mList.mockReset();
    mList.mockRejectedValue(new Error('list_clients reply had no client list'));
    const missing = renderHook(() => useGuardianReadyChecks(opts({ dependants: [dep] })));
    await waitFor(() => expect(missing.result.current.forDependant(dep.id)!.summary).toEqual({ kind: 'unknown' }));
  });

  it('a transient read failure keeps the last good reading for the child (no flapping `approved`)', async () => {
    mList.mockResolvedValue(device([PERSONA], [GNP]));
    const dep = makeDep({}, 1);
    const { result } = renderHook(() => useGuardianReadyChecks(opts({ dependants: [dep], retryDelaysMs: [] })));
    await waitFor(() => expect(result.current.approvedByDep[dep.id]).toEqual([PERSONA]));
    mList.mockRejectedValue(new Error('offline'));
    act(() => { result.current.watch(dep.id); });
    await waitFor(() => expect(result.current.forDependant(dep.id)!.summary.kind).toBe('unknown'));
    expect(result.current.approvedByDep[dep.id]).toEqual([PERSONA]);
  });

  it('approvedAtByDep: when the device was read for the child, moving with every good reading; the saved time before any', async () => {
    const dep = makeDep({}, 1);
    const store = memStore({ [dep.id.toLowerCase()]: { pairing: pairingKeyOf(dep), guardian: 'confirmed', approved: [PERSONA], at: 1_700_000_000_000 } });
    let release!: () => void;
    mList.mockImplementationOnce(() => new Promise(r => { release = () => r(device([PERSONA], [GNP])); }));
    const { result } = renderHook(() => useGuardianReadyChecks(opts({ dependants: [dep], store })));
    // The saved reading and its time, until the device answers.
    await waitFor(() => expect(result.current.approvedAtByDep[dep.id]).toBe(1_700_000_000_000));
    const asked = Date.now();
    await act(async () => { release(); });
    await waitFor(() => expect(result.current.approvedAtByDep[dep.id]).toBeGreaterThanOrEqual(asked - 50));
    const first = result.current.approvedAtByDep[dep.id];
    expect(result.current.approvedByDep[dep.id]).toEqual([PERSONA]);
    mList.mockResolvedValue(device([PERSONA], [GNP]));
    await wait(5);
    act(() => { result.current.watch(dep.id); });
    await waitFor(() => expect(result.current.approvedAtByDep[dep.id]).toBeGreaterThan(first));
  });

  it('paused: no probe and no nag; the pause ending starts the check', async () => {
    mList.mockResolvedValue(device([], []));
    const nip44Encrypt = vi.fn(async () => 'x');
    const paused = makeDep({ defaultSchedule: { paused: true } as DependantIdentity['defaultSchedule'] });
    const { result, rerender } = renderHook((p: { dep: DependantIdentity }) => useGuardianReadyChecks(opts({ dependants: [p.dep], npBackend: { nip44Encrypt } })),
      { initialProps: { dep: paused } });
    await waitFor(() => expect(result.current.forDependant(paused.id)!.summary).toEqual({ kind: 'paused' }));
    expect(result.current.forDependant(paused.id)!.owed).toBe(0);
    await act(async () => { await result.current.forDependant(paused.id)!.finishNow(); });
    await wait(30);
    expect(nip44Encrypt).not.toHaveBeenCalled();
    rerender({ dep: { ...paused, defaultSchedule: undefined } });
    await waitFor(() => expect(nip44Encrypt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.forDependant(paused.id)!.summary.kind).toBe('owed'));
  });

  it('this phone\'s client key resolving after the first read: reads again and its own row follows', async () => {
    mList.mockResolvedValue(device([PERSONA], [GNP]));
    const dep = makeDep({}, 1);
    const { result, rerender } = renderHook((p: { me: string | null }) => useGuardianReadyChecks(opts({ dependants: [dep], guardianClientPubkey: p.me })),
      { initialProps: { me: null as string | null } });
    await waitFor(() => expect(result.current.forDependant(dep.id)!.summary).toEqual({ kind: 'unknown' }));
    const before = mList.mock.calls.length;
    rerender({ me: GUARDIAN });
    await waitFor(() => expect(result.current.forDependant(dep.id)!.summary).toEqual({ kind: 'ready' }));
    expect(mList.mock.calls.length).toBeGreaterThan(before);
  });

  it('no operator channel on this phone: cannot ask, so unknown; nothing while the key is still loading', async () => {
    const dep = makeDep({}, 1);
    const pending = renderHook(() => useGuardianReadyChecks(opts({ dependants: [dep], operator: null, operatorPending: true })));
    await wait(30);
    expect(pending.result.current.forDependant(dep.id)!.summary).toEqual({ kind: 'empty' });
    const none = renderHook(() => useGuardianReadyChecks(opts({ dependants: [dep], operator: null })));
    await waitFor(() => expect(none.result.current.forDependant(dep.id)!.summary).toEqual({ kind: 'unknown' }));
    expect(mList).not.toHaveBeenCalled();
  });

  it('disabled or not a direct dependant: nothing', async () => {
    mList.mockResolvedValue(device([PERSONA], [GNP]));
    const dep = makeDep();
    const off = renderHook(() => useGuardianReadyChecks(opts({ dependants: [dep], enabled: false })));
    await wait(30);
    expect(off.result.current.forDependant(dep.id)).toBeNull();
    expect(mList).not.toHaveBeenCalled();
    const legacy = { ...dep, childDevice: undefined };
    const leg = renderHook(() => useGuardianReadyChecks(opts({ dependants: [legacy] })));
    await wait(30);
    expect(leg.result.current.forDependant(dep.id)).toBeNull();
  });
});
