import { describe, expect, it, vi } from 'vitest';
import { AWAY_APPROVAL_RISKS, awayApprovalBlocked, ownAppSlots, SAPWOOD_MANAGER_LABEL, setAwayApproval } from './away-approval';
import type { DeviceClientSlot } from './heartwood-mgmt-types';
import type { DependantIdentity } from '../types';

const KID_NP = 'a'.repeat(64);
const KID_PERSONA = 'b'.repeat(64);
const GUARDIAN_CLIENT = 'd'.repeat(64);
const OWNER = '1'.repeat(64);

function slot(overrides: Partial<DeviceClientSlot> = {}): DeviceClientSlot {
  return {
    slotIndex: 1,
    label: 'Primal',
    secretFingerprint: 'f'.repeat(64),
    autoApprove: false,
    signingApproved: true,
    strictPermissions: false,
    currentPubkey: null,
    authorizedPubkeys: [],
    allowedKinds: [],
    allowedMethods: [],
    escalate: false,
    petitionOnDeny: false,
    auditChildWrap: false,
    boundIdentity: null,
    ...overrides,
  };
}

const kid = {
  id: KID_NP,
  guardianPubkey: OWNER,
  displayName: 'Kid',
  naturalPerson: { publicKey: KID_NP, privateKey: '', displayName: 'Kid' },
  persona: { publicKey: KID_PERSONA, privateKey: '', displayName: 'Anon' },
  derivationPath: 'dependant-0',
  createdAt: 0,
  autonomyStage: 'autonomous-alerts',
  primaryKeypair: 'natural-person',
} as DependantIdentity;

describe('ownAppSlots', () => {
  const own = slot({ slotIndex: 1, label: 'Primal' });
  const guardian = slot({ slotIndex: 2, label: 'MySignet', currentPubkey: GUARDIAN_CLIENT, boundIdentity: OWNER });
  const child = slot({ slotIndex: 3, label: 'Kid app', boundIdentity: KID_PERSONA, escalate: true });
  const manager = slot({ slotIndex: 4, label: SAPWOOD_MANAGER_LABEL });

  it('offers only the owner\'s own app pairings', () => {
    const out = ownAppSlots([own, guardian, child, manager], { dependants: [kid], guardianClientPubkey: GUARDIAN_CLIENT }, 0);
    expect(out.map((s) => s.slotIndex)).toEqual([1]);
  });

  it('never offers this app\'s own guardian pairing, which must not hold a request for itself', () => {
    const out = ownAppSlots([guardian], { dependants: [], guardianClientPubkey: GUARDIAN_CLIENT }, 0);
    expect(out).toEqual([]);
  });

  it('never offers a family member\'s pairing, which the policy push owns', () => {
    expect(ownAppSlots([child], { dependants: [kid], guardianClientPubkey: null }, 0)).toEqual([]);
  });

  it('still shows a manager pairing already switched on, so it can be turned off', () => {
    const on = slot({ slotIndex: 4, label: SAPWOOD_MANAGER_LABEL, escalate: true });
    expect(ownAppSlots([on], { dependants: [], guardianClientPubkey: null }, 0)).toEqual([on]);
  });
});

describe('awayApprovalBlocked', () => {
  const ready = { asksInboxOn: true, hasOperatorKey: true, canVerdict: true };

  it('is offered once the phone can see and answer a held request', () => {
    expect(awayApprovalBlocked(ready)).toBeNull();
    expect(awayApprovalBlocked({ ...ready, canVerdict: null })).toBeNull();
  });

  it('names the missing piece', () => {
    expect(awayApprovalBlocked({ ...ready, hasOperatorKey: false })).toMatch(/operator key/);
    expect(awayApprovalBlocked({ ...ready, asksInboxOn: false })).toMatch(/Heartwood connect/);
    expect(awayApprovalBlocked({ ...ready, canVerdict: false })).toMatch(/firmware/);
  });
});

describe('setAwayApproval', () => {
  const target = { slotIndex: 1, secretFingerprint: 'f'.repeat(64) };

  it('writes, reads back, and returns the fresh list', async () => {
    const fresh = [slot({ escalate: true })];
    const io = { updateEscalate: vi.fn(async () => {}), listClients: vi.fn(async () => fresh) };
    await expect(setAwayApproval(io, target, true)).resolves.toBe(fresh);
    expect(io.updateEscalate).toHaveBeenCalledWith(target, true);
  });

  it('refuses when older firmware confirmed the write but left the flag alone', async () => {
    const io = { updateEscalate: vi.fn(async () => {}), listClients: vi.fn(async () => [slot({ escalate: false })]) };
    await expect(setAwayApproval(io, target, true)).rejects.toThrow(/0\.18\.0-beta\.23/);
  });

  it('points a failed turn-off at Sapwood over USB', async () => {
    const io = { updateEscalate: vi.fn(async () => {}), listClients: vi.fn(async () => [slot({ escalate: true })]) };
    await expect(setAwayApproval(io, target, false)).rejects.toThrow(/Sapwood over USB/);
  });

  it('refuses when the pairing was re-minted under the same index', async () => {
    const io = { updateEscalate: vi.fn(async () => {}), listClients: vi.fn(async () => [slot({ escalate: true, secretFingerprint: '0'.repeat(64) })]) };
    await expect(setAwayApproval(io, target, true)).rejects.toThrow();
  });

  it('turns a stale slot refusal into a refresh hint', async () => {
    const io = { updateEscalate: vi.fn(async () => { throw new Error('stale_client_slot: fingerprint mismatch'); }), listClients: vi.fn() };
    await expect(setAwayApproval(io, target, true)).rejects.toThrow(/Refresh/);
    expect(io.listClients).not.toHaveBeenCalled();
  });
});

describe('risk copy', () => {
  it('names the operator key and the 10-minute window', () => {
    const text = AWAY_APPROVAL_RISKS.join(' ');
    expect(text).toMatch(/operator key/);
    expect(text).toMatch(/10 minutes/);
  });
});
