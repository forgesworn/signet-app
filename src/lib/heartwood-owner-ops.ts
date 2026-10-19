/**
 * Operator-channel half of one-hold pairing (A1b, A9): find this phone's own
 * pairing among the device's slots and, on "Turn off full access", withdraw
 * its approvals. Injectable I/O so it is testable without a device.
 */
import type { DeviceClientSlot } from './heartwood-mgmt-types';
import { FULL_ACCESS_COPY, type OwnerStatus } from './heartwood-one-hold';

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
  /** `clientPubkey` makes the clear per-client: only this phone's key loses its approvals. */
  clearClientIdentities: (slot: { slotIndex: number; secretFingerprint: string }, clientPubkey?: string) => Promise<void>;
  /** A fresh `heartwood_owner_status` read over the phone's own pairing; `null` = no usable answer. */
  readOwnerStatus: () => Promise<OwnerStatus | null>;
}

export type TurnOffResult = { ok: true } | { ok: false; message: string; status?: OwnerStatus | null };

/**
 * A1b with an operator key: `clear_client_identities` for this phone's key on
 * its own slot, then a re-read of `heartwood_owner_status`. "Off" is reported
 * only when that re-read says `owner:false`; anything else is a plain error
 * and the status line keeps saying "on". Without an operator key the caller
 * shows `FULL_ACCESS_COPY.sapwoodForget` instead and calls nothing.
 *
 * The clear names this phone's client key (`client_pubkey`), so a second
 * device bound to the slot since the status was read keeps its own approvals.
 */
export async function turnOffFullAccess(io: OwnerOpsIo, clientPubkeyHex: string): Promise<TurnOffResult> {
  const me = (clientPubkeyHex || '').trim().toLowerCase();
  try {
    const slot = findOwnSlot(await io.listClients(), clientPubkeyHex);
    if (!slot) return { ok: false, message: `Couldn't find this phone's pairing on your Heartwood. ${FULL_ACCESS_COPY.sapwoodForget}` };
    const ref = { slotIndex: slot.slotIndex, secretFingerprint: slot.secretFingerprint };
    try {
      await io.clearClientIdentities(ref, me);
    } catch (err) {
      // A slot without per-client records cannot take a per-client clear. When
      // this phone's key is the only one on the slot the whole-slot clear is
      // the same thing; with any other key present nothing is sent.
      const msg = err instanceof Error ? err.message : String(err ?? '');
      const only = slot.authorizedPubkeys.every(k => k.toLowerCase() === me) && slot.authorizedPubkeys.length > 0;
      if (!(/unknown client credential/i.test(msg) && only)) throw err;
      await io.clearClientIdentities(ref);
    }
  } catch {
    return { ok: false, message: `Couldn't turn off full access from here. ${FULL_ACCESS_COPY.sapwoodForget}` };
  }
  const status = await io.readOwnerStatus();
  if (status && !status.owner) return { ok: true };
  return { ok: false, message: FULL_ACCESS_COPY.turnOffUnconfirmed, status };
}

/** What the device lists for this phone's own pairing: its label (A9) and its allowed methods (decision 11). */
export interface OwnSlotInfo {
  label: string | null;
  allowedMethods: string[];
}

export async function ownSlotInfo(io: Pick<OwnerOpsIo, 'listClients'>, clientPubkeyHex: string): Promise<OwnSlotInfo | null> {
  try {
    const slot = findOwnSlot(await io.listClients(), clientPubkeyHex);
    if (!slot) return null;
    const label = slot.label.trim();
    return { label: label ? label.slice(0, 40) : null, allowedMethods: [...slot.allowedMethods] };
  } catch {
    return null;
  }
}

/** The pairing's label as the device lists it, for A9. */
export async function ownSlotLabel(io: Pick<OwnerOpsIo, 'listClients'>, clientPubkeyHex: string): Promise<string | null> {
  return (await ownSlotInfo(io, clientPubkeyHex))?.label ?? null;
}
