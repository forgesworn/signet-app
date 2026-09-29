// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../lib/heartwood-mgmt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/heartwood-mgmt')>();
  return { ...actual, listClients: vi.fn(), updateClientPolicy: vi.fn() };
});

import { listClients, updateClientPolicy, type HeartwoodMgmtClient } from '../lib/heartwood-mgmt';
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
