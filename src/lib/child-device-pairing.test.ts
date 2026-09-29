import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./heartwood-mgmt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./heartwood-mgmt')>();
  return { ...actual, listClients: vi.fn(), revokeClient: vi.fn() };
});

import { listClients, revokeClient, type HeartwoodMgmtClient } from './heartwood-mgmt';
import { buildPersonaFirstDependant } from './dependant-record';
import { mergeDependantWithLocal } from './dependants-sync';
import {
  childDirectPersona, replyPersonas, revokeChildDeviceSlot, unconfirmedMintSlots, usesChildDirectPairing,
} from './child-device-pairing';
import type { DeviceClientSlot } from './heartwood-mgmt-types';
import type { DependantIdentity } from '../types';

const mList = vi.mocked(listClients), mRevoke = vi.mocked(revokeClient);
const op = {} as HeartwoodMgmtClient;
const NP = 'a'.repeat(64), PERSONA = 'b'.repeat(64), EXTRA = 'c'.repeat(64);

function dep(over: Partial<DependantIdentity> = {}): DependantIdentity {
  return { ...buildPersonaFirstDependant({ guardianPubkey: 'f'.repeat(64), enteredName: 'Lily', derivationPath: 'dependant-2',
    naturalPerson: { publicKey: NP, privateKey: '' }, persona: { publicKey: PERSONA, privateKey: '' }, createdAt: 1 }), ...over };
}
const paired = (): DependantIdentity => dep({ childDevice: { mode: 'heartwood-direct', slotLabel: 'signet:child-device:v2:x', secretFingerprint: 'ab',
  slotIndex: 6, clientPubkey: 'd'.repeat(64), boundPersona: PERSONA, pairedAt: 1 } });
function slot(over: Partial<DeviceClientSlot>): DeviceClientSlot {
  return { slotIndex: 0, label: '', secretFingerprint: 'x', autoApprove: true, signingApproved: true, strictPermissions: true, currentPubkey: null,
    authorizedPubkeys: [], allowedKinds: [], allowedMethods: [], escalate: false, petitionOnDeny: false, auditChildWrap: false, boundIdentity: null, ...over };
}

beforeEach(() => { mList.mockReset(); mRevoke.mockReset(); });

describe('child-device-pairing', () => {
  it('only a tree-derived dependant of a bunker-mode guardian takes the direct flow', () => {
    expect(usesChildDirectPairing(dep(), 'bunker')).toBe(true);
    expect(usesChildDirectPairing(dep(), 'local')).toBe(false);
    expect(usesChildDirectPairing(dep({ derivationPath: 'imported' }), 'bunker')).toBe(false);
  });

  it('binds the persona, never a dormant natural person', () => {
    expect(childDirectPersona(dep())).toBe(PERSONA);
    expect(childDirectPersona(dep({ primaryKeypair: 'natural-person' }))).toBe(PERSONA);
    expect(childDirectPersona(dep({ persona: { ...dep().persona, publicKey: '' } }))).toBeNull();
  });

  it('reply personas skip a dormant NP and extras hidden from the paired device', () => {
    const d = dep({ extraPersonas: [{ publicKey: EXTRA, privateKey: '', displayName: 'Gamer' } as never,
      { publicKey: 'e'.repeat(64), privateKey: '', displayName: 'Hidden' } as never], hiddenOnPairedDeviceKeys: ['e'.repeat(64)] });
    expect(replyPersonas(d).map(p => [p.pubkey, p.role])).toEqual([[PERSONA, 'persona'], [EXTRA, 'extra']]);
  });

  it('A4 reconcile targets only our label + this client, never the old phone', () => {
    const L = 'signet:child-device:v2:0123456789abcdef';
    const ours = slot({ slotIndex: 3, label: L, currentPubkey: 'd'.repeat(64) });
    const old = slot({ slotIndex: 2, label: L, currentPubkey: 'a'.repeat(64) });
    const other = slot({ slotIndex: 4, label: 'MySignet', currentPubkey: 'd'.repeat(64) });
    expect(unconfirmedMintSlots([ours, old, other], { label: L, clientPubkey: 'd'.repeat(64) })).toEqual([ours]);
  });

  describe('revokeChildDeviceSlot (unpair / dependant removal, A9)', () => {
    it('revokes the recorded slot', async () => {
      mRevoke.mockResolvedValue(undefined);
      await revokeChildDeviceSlot(op, paired());
      expect(mRevoke).toHaveBeenCalledWith(op, { slotIndex: 6, secretFingerprint: 'ab' });
    });
    it('a slot already gone counts as revoked', async () => {
      mRevoke.mockRejectedValue(new Error('stale_client_slot'));
      await expect(revokeChildDeviceSlot(op, paired())).resolves.toBeUndefined();
    });
    it('an unknown failure with the slot still listed throws', async () => {
      mRevoke.mockRejectedValue(new Error('device busy'));
      mList.mockResolvedValue([slot({ slotIndex: 6, secretFingerprint: 'ab' })]);
      await expect(revokeChildDeviceSlot(op, paired())).rejects.toThrow('device busy');
    });
    it('no childDevice → nothing to do', async () => {
      await revokeChildDeviceSlot(op, dep());
      expect(mRevoke).not.toHaveBeenCalled();
    });
  });

  it('the dependants sync merge keeps the device-local childDevice', () => {
    const local = paired();
    const remote = { ...dep(), childDevice: undefined };
    expect(mergeDependantWithLocal(remote, local).childDevice).toEqual(local.childDevice);
  });
});
