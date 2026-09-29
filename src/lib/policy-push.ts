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
import { buildCompilerInput, compileSlotPolicies, type ChildRuleLike, type CompiledSlot } from './policy-compiler';
import { withOperatorLock } from './operator-lock';

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
  /** Child-direct rules (all dependants, incl. tombstones); absent ⇒ none. */
  childRules?: (ChildRuleLike & { dependantId: string })[];
  /** Approved-once kinds per dependant id (spec §7); absent ⇒ none. */
  approvedOnceKinds?: Record<string, { kind: number; until: number }[]>;
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
      childRules: input.childRules,
      approvedOnceKinds: input.approvedOnceKinds,
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

/**
 * Spec §7: widen ONE child-direct slot's ceiling now, before a verdict is
 * sent. Compiles the whole family as usual but pushes only the slot that
 * matches `target` (index + fingerprint). `'ok'` when the device confirmed
 * (or already had) the compiled policy; `'failed'` when the device could not
 * be reached, refused, or no longer lists that slot. One refresh-and-retry on
 * a stale challenge / stale slot, like `runPolicyPush`. Never throws.
 */
export async function pushChildDirectCeiling(
  io: PolicyPushIo,
  input: PolicyPushInput,
  target: { slotIndex: number; secretFingerprint: string },
): Promise<'ok' | 'failed'> {
  const attempt = async (): Promise<'ok' | 'failed'> => {
    const deviceSlots = await io.listClients();
    const compiled = compileSlotPolicies(buildCompilerInput({
      dependants: input.dependants, grants: input.grants, guardianClientPubkey: input.guardianClientPubkey,
      deviceSlots, nowSeconds: input.nowSeconds, childRules: input.childRules, approvedOnceKinds: input.approvedOnceKinds,
    }));
    const slot = compiled.slots.find(s => s.slotIndex === target.slotIndex
      && s.secretFingerprint.toLowerCase() === target.secretFingerprint.toLowerCase());
    if (!slot) return 'failed';
    if (!slot.changed) return 'ok';
    await io.updateClientPolicy({ slotIndex: slot.slotIndex, secretFingerprint: slot.secretFingerprint }, slot.policy);
    return 'ok';
  };
  try {
    return await attempt();
  } catch (e) {
    if (!isRefreshAndRetryError(errorMessage(e))) return 'failed';
    try { return await attempt(); } catch { return 'failed'; }
  }
}

// ---------------------------------------------------------------------------
// Locked mutation paths (A31, A32)
// ---------------------------------------------------------------------------

export interface OnceEntry { kind: number; until: number }
export type OnceMap = Record<string, OnceEntry[]>;

/** `map` with `e` appended to the dependant's list (dependant id lowercased). */
export function addOnceEntry(map: OnceMap, depId: string, e: OnceEntry): OnceMap {
  const id = depId.toLowerCase();
  const next: OnceMap = {};
  const mine: OnceEntry[] = [];
  for (const [k, v] of Object.entries(map)) { if (k.toLowerCase() === id) mine.push(...v); else next[k] = v; }
  next[id] = [...mine, { kind: e.kind, until: e.until }];
  return next;
}

/** A32: `map` without ONE entry equal to `e` for that dependant — every other entry stays. */
export function removeOnceEntry(map: OnceMap, depId: string, e: OnceEntry): OnceMap {
  const id = depId.toLowerCase();
  const next: OnceMap = {};
  let removed = false;
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() !== id || removed) { next[k] = v; continue; }
    const i = v.findIndex(a => a.kind === e.kind && a.until === e.until);
    if (i < 0) { next[k] = v; continue; }
    removed = true;
    const rest = [...v.slice(0, i), ...v.slice(i + 1)];
    if (rest.length > 0) next[k] = rest;
  }
  return next;
}

/**
 * The caller's approved-once state: `get` reads the CURRENT value (a ref, not
 * a render-time snapshot) and `set` must update what `get` returns before it
 * resolves anything async. `null` while the stored row is still loading.
 */
export interface ApprovedOnceStore {
  get(): OnceMap | null;
  set(next: OnceMap): Promise<void> | void;
}

/** Fresh reads for a push, taken INSIDE the operator lock. */
export interface FreshPushReads {
  dependants: DependantIdentity[];
  grants: RememberedGrant[];
  guardianClientPubkey: string | null;
  childRules: (ChildRuleLike & { dependantId: string })[];
  nowSeconds: number;
}

/**
 * Spec §7 + A31/A32: widen one child-direct slot's ceiling now. The optional
 * `extraOnce` entry is added to the current approved-once state first; then,
 * inside the operator lock, rules / dependant / approved-once are read FRESH
 * and the slot is compiled and pushed. On failure ONLY the entry this call
 * added is removed from the current state — never a restored snapshot, which
 * would drop an entry a concurrent verdict added meanwhile. Never throws.
 */
export async function pushChildCeilingLocked(a: {
  lockKey: object;
  io: PolicyPushIo;
  depId: string;
  extraOnce?: OnceEntry;
  store: ApprovedOnceStore;
  read(): Promise<FreshPushReads>;
}): Promise<'ok' | 'failed'> {
  const id = a.depId.toLowerCase();
  if (a.extraOnce) {
    const cur = a.store.get();
    if (cur === null) return 'failed';
    await a.store.set(addOnceEntry(cur, id, a.extraOnce));
  }
  let result: 'ok' | 'failed' = 'failed';
  try {
    result = await withOperatorLock(a.lockKey, async () => {
      const r = await a.read();
      const dep = r.dependants.find(d => d.id.toLowerCase() === id);
      const cd = dep?.childDevice;
      if (!dep || cd?.mode !== 'heartwood-direct') return 'failed';
      const once = a.store.get();
      if (once === null) return 'failed';
      return pushChildDirectCeiling(a.io, {
        dependants: [dep], grants: r.grants, guardianClientPubkey: r.guardianClientPubkey, nowSeconds: r.nowSeconds,
        childRules: r.childRules, approvedOnceKinds: once,
      }, { slotIndex: cd.slotIndex, secretFingerprint: cd.secretFingerprint });
    });
  } catch { result = 'failed'; }
  if (result !== 'ok' && a.extraOnce) {
    const cur = a.store.get();
    if (cur) { try { await a.store.set(removeOnceEntry(cur, id, a.extraOnce)); } catch { /* memory copy already updated */ } }
  }
  return result;
}

/**
 * A31: the regular family push under the operator lock. `before` (pending
 * revoke retries) runs first, inside the lock; `read` supplies the push input
 * from FRESH reads taken inside the lock, or null when an input is still
 * loading (nothing is pushed). Never throws.
 */
export async function runPolicyPushLocked(a: {
  lockKey: object;
  io: PolicyPushIo;
  before?: () => Promise<unknown>;
  read(): Promise<PolicyPushInput | null>;
}): Promise<PolicyPushResult | null> {
  return withOperatorLock(a.lockKey, async () => {
    if (a.before) { try { await a.before(); } catch { /* retried next run */ } }
    let input: PolicyPushInput | null;
    try { input = await a.read(); } catch (e) {
      return { pushed: 0, unchanged: 0, untouched: 0, warnings: [], errors: [`could not read the family state: ${errorMessage(e)}`] };
    }
    if (!input) return null;
    return runPolicyPush(a.io, input);
  });
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
