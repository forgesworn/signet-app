import { describe, it, expect, vi } from 'vitest';
import {
  runPolicyPush,
  submitVerdict,
  describeVerdictOutcome,
  describePushResult,
  resolveVerdictAvailability,
  operatorFeatureFlags,
  isRefreshAndRetryError,
  PANEL_APPROVE_WINDOW_S,
  type PolicyPushIo,
} from './policy-push';
import type { DeviceClientSlot, DeviceStatus, SlotPolicyUpdate } from './heartwood-mgmt-types';
import type { DependantIdentity } from '../types';
import type { RememberedGrant } from '../types/grants';
import type { VerdictResult } from './heartwood-mgmt';

const NP = 'a'.repeat(64);
const PERSONA = 'b'.repeat(64);
const GUARDIAN_CLIENT = 'd'.repeat(64);
const STRANGER = 'e'.repeat(64);
const NOW = 1_000_000;

function slot(overrides: Partial<DeviceClientSlot> = {}): DeviceClientSlot {
  return {
    slotIndex: 1,
    label: 'MySignet',
    secretFingerprint: 'f'.repeat(64),
    autoApprove: false,
    signingApproved: false,
    strictPermissions: true,
    currentPubkey: null,
    authorizedPubkeys: [],
    allowedKinds: [],
    allowedMethods: [],
    escalate: false,
    petitionOnDeny: false,
    auditChildWrap: false,
    boundIdentity: NP,
    ...overrides,
  };
}

function appDep(overrides: Partial<DependantIdentity> = {}): DependantIdentity {
  return {
    id: NP,
    guardianPubkey: '9'.repeat(64),
    displayName: 'Kid',
    naturalPerson: { publicKey: NP, privateKey: '', displayName: 'Kid' },
    persona: { publicKey: PERSONA, privateKey: '', displayName: 'Anon' },
    extraPersonas: [],
    derivationPath: 'dependant-0',
    createdAt: 0,
    autonomyStage: 'autonomous-alerts',
    primaryKeypair: 'natural-person',
    ...overrides,
  } as DependantIdentity;
}

/** A dep slot the device already has EXACTLY right for autonomous-alerts with no grants. */
function currentDepSlot(): DeviceClientSlot {
  return slot({
    allowedMethods: ['get_public_key', 'sign_event', 'nip44_encrypt', 'nip44_decrypt'],
    allowedKinds: [0, 1, 4, 7, 13, 1059, 9734, 21235, 21236, 24242],
    autoApprove: true,
    escalate: true,
    petitionOnDeny: false,
    auditChildWrap: true,
  });
}

function fakeIo(inventory: () => DeviceClientSlot[], update?: PolicyPushIo['updateClientPolicy']): PolicyPushIo & { updates: Array<{ slotIndex: number; policy: SlotPolicyUpdate }> } {
  const updates: Array<{ slotIndex: number; policy: SlotPolicyUpdate }> = [];
  return {
    updates,
    listClients: async () => inventory(),
    updateClientPolicy: update ?? (async (s, p) => { updates.push({ slotIndex: s.slotIndex, policy: p }); }),
  };
}

const baseInput = (grants: RememberedGrant[] = []) => ({
  dependants: [appDep()],
  grants,
  guardianClientPubkey: GUARDIAN_CLIENT,
  nowSeconds: NOW,
});

