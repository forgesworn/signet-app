/**
 * Push + verdict orchestration over the Heartwood operator channel
 * (family-bunker §11.1.4/9, C3 design §3–§4) — the pure-ish glue between
 * `policy-compiler.ts` (what each family slot's policy should be) and
 * `heartwood-mgmt.ts` (how to tell the device). Kept out of the hooks so it
 * is unit-testable through the injected `PolicyPushIo` seam; the hooks
 * (`usePolicyPush`, App.tsx `handleEscalationVerdict`) only add debounce,
 * state and the real client.
 *
 * Retry policy (design §4): a `stale_management_challenge` (another manager
 * mutated the device between our challenge fetch and our mutation) or a
 * `stale_client_slot` (the slot was re-minted under the same index) means
 * NOTHING was applied — we refresh `list_clients`, recompile, and retry
 * ONCE. The mgmt client itself never auto-retries; the decision lives here.
 */

import type { DependantIdentity } from '../types';
import type { RememberedGrant } from '../types/grants';
import type { DeviceClientSlot, DeviceStatus, SlotPolicyUpdate } from './heartwood-mgmt-types';
import { CAP_CLIENT_POLICY_FLAGS, CAP_RESOLVE_APPROVAL } from './heartwood-mgmt-types';
import {
  hasCapability,
  isStaleChallengeError,
  type VerdictAction,
  type VerdictResult,
} from './heartwood-mgmt';
import { buildCompilerInput, compileSlotPolicies, type CompiledSlot } from './policy-compiler';

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/** The two device operations a push needs — the real one wraps
 *  `listClients` / `updateClientPolicy` over a started `HeartwoodMgmtClient`. */
export interface PolicyPushIo {
  listClients(): Promise<DeviceClientSlot[]>;
  updateClientPolicy(slot: { slotIndex: number; secretFingerprint: string }, policy: SlotPolicyUpdate): Promise<void>;
}

export interface PolicyPushInput {
  dependants: DependantIdentity[];
  /** Live grants INCLUDING tombstones (`listAllGrantsIncludingTombstones`). */
  grants: RememberedGrant[];
  guardianClientPubkey: string | null;
  nowSeconds: number;
}

export interface PolicyPushResult {
  /** Slots whose policy was sent and confirmed. */
  pushed: number;
  /** Family slots the device already had right. */
  unchanged: number;
  /** Non-family slots (consumers, Sapwood, …) — never touched. */
  untouched: number;
  /** One line per slot that failed, plus a fetch failure if `list_clients` itself failed. */
  errors: string[];
  /** Compiler warnings (e.g. guardian pairing not found in inventory). */
  warnings: string[];
}

/** `stale_client_slot: …` — the slot credential changed under us. */
export function isStaleClientSlotError(message: string): boolean {
  return /stale_client_slot/i.test(message);
}

