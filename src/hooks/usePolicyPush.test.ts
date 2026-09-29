// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../lib/heartwood-mgmt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/heartwood-mgmt')>();
  return { ...actual, listClients: vi.fn(), updateClientPolicy: vi.fn(), revokeClient: vi.fn() };
});
vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/db')>();
  return { ...actual, listPendingChildRevokes: vi.fn(async () => []), removePendingChildRevoke: vi.fn(async () => {}) };
});
import { listPendingChildRevokes, removePendingChildRevoke } from '../lib/db';

import { listClients, revokeClient, updateClientPolicy, type HeartwoodMgmtClient } from '../lib/heartwood-mgmt';
import { buildPersonaFirstDependant } from '../lib/dependant-record';
import { childDirectSlotLabel } from '../lib/policy-compiler';
import { childRuleId } from '../lib/child-rules';
import type { DeviceClientSlot } from '../lib/heartwood-mgmt-types';
import type { ChildRule } from '../types/child-rules';
import type { DependantIdentity } from '../types';
import { usePolicyPush, earliestChildExpiryMs, POLICY_PUSH_DEBOUNCE_MS, type UsePolicyPushArgs } from './usePolicyPush';

const mList = vi.mocked(listClients), mUpdate = vi.mocked(updateClientPolicy);
const PERSONA = 'b'.repeat(64), NP = 'a'.repeat(64), CLIENT = 'c'.repeat(64);
const client = { isOpen: true } as unknown as HeartwoodMgmtClient;

const dep: DependantIdentity = { ...buildPersonaFirstDependant({
  guardianPubkey: 'f'.repeat(64), enteredName: 'Lily', derivationPath: 'dependant-0',
  naturalPerson: { publicKey: NP, privateKey: '' }, persona: { publicKey: PERSONA, privateKey: '' }, createdAt: 1,
}), autonomyStage: 'request-approve' };

function directSlot(): DeviceClientSlot {
  return { slotIndex: 4, label: childDirectSlotLabel(dep.id), secretFingerprint: 'ab'.repeat(32), autoApprove: true, signingApproved: true,
    strictPermissions: true, currentPubkey: CLIENT, authorizedPubkeys: [CLIENT], allowedKinds: [22242],
    allowedMethods: ['get_public_key', 'sign_event', 'nip44_encrypt', 'nip44_decrypt'], escalate: false, petitionOnDeny: false,
    auditChildWrap: false, boundIdentity: PERSONA };
}
function kindRule(kind: number, over: Partial<ChildRule> = {}): ChildRule {
  const target = 'site:https://game.example.com' as const;
  return { id: childRuleId(dep.id, '*', `kind:${kind}`, target), dependantId: dep.id, persona: '*', scope: `kind:${kind}`, target,
    decision: 'allow', createdAt: 1, updatedAt: 1, ...over };
}
const base = (over: Partial<UsePolicyPushArgs> = {}): UsePolicyPushArgs => ({
  client, enabled: true, encryptionKey: null, signingMode: 'local', dependants: [dep], grants: [], ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  mList.mockReset(); mUpdate.mockReset();
  mList.mockResolvedValue([directSlot()]);
  mUpdate.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });
