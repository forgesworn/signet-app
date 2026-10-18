import { describe, it, expect, vi } from 'vitest';
import { findOwnSlot, turnOffFullAccess, ownSlotLabel, ownSlotInfo } from './heartwood-owner-ops';
import type { DeviceClientSlot } from './heartwood-mgmt-types';

const ME = 'd'.repeat(64);
function slot(over: Partial<DeviceClientSlot> = {}): DeviceClientSlot {
  return {
    slotIndex: 3, label: 'My Signet', secretFingerprint: 'fp3', autoApprove: true, signingApproved: true,
    strictPermissions: false, currentPubkey: null, authorizedPubkeys: [], allowedKinds: [], allowedMethods: ['heartwood_owner_vault'],
    escalate: false, petitionOnDeny: false, auditChildWrap: false, boundIdentity: null, ...over,
  };
}

describe('findOwnSlot', () => {
  it('matches on authorized keys or the current key, case-insensitively', () => {
    expect(findOwnSlot([slot({ authorizedPubkeys: [ME.toUpperCase()] })], ME)?.slotIndex).toBe(3);
    expect(findOwnSlot([slot({ currentPubkey: ME })], ME)?.slotIndex).toBe(3);
  });
  it('is null for no match, a bad key, or two claimants', () => {
    expect(findOwnSlot([slot()], ME)).toBeNull();
    expect(findOwnSlot([slot({ authorizedPubkeys: [ME] })], 'nope')).toBeNull();
    expect(findOwnSlot([slot({ authorizedPubkeys: [ME] }), slot({ slotIndex: 4, authorizedPubkeys: [ME] })], ME)).toBeNull();
  });
});

describe('turnOffFullAccess', () => {
  it('clears identities on this phone\'s own slot only', async () => {
    const clear = vi.fn().mockResolvedValue(undefined);
    const io = {
      listClients: async () => [slot({ slotIndex: 1, authorizedPubkeys: ['e'.repeat(64)] }), slot({ slotIndex: 3, authorizedPubkeys: [ME] })],
      clearClientIdentities: clear,
    };
    expect(await turnOffFullAccess(io, ME)).toEqual({ ok: true });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith({ slotIndex: 3, secretFingerprint: 'fp3' });
  });
  it('does nothing and points to Sapwood when the slot cannot be found', async () => {
    const clear = vi.fn();
    const out = await turnOffFullAccess({ listClients: async () => [slot()], clearClientIdentities: clear }, ME);
    expect(out.ok).toBe(false);
    expect(clear).not.toHaveBeenCalled();
    if (!out.ok) expect(out.message).toContain('Forget approvals');
  });
  it('a device error is reported, not thrown', async () => {
    const out = await turnOffFullAccess({
      listClients: async () => [slot({ authorizedPubkeys: [ME] })],
      clearClientIdentities: async () => { throw new Error('stale_client_slot'); },
    }, ME);
    expect(out.ok).toBe(false);
  });
});

describe('ownSlotLabel', () => {
  it('returns the label or null', async () => {
    expect(await ownSlotLabel({ listClients: async () => [slot({ authorizedPubkeys: [ME] })] }, ME)).toBe('My Signet');
    expect(await ownSlotLabel({ listClients: async () => { throw new Error('x'); } }, ME)).toBeNull();
  });
});

describe('ownSlotInfo (decision 11)', () => {
  it('returns the label and the methods the device lists for this phone\'s pairing', async () => {
    const info = await ownSlotInfo({ listClients: async () => [slot({ authorizedPubkeys: [ME], allowedMethods: ['sign_event', 'heartwood_derive_persona'] })] }, ME);
    expect(info).toEqual({ label: 'My Signet', allowedMethods: ['sign_event', 'heartwood_derive_persona'] });
  });
  it('is null when the slot is not found or the list fails', async () => {
    expect(await ownSlotInfo({ listClients: async () => [slot()] }, ME)).toBeNull();
    expect(await ownSlotInfo({ listClients: async () => { throw new Error('x'); } }, ME)).toBeNull();
  });
});