describe('runPolicyPush', () => {
  it('pushes only changed family slots; counts unchanged + untouched', async () => {
    const io = fakeIo(() => [
      slot({ slotIndex: 1 }),                                   // dep slot, wrong policy ⇒ push
      { ...currentDepSlot(), slotIndex: 2 },                     // dep slot already right ⇒ unchanged
      slot({ slotIndex: 3, boundIdentity: null, currentPubkey: STRANGER }), // consumer ⇒ untouched
      slot({ slotIndex: 4, boundIdentity: null, currentPubkey: GUARDIAN_CLIENT, allowedMethods: ['sign_event'] }), // guardian ⇒ push
    ]);
    const r = await runPolicyPush(io, baseInput());
    expect(r.errors).toEqual([]);
    expect(r.pushed).toBe(2);
    expect(r.unchanged).toBe(1);
    expect(r.untouched).toBe(1);
    expect(io.updates.map((u) => u.slotIndex)).toEqual([1, 4]);
    // The dep slot policy is the autonomous-alerts row.
    expect(io.updates[0].policy.autoApprove).toBe(true);
    expect(io.updates[0].policy.escalate).toBe(true);
    // The guardian slot never escalates.
    expect(io.updates[1].policy.escalate).toBe(false);
    expect(io.updates[1].policy.autoApprove).toBe(true);
  });

  it('list_clients failure lands in errors, never throws', async () => {
    const io: PolicyPushIo = {
      listClients: async () => { throw new Error('timeout waiting for device (list_clients)'); },
      updateClientPolicy: async () => { throw new Error('should not be called'); },
    };
    const r = await runPolicyPush(io, baseInput());
    expect(r.pushed).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/could not read the device's client list/);
  });

  it('non-retryable slot error is recorded and the run continues', async () => {
    let calls = 0;
    const io = fakeIo(
      () => [slot({ slotIndex: 1 }), slot({ slotIndex: 2 })],
      async (s) => { calls += 1; if (s.slotIndex === 1) throw new Error('device low on memory; state unchanged, retry shortly'); },
    );
    const r = await runPolicyPush(io, baseInput());
    expect(calls).toBe(2);
    expect(r.pushed).toBe(1);
    expect(r.errors).toEqual(['slot 1: device low on memory; state unchanged, retry shortly']);
  });

  it('stale_management_challenge → refresh + recompile + retry once (then success)', async () => {
    let listCalls = 0;
    let updateCalls = 0;
    const io = fakeIo(
      () => { listCalls += 1; return [slot({ slotIndex: 1 })]; },
      async () => { updateCalls += 1; if (updateCalls === 1) throw new Error('stale_management_challenge: fetch a fresh one'); },
    );
    const r = await runPolicyPush(io, baseInput());
    expect(listCalls).toBe(2);
    expect(updateCalls).toBe(2);
    expect(r.pushed).toBe(1);
    expect(r.errors).toEqual([]);
  });

  it('stale_client_slot → retry once with the refreshed fingerprint; second failure is recorded', async () => {
    let listCalls = 0;
    const fingerprints: string[] = [];
    const io = fakeIo(
      () => { listCalls += 1; return [slot({ slotIndex: 1, secretFingerprint: listCalls === 1 ? 'old'.padEnd(64, '0') : 'new'.padEnd(64, '0') })]; },
      async (s) => { fingerprints.push(s.secretFingerprint); throw new Error('stale_client_slot: slot 1 was re-minted'); },
    );
    const r = await runPolicyPush(io, baseInput());
    expect(fingerprints).toEqual(['old'.padEnd(64, '0'), 'new'.padEnd(64, '0')]);
    expect(r.pushed).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/slot 1: stale_client_slot/);
  });

  it('after refresh, a slot no longer family is counted untouched, not errored', async () => {
    let listCalls = 0;
    const io = fakeIo(
      () => { listCalls += 1; return listCalls === 1 ? [slot({ slotIndex: 1 })] : [slot({ slotIndex: 1, boundIdentity: null })]; },
      async () => { throw new Error('stale_management_challenge'); },
    );
    const r = await runPolicyPush(io, baseInput());
    expect(r.pushed).toBe(0);
    expect(r.untouched).toBe(1);
    expect(r.errors).toEqual([]);
  });

  it('carries compiler warnings (guardian pairing missing from inventory)', async () => {
    const io = fakeIo(() => [slot({ slotIndex: 1 })]);
    const r = await runPolicyPush(io, baseInput());
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/guardian client pubkey not found/);
  });

  it('describePushResult summarises', () => {
    expect(describePushResult({ pushed: 2, unchanged: 1, untouched: 3, errors: ['x'], warnings: [] }))
      .toBe('2 updated · 1 already current · 3 not family · 1 failed');
    expect(describePushResult({ pushed: 0, unchanged: 4, untouched: 0, errors: [], warnings: [] }))
      .toBe('0 updated · 4 already current');
  });

  it('isRefreshAndRetryError recognises both stale conditions only', () => {
    expect(isRefreshAndRetryError('stale_management_challenge: x')).toBe(true);
    expect(isRefreshAndRetryError('stale_client_slot: x')).toBe(true);
    expect(isRefreshAndRetryError('device low on memory')).toBe(false);
    expect(isRefreshAndRetryError('timeout waiting for device')).toBe(false);
  });
});

