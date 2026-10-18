/**
 * Operator-channel half of one-hold pairing (A1b, A9): find this phone's own
 * pairing among the device's slots and, on "Turn off full access", withdraw
 * its approvals. Injectable I/O so it is testable without a device.
 */
import type { DeviceClientSlot } from './heartwood-mgmt-types';
import { FULL_ACCESS_COPY } from './heartwood-one-hold';

/** The slot this phone's NIP-46 client key belongs to, or null. */
export function findOwnSlot(slots: readonly DeviceClientSlot[], clientPubkeyHex: string): DeviceClientSlot | null {
  const me = (clientPubkeyHex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(me)) return null;
  const hits = slots.filter(s =>
    s.authorizedPubkeys.some(k => k.toLowerCase() === me) || (s.currentPubkey ?? '').toLowerCase() === me);
  // Two slots both claiming this key would be ambiguous: do nothing rather than guess.
  return hits.length === 1 ? hits[0] : null;
}

export interface OwnerOpsIo {
  listClients: () => Promise<DeviceClientSlot[]>;
  clearClientIdentities: (slot: { slotIndex: number; secretFingerprint: string }) => Promise<void>;
}

export type TurnOffResult = { ok: true } | { ok: false; message: string };

/**
 * A1b with an operator key: `clear_client_identities` on this phone's own slot.
 * Without an operator key the caller shows `FULL_ACCESS_COPY.sapwoodForget`
 * instead and calls nothing.
 */
export async function turnOffFullAccess(io: OwnerOpsIo, clientPubkeyHex: string): Promise<TurnOffResult> {
  try {
    const slot = findOwnSlot(await io.listClients(), clientPubkeyHex);
    if (!slot) return { ok: false, message: `Couldn't find this phone's pairing on your Heartwood. ${FULL_ACCESS_COPY.sapwoodForget}` };
    await io.clearClientIdentities({ slotIndex: slot.slotIndex, secretFingerprint: slot.secretFingerprint });
    return { ok: true };
  } catch {
    return { ok: false, message: `Couldn't turn off full access from here. ${FULL_ACCESS_COPY.sapwoodForget}` };
  }
}

/** The pairing's label as the device lists it, for A9. */
export async function ownSlotLabel(io: Pick<OwnerOpsIo, 'listClients'>, clientPubkeyHex: string): Promise<string | null> {
  try {
    const slot = findOwnSlot(await io.listClients(), clientPubkeyHex);
    const label = slot?.label.trim();
    return label ? label.slice(0, 40) : null;
  } catch {
    return null;
  }
}
