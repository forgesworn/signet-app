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
import { rulesFromLegacyGrants } from './child-rules';
import type { RememberedGrant } from '../types/grants';
import type { ChildRule } from '../types/child-rules';
import type { PendingChildRevoke } from './db';

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
  ours: { label: string; clientPubkey: string; slotIndex?: number; current?: { slotIndex: number; secretFingerprint: string } | null },
): DeviceClientSlot[] {
  return slots.filter(s => s.label === ours.label && !isSameSlot(s, ours.current) && (
    (s.currentPubkey ?? '').toLowerCase() === ours.clientPubkey.toLowerCase()
    || (typeof ours.slotIndex === 'number' && s.slotIndex === ours.slotIndex && !s.currentPubkey)));
}

/** Same slot index AND fingerprint (A23: the dependant's CURRENT phone slot is never cleaned up). */
export function isSameSlot(s: { slotIndex: number; secretFingerprint: string }, other: { slotIndex: number; secretFingerprint: string } | null | undefined): boolean {
  return !!other && s.slotIndex === other.slotIndex && s.secretFingerprint.toLowerCase() === other.secretFingerprint.toLowerCase();
}

/** A23: a client key already on ANY slot (current or authorised) must not be paired again. */
export function clientKeyInUse(slots: DeviceClientSlot[], clientPubkey: string): boolean {
  const c = clientPubkey.toLowerCase();
  return slots.some(s => (s.currentPubkey ?? '').toLowerCase() === c || (s.authorizedPubkeys ?? []).some(p => p.toLowerCase() === c));
}

/** Re-pair: every OTHER slot carrying this dependant's label (the old phone). */
export function supersededSlots(slots: DeviceClientSlot[], label: string, keep: { slotIndex: number; secretFingerprint: string }): DeviceClientSlot[] {
  return slots.filter(s => s.label === label && isChildDirectSlot(s.label)
    && !(s.slotIndex === keep.slotIndex && s.secretFingerprint.toLowerCase() === keep.secretFingerprint.toLowerCase()));
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A38: the firmware's exact "slot index is empty" error (`no such slot: <n>`) — never a bare /not found/. */
export function isNoSuchSlotError(e: unknown): boolean {
  return /^no such slot: \d+$/.test(errText(e));
}
/** A38: the firmware's exact fingerprint-mismatch error; the slot index now holds another credential (or ours moved). */
export function isStaleClientSlotMessage(e: unknown): boolean {
  return errText(e).startsWith('stale_client_slot: slot credential changed');
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
    if (!isNoSuchSlotError(e)) {
      // Stale slot or unknown failure — only treat it as done if the device
      // confirms no slot carries our fingerprint any more (A38).
      const slots = await listClients(operator);
      if (slots.some(s => s.secretFingerprint.toLowerCase() === cd.secretFingerprint.toLowerCase())) throw e;
      return;
    }
  }
}

/**
 * A25: dependants minted while grants were still loading (`seedPending`),
 * with the rules each one should be seeded with now. A dependant that already
 * has any rule row (tombstones included) is not seeded again — only the flag clears.
 */
export function pendingRuleSeeds(
  dependants: DependantIdentity[],
  rules: { dependantId: string }[],
  grants: RememberedGrant[],
  nowMs: number,
): { dep: DependantIdentity; seed: ChildRule[] }[] {
  const out: { dep: DependantIdentity; seed: ChildRule[] }[] = [];
  for (const dep of dependants) {
    if (dep.childDevice?.mode !== 'heartwood-direct' || !dep.childDevice.seedPending) continue;
    const id = dep.id.toLowerCase();
    const has = rules.some(r => r.dependantId.toLowerCase() === id);
    out.push({ dep, seed: has ? [] : rulesFromLegacyGrants(id, grants, nowMs) });
  }
  return out;
}

/** A24: the io a pending-revoke retry needs (db rows + the operator's revoke). */
export interface PendingRevokeIo {
  list(): Promise<PendingChildRevoke[]>;
  revoke(r: PendingChildRevoke): Promise<void>;
  remove(r: PendingChildRevoke): Promise<void>;
  /** A38: confirms a `stale_client_slot` by fingerprint; absent ⇒ a stale record is kept. */
  listClients?(): Promise<DeviceClientSlot[]>;
}

/**
 * A24: retry every remembered revoke. A record is dropped on success or when
 * the device says the slot is gone — the exact `no such slot: <n>`, or a
 * `stale_client_slot` that `list_clients` confirms (no slot carries our
 * fingerprint any more; A38). Anything else stays for the next
 * run. Never throws; returns how many records were cleared.
 */
export async function retryPendingChildRevokes(io: PendingRevokeIo): Promise<number> {
  let cleared = 0;
  let list: PendingChildRevoke[];
  try { list = await io.list(); } catch { return 0; }
  for (const r of list) {
    try {
      await io.revoke(r);
    } catch (e) {
      if (!isNoSuchSlotError(e)) {
        if (!isStaleClientSlotMessage(e) || !io.listClients) continue;
        try {
          const fp = r.secretFingerprint.toLowerCase();
          if ((await io.listClients()).some(s => s.secretFingerprint.toLowerCase() === fp)) continue;
        } catch { continue; }
      }
    }
    try { await io.remove(r); cleared += 1; } catch { /* retried next run */ }
  }
  return cleared;
}

/**
 * A19: dependants the guardian's own NIP-46 server may serve (device and app
 * routes). A phone paired straight to the Heartwood is never phone-served —
 * its `bunkerEndpoint` is the rail key, and a route on it would let that
 * phone's client key sign through this phone's local copy of the keys.
 */
export function phoneServedDependants<T extends Pick<DependantIdentity, 'childDevice'>>(dependants: readonly T[]): T[] {
  return dependants.filter(d => d.childDevice?.mode !== 'heartwood-direct');
}