describe('submitVerdict', () => {
  const PARK = '7'.repeat(64);

  it('sends approve-once with the 10-minute window', async () => {
    const resolveApproval = vi.fn(async (): Promise<VerdictResult> => ({ park: 'live', applied: 'completed' }));
    const r = await submitVerdict({ resolveApproval }, PARK, 'approve-once');
    expect(r).toEqual({ park: 'live', applied: 'completed' });
    expect(resolveApproval).toHaveBeenCalledWith({ park: PARK, action: 'approve-once', windowSeconds: PANEL_APPROVE_WINDOW_S });
  });

  it('retries exactly once on a stale challenge', async () => {
    let n = 0;
    const resolveApproval = vi.fn(async (): Promise<VerdictResult> => {
      n += 1;
      if (n === 1) throw new Error('stale_management_challenge: aged out');
      return { park: 'expired', applied: 'window' };
    });
    const r = await submitVerdict({ resolveApproval }, PARK, 'deny');
    expect(n).toBe(2);
    expect(r.applied).toBe('window');
  });

  it('does not retry other errors, and a second stale error propagates', async () => {
    const other = vi.fn(async (): Promise<VerdictResult> => { throw new Error('timeout waiting for device (resolve_approval)'); });
    await expect(submitVerdict({ resolveApproval: other }, PARK, 'deny')).rejects.toThrow(/timeout/);
    expect(other).toHaveBeenCalledTimes(1);
    const stale = vi.fn(async (): Promise<VerdictResult> => { throw new Error('stale_management_challenge'); });
    await expect(submitVerdict({ resolveApproval: stale }, PARK, 'approve-once')).rejects.toThrow(/stale/);
    expect(stale).toHaveBeenCalledTimes(2);
  });
});

describe('describeVerdictOutcome', () => {
  it('maps every applied outcome per the plan copy', () => {
    expect(describeVerdictOutcome('approve-once', { park: 'live', applied: 'completed' })).toBe('Approved — their app got it');
    expect(describeVerdictOutcome('approve-once', { park: 'expired', applied: 'window' })).toBe('Approved — their next try (10 min) will go through');
    expect(describeVerdictOutcome('approve-once', { park: 'expired', applied: 'none' })).toBe('Too late — nothing left to approve');
    expect(describeVerdictOutcome('approve-once', { park: 'live', applied: 'policy' })).toMatch(/^Approved/);
    expect(describeVerdictOutcome('deny', { park: 'live', applied: 'none' })).toBe('Denied');
    expect(describeVerdictOutcome('deny', { park: 'expired', applied: 'none' })).toMatch(/^Denied/);
  });
});

describe('availability + feature flags', () => {
  const status = (caps: string[] | null): DeviceStatus => ({ capabilities: caps, masterNpubHex: '', truncated: caps === null });

  it('resolveVerdictAvailability', () => {
    expect(resolveVerdictAvailability(false, null)).toBe('no-operator-key');
    expect(resolveVerdictAvailability(false, status(['resolve_approval_v1']))).toBe('no-operator-key');
    expect(resolveVerdictAvailability(true, null)).toBe('ready');
    expect(resolveVerdictAvailability(true, status(null))).toBe('ready');
    expect(resolveVerdictAvailability(true, status([]))).toBe('device-unsupported');
    expect(resolveVerdictAvailability(true, status(['client_policy_flags_v1']))).toBe('device-unsupported');
    expect(resolveVerdictAvailability(true, status(['resolve_approval_v1']))).toBe('ready');
  });

  it('operatorFeatureFlags: null status ⇒ unverified; truncated ⇒ unverified; explicit ⇒ definite', () => {
    expect(operatorFeatureFlags(null)).toEqual({ canPush: null, canVerdict: null });
    expect(operatorFeatureFlags(status(null))).toEqual({ canPush: null, canVerdict: null });
    expect(operatorFeatureFlags(status(['client_policy_flags_v1']))).toEqual({ canPush: true, canVerdict: false });
    expect(operatorFeatureFlags(status(['client_policy_flags_v1', 'resolve_approval_v1']))).toEqual({ canPush: true, canVerdict: true });
  });
});
