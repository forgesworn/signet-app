import { describe, it, expect, vi } from 'vitest';
import { findOwnSlot, turnOffFullAccess, ownSlotLabel, ownSlotInfo } from './heartwood-owner-ops';
import type { DeviceClientSlot } from './heartwood-mgmt-types';
import { FULL_ACCESS_COPY } from './heartwood-one-hold';

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
  const off = async () => ({ owner: false, style: 'everyday' as const });
  it('clears this phone\'s key on its own slot only, then re-reads the status (review 1)', async () => {
    const clear = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn(off);
    const io = {
      listClients: async () => [slot({ slotIndex: 1, authorizedPubkeys: ['e'.repeat(64)] }), slot({ slotIndex: 3, authorizedPubkeys: [ME, 'f'.repeat(64)] })],
      clearClientIdentities: clear,
      readOwnerStatus: read,
    };
    expect(await turnOffFullAccess(io, ME.toUpperCase())).toEqual({ ok: true });
    expect(clear).toHaveBeenCalledTimes(1);
    // The phone's own client key goes with it, lowercased: a second device on the slot keeps its approvals.
    expect(clear).toHaveBeenCalledWith({ slotIndex: 3, secretFingerprint: 'fp3' }, ME);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('reports "off" only when the re-read says owner:false', async () => {
    const mk = (readOwnerStatus: () => Promise<{ owner: boolean; style: 'everyday' | 'careful' | 'custom' } | null>) => ({
      listClients: async () => [slot({ authorizedPubkeys: [ME] })],
      clearClientIdentities: vi.fn().mockResolvedValue(undefined),
      readOwnerStatus,
    });
    // The device still says owner: plain error, and the answer is handed back so the line stays on.
    const still = await turnOffFullAccess(mk(async () => ({ owner: true, style: 'careful' })), ME);
    expect(still).toMatchObject({ ok: false, message: FULL_ACCESS_COPY.turnOffUnconfirmed, status: { owner: true, style: 'careful' } });
    // No usable answer is not "off" either.
    const none = await turnOffFullAccess(mk(async () => null), ME);
    expect(none).toMatchObject({ ok: false, status: null });
  });
  it('does nothing and points to Sapwood when the slot cannot be found', async () => {
    const clear = vi.fn();
    const read = vi.fn();
    const out = await turnOffFullAccess({ listClients: async () => [slot()], clearClientIdentities: clear, readOwnerStatus: read }, ME);
    expect(out.ok).toBe(false);
    expect(clear).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    if (!out.ok) expect(out.message).toContain('Withdraw all for this client');
  });
  it('a device error is reported, not thrown, and nothing is read back', async () => {
    const read = vi.fn(off);
    const out = await turnOffFullAccess({
      listClients: async () => [slot({ authorizedPubkeys: [ME] })],
      clearClientIdentities: async () => { throw new Error('stale_client_slot'); },
      readOwnerStatus: read,
    }, ME);
    expect(out.ok).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
  it('a slot with no per-client records falls back to the whole-slot clear only when this key is the only one on it', async () => {
    const unknown = () => { throw new Error('unknown client credential'); };
    const sole = vi.fn().mockImplementationOnce(unknown).mockResolvedValue(undefined);
    const okSole = await turnOffFullAccess({ listClients: async () => [slot({ authorizedPubkeys: [ME] })], clearClientIdentities: sole, readOwnerStatus: off }, ME);
    expect(okSole).toEqual({ ok: true });
    expect(sole.mock.calls.map(c => c[1])).toEqual([ME, undefined]);

    const shared = vi.fn().mockImplementation(unknown);
    const bad = await turnOffFullAccess({ listClients: async () => [slot({ authorizedPubkeys: [ME, 'f'.repeat(64)] })], clearClientIdentities: shared, readOwnerStatus: off }, ME);
    expect(bad.ok).toBe(false);
    expect(shared).toHaveBeenCalledTimes(1);
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
