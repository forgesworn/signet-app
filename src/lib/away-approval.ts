/**
 * Approve from my phone, for the owner's own apps (the slot's `escalate`
 * flag). A request from that app that would draw the approval card on the
 * Heartwood is held instead (up to 10 minutes), a notice comes to this phone,
 * and the owner answers it from the Bunker panel with the operator key. Off by
 * default; Sapwood offers the same switch per app.
 *
 * Only the owner's own pairings are offered. The policy compiler owns every
 * family pairing (a dependant's, and this app's own guardian pairing, which
 * must never hold a request for itself), so a pairing it compiles is never
 * listed here: its next push would undo the change anyway.
 */
import { buildCompilerInput, compileSlotPolicies } from './policy-compiler';
import type { DeviceClientSlot } from './heartwood-mgmt-types';
import type { DependantIdentity } from '../types';

/** Sapwood's own persona-management pairing (its `MANAGER_SLOT_LABEL`). */
export const SAPWOOD_MANAGER_LABEL = 'Sapwood manager';

/**
 * The owner's own app pairings: what the compiler leaves untouched, less
 * Sapwood's manager pairing (bookkeeping, only used beside the signer). A
 * manager pairing already switched on still shows, so it can be turned off.
 */
export function ownAppSlots(
  deviceSlots: readonly DeviceClientSlot[],
  family: { dependants: DependantIdentity[]; guardianClientPubkey: string | null },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): DeviceClientSlot[] {
  const compiled = compileSlotPolicies(buildCompilerInput({
    dependants: family.dependants,
    grants: [],
    guardianClientPubkey: family.guardianClientPubkey,
    deviceSlots: [...deviceSlots],
    nowSeconds,
  }));
  const managed = new Set(compiled.slots.map((s) => s.slotIndex));
  return deviceSlots.filter((s) => !managed.has(s.slotIndex) && (s.label !== SAPWOOD_MANAGER_LABEL || s.escalate));
}

/**
 * Why the switch cannot be offered on this phone, or null when it can. Unlike
 * Sapwood, Signet is the phone, so it checks rather than asks: a held request
 * is only seen here once Signet is paired by Heartwood connect (the asks
 * inbox), and only answered with the operator key on a device that takes
 * verdicts.
 */
export function awayApprovalBlocked(input: {
  asksInboxOn: boolean;
  hasOperatorKey: boolean;
  canVerdict: boolean | null;
}): string | null {
  if (!input.hasOperatorKey) return 'Import the Heartwood operator key above first: it is what answers a held request.';
  if (!input.asksInboxOn) return 'Connect this phone to your Heartwood as your signer (Heartwood connect) and unlock it, so held requests reach it.';
  if (input.canVerdict === false) return 'Your Heartwood firmware cannot take an answer from the phone yet. Update it in Sapwood.';
  return null;
}

/** The risk the owner accepts by turning it on. Same three points as Sapwood. */
export const AWAY_APPROVAL_RISKS: readonly string[] = [
  'Whoever holds this phone\'s operator key can approve signatures for this app without touching the Heartwood.',
  'Approving once also lets this app sign the same kind of event again for up to 10 minutes without asking.',
  'Requests that must be approved at the Heartwood (wallet pairing, rendezvous keys, login codes) still need its button.',
];

export interface AwayApprovalIo {
  listClients: () => Promise<DeviceClientSlot[]>;
  updateEscalate: (slot: { slotIndex: number; secretFingerprint: string }, on: boolean) => Promise<void>;
}

/**
 * Turn the switch on or off for one pairing, then read the slot back: the
 * device confirming the write is not enough, since firmware before
 * 0.18.0-beta.23 accepts `escalate` on a legacy pairing and ignores it.
 * Returns the fresh client list. The caller holds the operator lock.
 */
export async function setAwayApproval(
  io: AwayApprovalIo,
  slot: { slotIndex: number; secretFingerprint: string },
  on: boolean,
): Promise<DeviceClientSlot[]> {
  try {
    await io.updateEscalate(slot, on);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/stale_client_slot/i.test(msg)) throw new Error('This app was paired again since the list loaded. Refresh and try again.');
    throw e;
  }
  const fresh = await io.listClients();
  const after = fresh.find((s) => s.slotIndex === slot.slotIndex && s.secretFingerprint === slot.secretFingerprint);
  if (!after || after.escalate !== on) {
    throw new Error(on
      ? 'Your Heartwood did not turn this on. Its firmware may be too old: update it in Sapwood (0.18.0-beta.23 or later).'
      : 'Your Heartwood did not turn this off. Its firmware may be too old to change it from the phone: turn it off in Sapwood over USB.');
  }
  return fresh;
}