/** Either "nothing applied, refresh and try again" condition (design §4). */
export function isRefreshAndRetryError(message: string): boolean {
  return isStaleChallengeError(message) || isStaleClientSlotError(message);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * One push run: `list_clients` → compile → `update_client` per changed slot,
 * sequentially. On a stale-challenge / stale-slot error the run refreshes
 * the inventory, recompiles, and retries that slot ONCE (by slot index — a
 * re-minted slot that no longer compiles as family is simply dropped).
 * Never throws: every failure lands in `errors`.
 */
export async function runPolicyPush(io: PolicyPushIo, input: PolicyPushInput): Promise<PolicyPushResult> {
  const result: PolicyPushResult = { pushed: 0, unchanged: 0, untouched: 0, errors: [], warnings: [] };

  const compile = async () => {
    const deviceSlots = await io.listClients();
    return compileSlotPolicies(buildCompilerInput({
      dependants: input.dependants,
      grants: input.grants,
      guardianClientPubkey: input.guardianClientPubkey,
      deviceSlots,
      nowSeconds: input.nowSeconds,
    }));
  };

  let compiled;
  try {
    compiled = await compile();
  } catch (e) {
    result.errors.push(`could not read the device's client list: ${errorMessage(e)}`);
    return result;
  }
  result.untouched = compiled.untouched;
  result.warnings = [...compiled.warnings];

  const pushOne = (s: CompiledSlot) => io.updateClientPolicy(
    { slotIndex: s.slotIndex, secretFingerprint: s.secretFingerprint },
    s.policy,
  );

  for (const slot of compiled.slots) {
    if (!slot.changed) { result.unchanged += 1; continue; }
    try {
      await pushOne(slot);
      result.pushed += 1;
      continue;
    } catch (e) {
      const msg = errorMessage(e);
      if (!isRefreshAndRetryError(msg)) {
        result.errors.push(`slot ${slot.slotIndex}: ${msg}`);
        continue;
      }
      // Refresh + recompile + retry once for THIS slot.
      let fresh: CompiledSlot | undefined;
      try {
        const again = await compile();
        fresh = again.slots.find((x) => x.slotIndex === slot.slotIndex);
      } catch (e2) {
        result.errors.push(`slot ${slot.slotIndex}: ${msg}; refresh failed: ${errorMessage(e2)}`);
        continue;
      }
      if (!fresh) {
        // Re-minted / unbound since — no longer ours to manage.
        result.untouched += 1;
        continue;
      }
      if (!fresh.changed) { result.unchanged += 1; continue; }
      try {
        await pushOne(fresh);
        result.pushed += 1;
      } catch (e3) {
        result.errors.push(`slot ${slot.slotIndex}: ${errorMessage(e3)}`);
      }
    }
  }
  return result;
}

/** One-line summary for settings rows / the panel. */
export function describePushResult(r: PolicyPushResult): string {
  const parts: string[] = [];
  parts.push(`${r.pushed} updated`);
  parts.push(`${r.unchanged} already current`);
  if (r.untouched > 0) parts.push(`${r.untouched} not family`);
  if (r.errors.length > 0) parts.push(`${r.errors.length} failed`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/** The subset of `resolveApproval` the verdict leg needs — injectable. */
export interface VerdictIo {
  resolveApproval(params: { park: string; action: VerdictAction; windowSeconds?: number }): Promise<VerdictResult>;
}

/** Only these two are offered from the "Family asks" card. `approve-remember`
 *  is deliberately NOT: a notice carries no origin, and the compiled
 *  interactive policy is already the ceiling — remembering would widen a
 *  slot past what the guardian's rules say. */
export type PanelVerdictAction = Extract<VerdictAction, 'approve-once' | 'deny'>;

/** Default approve-once window (seconds) — mirrors the firmware default. */
export const PANEL_APPROVE_WINDOW_S = 600;

/**
 * Send a verdict for a parked approval, retrying ONCE on a stale management
 * challenge (nothing was applied; the challenge just aged out under another
 * manager's mutation). Any other error propagates.
 */
export async function submitVerdict(
  io: VerdictIo,
  parkId: string,
  action: PanelVerdictAction,
): Promise<VerdictResult> {
  const params = { park: parkId, action, windowSeconds: PANEL_APPROVE_WINDOW_S };
  try {
    return await io.resolveApproval(params);
  } catch (e) {
    if (!isStaleChallengeError(errorMessage(e))) throw e;
    return io.resolveApproval(params);
  }
}

/** Inline outcome copy shown on the card after a verdict lands. */
export function describeVerdictOutcome(action: PanelVerdictAction, result: VerdictResult): string {
  if (action === 'deny') {
    return result.applied === 'none' && result.park === 'expired'
      ? 'Denied — their next try will be refused'
      : 'Denied';
  }
  switch (result.applied) {
    case 'completed':
      return 'Approved — their app got it';
    case 'window':
      return 'Approved — their next try (10 min) will go through';
    case 'policy':
      return 'Approved — rules updated on the device';
    case 'none':
    default:
      return 'Too late — nothing left to approve';
  }
}

export type VerdictAvailability = 'ready' | 'no-operator-key' | 'device-unsupported';

/**
 * Can the panel send verdicts? No credential ⇒ `no-operator-key`; a status
 * that DEFINITELY lacks `resolve_approval_v1` ⇒ `device-unsupported`; a
 * missing/truncated status (capabilities unknown) ⇒ `ready` (the device
 * answers honestly either way — an unsupported method just errors).
 */
export function resolveVerdictAvailability(
  hasCredential: boolean,
  status: DeviceStatus | null,
): VerdictAvailability {
  if (!hasCredential) return 'no-operator-key';
  if (status && hasCapability(status, CAP_RESOLVE_APPROVAL) === false) return 'device-unsupported';
  return 'ready';
}

/** Feature flags derived from a `get_status`: `null` = unverified (treat as
 *  available, surface "unverified" in the UI). */
export function operatorFeatureFlags(status: DeviceStatus | null): { canPush: boolean | null; canVerdict: boolean | null } {
  if (!status) return { canPush: null, canVerdict: null };
  return {
    canPush: hasCapability(status, CAP_CLIENT_POLICY_FLAGS),
    canVerdict: hasCapability(status, CAP_RESOLVE_APPROVAL),
  };
}

export const NEEDS_OPERATOR_KEY_COPY = 'Needs your operator key — Settings → Advanced → Heartwood operator key';
export const DEVICE_UNSUPPORTED_VERDICT_COPY = 'Your Heartwood firmware doesn’t support remote verdicts yet — update it in Sapwood';
