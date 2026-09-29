/**
 * Guardian side of the child-direct Heartwood pairing (spec §4, §9.4) — the
 * pure decisions `useChildDevicePairing` is built from: which dependants take
 * this flow, which persona the slot binds, what the reply lists, how a minted
 * slot is verified (A9), which slots a failed mint must clean up (A4), and the
 * best-effort revoke run when a dependant is removed.
 */
import type { DependantIdentity } from '../types';
import type { DeviceClientSlot, DeviceStatus, SlotPolicyUpdate } from './heartwood-mgmt-types';
import type { ChildPairReply } from './child-pair-wire';
import { CAP_NOSTRCONNECT_V2, hasCapability, listClients, revokeClient, type HeartwoodMgmtClient } from './heartwood-mgmt';
import { resolveDependantCardSlot } from './carousel-utils';
import { isDependantNaturalPersonActive } from './identity-display';
import { isChildDirectSlot } from './policy-compiler';

/** Firmware MAX_CONNECT_SLOTS. */
export const MAX_CONNECT_SLOTS = 16;

const HEX64 = /^[0-9a-f]{64}$/;
const TREE_PATH_RE = /^dependant-\d+$/;

/** Spec §4 "Unchanged": only a tree-derived dependant of a guardian on a
 *  Heartwood takes the direct flow; everyone else keeps the phone-served QR. */
export function usesChildDirectPairing(dep: DependantIdentity, signingMode: string | undefined): boolean {
  return signingMode === 'bunker' && TREE_PATH_RE.test(dep.derivationPath ?? '');
}

/** The default persona the slot binds to; never a dormant natural person. */
export function childDirectPersona(dep: DependantIdentity): string | null {
  const card = resolveDependantCardSlot(dep);
  const pub = (card.slot.publicKey ?? '').toLowerCase();
  if (!HEX64.test(pub)) return null;
  if (card.slotTarget === 'natural-person' && !isDependantNaturalPersonActive(dep)) return null;
  return pub;
}

export type PairBlockReason = 'no-operator-key' | 'device-unsupported' | 'slots-full' | 'no-persona' | 'offline';

/** Preconditions that need no device round trip. */
export function staticPairBlock(args: {
  dependant: DependantIdentity;
  hasOperator: boolean;
  status: DeviceStatus | null;
}): PairBlockReason | null {
  if (!args.hasOperator) return 'no-operator-key';
  if (!args.status) return 'offline';
  if (hasCapability(args.status, CAP_NOSTRCONNECT_V2) === false) return 'device-unsupported';
  if (!childDirectPersona(args.dependant)) return 'no-persona';
  return null;
}

/** Personas the child's phone may act as (reply `personas`, spec §4 step 4). */
export function replyPersonas(dep: DependantIdentity): ChildPairReply['personas'] {
  const hidden = new Set((dep.hiddenOnPairedDeviceKeys ?? []).map(k => k.toLowerCase()));
  const out: ChildPairReply['personas'] = [];
  const seen = new Set<string>();
  const add = (pubkey: string | undefined, name: string, role: ChildPairReply['personas'][number]['role']) => {
    const p = (pubkey ?? '').toLowerCase();
    if (!HEX64.test(p) || seen.has(p) || out.length >= 32) return;
    seen.add(p);
    out.push({ pubkey: p, name: name || dep.displayName, role });
  };
  add(dep.persona?.publicKey, dep.persona?.displayName ?? '', 'persona');
  if (isDependantNaturalPersonActive(dep)) add(dep.naturalPerson?.publicKey, dep.naturalPerson?.displayName ?? '', 'natural-person');
  for (const ep of dep.extraPersonas ?? []) {
    if (hidden.has((ep.publicKey ?? '').toLowerCase())) continue;
    add(ep.publicKey, ep.displayName ?? '', 'extra');
  }
  return out;
}

/** A9: the minted slot as the device now lists it, or null if it does not
 *  match every property we asked for. */
export function verifyMintedSlot(
  slots: DeviceClientSlot[],
  expect: { slotIndex: number; secretFingerprint: string; label: string; persona: string; clientPubkey: string; policy: SlotPolicyUpdate },
): DeviceClientSlot | null {
  const s = slots.find(x => x.slotIndex === expect.slotIndex && x.secretFingerprint.toLowerCase() === expect.secretFingerprint.toLowerCase());
  if (!s) return null;
  const sameSet = (a: readonly (string | number)[], b: readonly (string | number)[]) => {
    const x = new Set(a), y = new Set(b);
    return x.size === y.size && [...x].every(v => y.has(v));
  };
  if (s.label !== expect.label) return null;
  if ((s.boundIdentity ?? '') !== expect.persona.toLowerCase()) return null;
  if ((s.currentPubkey ?? '').toLowerCase() !== expect.clientPubkey.toLowerCase()) return null;
  if (s.autoApprove !== expect.policy.autoApprove || s.escalate !== expect.policy.escalate
    || s.petitionOnDeny !== expect.policy.petitionOnDeny) return null;
  if (!sameSet(s.allowedMethods, expect.policy.allowedMethods) || !sameSet(s.allowedKinds, expect.policy.allowedKinds)) return null;
  return s;
}

/** A4: after a mint error or timeout, the slots that are ours (label + this
 *  child's client key, or the index the error named under our label) but that
 *  we never confirmed. The previous phone's slot (other client key) is not ours. */
export function unconfirmedMintSlots(
  slots: DeviceClientSlot[],
  ours: { label: string; clientPubkey: string; slotIndex?: number },
): DeviceClientSlot[] {
  return slots.filter(s => s.label === ours.label && (
    (s.currentPubkey ?? '').toLowerCase() === ours.clientPubkey.toLowerCase()
    || (typeof ours.slotIndex === 'number' && s.slotIndex === ours.slotIndex && !s.currentPubkey)));
}

/** Re-pair: every OTHER slot carrying this dependant's label (the old phone). */
export function supersededSlots(slots: DeviceClientSlot[], label: string, keep: { slotIndex: number; secretFingerprint: string }): DeviceClientSlot[] {
  return slots.filter(s => s.label === label && isChildDirectSlot(s.label)
    && !(s.slotIndex === keep.slotIndex && s.secretFingerprint.toLowerCase() === keep.secretFingerprint.toLowerCase()));
}

function isGoneSlotError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /stale_client_slot|no such slot|not found/i.test(m);
}

/**
 * Hard-revoke the child's phone slot (§9.4 "The whole phone"). Resolves when
 * the slot is gone — revoked now, or already absent from `list_clients`.
 * Throws when the device could not be reached or refused.
 */
export async function revokeChildDeviceSlot(operator: HeartwoodMgmtClient, dep: Pick<DependantIdentity, 'childDevice'>): Promise<void> {
  const cd = dep.childDevice;
  if (!cd) return;
  try {
    await revokeClient(operator, { slotIndex: cd.slotIndex, secretFingerprint: cd.secretFingerprint });
    return;
  } catch (e) {
    if (!isGoneSlotError(e)) {
      // Unknown failure — only treat it as done if the device confirms the slot is gone.
      const slots = await listClients(operator);
      if (slots.some(s => s.secretFingerprint.toLowerCase() === cd.secretFingerprint.toLowerCase())) throw e;
      return;
    }
  }
}