const flush = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('usePolicyPush — child-direct inputs', () => {
  it('passes child rules through: an allow kind rule widens the child-direct ceiling', async () => {
    renderHook(() => usePolicyPush(base({ childRules: [kindRule(30023)] })));
    await flush(POLICY_PUSH_DEBOUNCE_MS + 10);
    expect(mUpdate).toHaveBeenCalledTimes(1);
    expect(mUpdate.mock.calls[0][2].allowedKinds).toContain(30023);
  });

  it('holds the push while child rules are still loading (null)', async () => {
    const { rerender } = renderHook((p: { rules: ChildRule[] | null }) => usePolicyPush(base({ childRules: p.rules })), { initialProps: { rules: null as ChildRule[] | null } });
    await flush(POLICY_PUSH_DEBOUNCE_MS + 10);
    expect(mList).not.toHaveBeenCalled();
    rerender({ rules: [] });
    await flush(POLICY_PUSH_DEBOUNCE_MS + 10);
    expect(mList).toHaveBeenCalled();
  });

  it('A38: holds the push while approved-once kinds are still loading (null)', async () => {
    const { rerender } = renderHook((p: { once: Record<string, { kind: number; until: number }[]> | null }) =>
      usePolicyPush(base({ childRules: [], approvedOnceKinds: p.once })), { initialProps: { once: null as Record<string, { kind: number; until: number }[]> | null } });
    await flush(POLICY_PUSH_DEBOUNCE_MS + 10);
    expect(mList).not.toHaveBeenCalled();
    rerender({ once: {} });
    await flush(POLICY_PUSH_DEBOUNCE_MS + 10);
    expect(mList).toHaveBeenCalled();
  });

  it('A31: compiles from fresh reads (DB rules + the current approved-once ref) taken at push time', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    let onceRef: Record<string, { kind: number; until: number }[]> = {};
    const loadChildRules = vi.fn(async () => [kindRule(30023)]);
    renderHook(() => usePolicyPush(base({ childRules: [], approvedOnceKinds: {}, getApprovedOnce: () => onceRef, loadChildRules })));
    onceRef = { [dep.id]: [{ kind: 30311, until: nowS + 600 }] }; // written after render, before the debounced run
    await flush(POLICY_PUSH_DEBOUNCE_MS + 10);
    expect(loadChildRules).toHaveBeenCalled();
    expect(mUpdate.mock.calls[0][2].allowedKinds).toEqual(expect.arrayContaining([30023, 30311]));
  });

  it('recompiles when child rules change', async () => {
    const { rerender } = renderHook((p: { rules: ChildRule[] }) => usePolicyPush(base({ childRules: p.rules })), { initialProps: { rules: [] as ChildRule[] } });
    await flush(POLICY_PUSH_DEBOUNCE_MS + 10);
    const before = mList.mock.calls.length;
    rerender({ rules: [kindRule(30023)] });
    await flush(POLICY_PUSH_DEBOUNCE_MS + 10);
    expect(mList.mock.calls.length).toBe(before + 1);
    expect(mUpdate.mock.calls.at(-1)![2].allowedKinds).toContain(30023);
  });

  it('an approved-once kind widens the ceiling, and a push re-runs at its expiry', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    renderHook(() => usePolicyPush(base({ childRules: [], approvedOnceKinds: { [dep.id]: [{ kind: 30311, until: nowS + 60 }] } })));
    await flush(POLICY_PUSH_DEBOUNCE_MS + 10);
    expect(mUpdate.mock.calls[0][2].allowedKinds).toContain(30311);
    const before = mList.mock.calls.length;
    await flush(62_000);
    expect(mList.mock.calls.length).toBeGreaterThan(before);
    expect(mUpdate.mock.calls.at(-1)![2].allowedKinds).not.toContain(30311);
  });

  it('A21: a push re-runs just after the earliest child rule expiry', async () => {
    const rules = [kindRule(30023, { expiresAt: Date.now() + 30_000 })];
    renderHook(() => usePolicyPush(base({ childRules: rules })));
    await flush(POLICY_PUSH_DEBOUNCE_MS + 10);
    expect(mUpdate.mock.calls[0][2].allowedKinds).toContain(30023);
    const before = mList.mock.calls.length;
    await flush(32_000);
    expect(mList.mock.calls.length).toBeGreaterThan(before);
    expect(mUpdate.mock.calls.at(-1)![2].allowedKinds).not.toContain(30023);
  });
});

describe('earliestChildExpiryMs', () => {
  it('takes the earlier of approved-once (s) and live rule expiry (ms); ignores past and tombstoned', () => {
    const now = 1_000_000;
    expect(earliestChildExpiryMs({}, [], now)).toBeNull();
    expect(earliestChildExpiryMs({ d: [{ kind: 1, until: 2_000 }] }, [kindRule(1, { expiresAt: 1_500_000 })], now)).toBe(1_500_000);
    expect(earliestChildExpiryMs({ d: [{ kind: 1, until: 1_200 }] }, [kindRule(1, { expiresAt: 1_500_000 })], now)).toBe(1_200_000);
    expect(earliestChildExpiryMs({}, [kindRule(1, { expiresAt: 900_000 }), kindRule(2, { expiresAt: 1_100_000, tombstonedAt: 5 })], now)).toBeNull();
  });
});

describe('A24: pending revokes', () => {
  it('a push first retries each remembered revoke and drops the done ones', async () => {
    const rec = { label: 'signet:child-device:v2:x', slotIndex: 9, secretFingerprint: 'ab'.repeat(32), dependantId: dep.id };
    vi.mocked(listPendingChildRevokes).mockResolvedValue([rec]);
    vi.mocked(revokeClient).mockResolvedValue(undefined);
    renderHook(() => usePolicyPush(base({ encryptionKey: 'k'.repeat(64), childRules: [] })));
    await flush(POLICY_PUSH_DEBOUNCE_MS + 10);
    expect(vi.mocked(revokeClient).mock.calls[0][1]).toEqual({ slotIndex: 9, secretFingerprint: 'ab'.repeat(32) });
    expect(vi.mocked(removePendingChildRevoke)).toHaveBeenCalledWith(rec, 'k'.repeat(64));
  });
});
