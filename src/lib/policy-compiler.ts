/**
 * C3 policy compiler (family-bunker §11.1.4 / §9) — pure.
 *
 * Turns the guardian's family state (dependant autonomy stages, remembered
 * grants, schedules, audit visibility, petition opt-ins) plus the device's
 * live `list_clients` inventory into one replace-whole-slot policy per
 * FAMILY slot on the Heartwood. The push layer (`update_client` over the
 * kind-24134 operator channel) sends only the slots marked `changed`.
 *
 * Normative design: the internal C3-compiler-output-rule doc,
 * §3.0–§3.4. The stage table there is restated inline below; every branch
 * is a deliberate fail-closed choice against the firmware's STRICT
 * (v2 exact) slot semantics (§3.0):
 *
 *   - unlisted method ⇒ hard deny (never interactive)
 *   - `sign_event` listed + kind outside a NON-EMPTY `allowedKinds` ⇒ hard deny
 *   - kind inside (or empty list = all kinds) ⇒ `autoApprove ? auto : button`
 *   - button + `escalate` ⇒ park + C4 notice; so ONLY `autoApprove: false`
 *     slots can ever reach the guardian's escalation console
 *     (`expectedToEscalate`).
 *
 * The device has no trusted time, so anything schedule-gated cannot live in
 * a compiled ceiling (§2): a per-origin scheduled allow-grant EXCLUDES its
 * scope's kinds at autonomous stages (auto-denied phone-off, petition if
 * opted in), and a dep-level `defaultSchedule` flips the whole slot to
 * interactive (`autoApprove: false`, kinds `[]`) so the guardian can still
 * approve-once inside the window instead of the device hard-denying
 * everything.
 *
 * No db, no hooks, no IO — `buildCompilerInput` at the bottom is the only
 * bridge from app records to `CompilerInput`, kept here so it is unit-tested
 * alongside the compiler (hooks have no RTL harness).
 */

import { kindFromScope } from './child-rules';
import type { AutonomyStage, DependantIdentity } from '../types';
import type { RememberedGrant } from '../types/grants';
import type { DeviceClientSlot, SlotPolicyUpdate } from './heartwood-mgmt-types';
import { TOFU_SAFE_METHODS } from './heartwood-mgmt-types';
import { resolveAuditVisibility } from './audit-visibility';
import { isDependantNaturalPersonActive } from './identity-display';
import { resolvePolicy } from './autonomy-gate';
import type { Scope } from './scope-inference';

/**
 * The policy for a slot bound to an identity the app will not act as
 * (spec §7.6 — a dependant's dormant real identity).
 *
 * Fully locked in the firmware's STRICT v2 terms documented at the top of this
 * file: no listed method, so EVERY request is a hard deny; `escalate: false`, so
 * a denial never parks and never raises a C4 "family asks" card; no petition, no
 * child audit wrap. The slot keeps its binding — the compiler never re-binds —
 * it just cannot be used until the guardian runs the activation ceremony, after
 * which the ordinary stage table applies on the next push.
 */
export const LOCKED_SLOT_POLICY: Readonly<Omit<SlotPolicyUpdate, 'boundIdentity'>> = Object.freeze({
  allowedMethods: [] as string[],
  allowedKinds: [] as number[],
  autoApprove: false,
  escalate: false,
  petitionOnDeny: false,
  auditChildWrap: false,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompilerGrant {
  /** Scope name from `scope-inference.ts`'s `Scope` union (string-typed
   *  because grants persist as strings and may carry future scopes). */
  scope: string;
  decision: 'allow' | 'deny';
  /** Per-origin schedule clause present. */
  hasSchedule: boolean;
  /** Soft-deleted (`tombstonedAt` set) — treated as absent. */
  tombstoned: boolean;
  /** `expiresAt` in the past — treated as absent. */
  expired: boolean;
}

export interface CompilerDependant {
  /** Dep NP pubkey (the roster id). */
  id: string;
  /** NP + default persona + extras, lowercase hex. */
  identityPubkeys: string[];
  /**
   * Lowercase pubkeys of this dependant's DORMANT slots — today, the real
   * identity while `naturalPersonActive` is false. A device slot bound to one
   * compiles to `LOCKED_SLOT_POLICY` regardless of stage or grants.
   */
  dormantIdentityPubkeys: string[];
  autonomyStage: AutonomyStage;
  /** Dep-level Charter `defaultSchedule` present ⇒ interactive override. */
  hasDefaultSchedule: boolean;
  /** `resolveAuditVisibility(stage, override) === true` — caller resolves. */
  auditVisible: boolean;
  /** Guardian opt-in: excluded/denied requests raise a petition. */
  petitionOnDeny: boolean;
  grants: CompilerGrant[];
  /** `defaultSchedule.paused === true` — only consulted by the child-direct branch. */
  defaultSchedulePaused?: boolean;
  /** Child-direct only: this dependant's ChildRules (absent ⇒ none). */
  childRules?: ChildRuleLike[];
  /** Child-direct only: kinds approved once, `until` in unix seconds. */
  approvedOnceKinds?: { kind: number; until: number }[];
}

export interface CompilerInput {
  dependants: CompilerDependant[];
  /** The app's own NIP-46 client pubkey (from the stored `bunkerSecret`),
   *  or null when the app has no primary pairing to recognise. */
  guardianClientPubkey: string | null;
  /** Live `list_clients` inventory (Task 2 `listClients`). */
  deviceSlots: DeviceClientSlot[];
  /** Unix seconds for child-direct expiry checks; defaults to the wall clock. */
  nowSeconds?: number;
}

export interface CompiledSlot {
  slotIndex: number;
  /** Echoed so the push layer can send `expected_secret_fingerprint`. */
  secretFingerprint: string;
  policy: SlotPolicyUpdate;
  reason: 'dependant' | 'guardian';
  dependantId?: string;
  /** False when the device already lists exactly this policy — push skips it. */
  changed: boolean;
}

export interface CompileResult {
  slots: CompiledSlot[];
  /** Slots that are neither the guardian's nor bound to a family identity. */
  untouched: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Constants (exported for tests / UI)
// ---------------------------------------------------------------------------

/**
 * Scope → Nostr kinds the device may auto-approve for that scope. `pair-device`
 * (24133, ask-every) and 31000 (the device cannot read the `type` tag) are
 * deliberately NOT here — they must never enter a compiled ceiling.
 */
export const SCOPE_KINDS: Readonly<Record<string, readonly number[]>> = Object.freeze({
  'sign-in': [21236],
  'venue-entry': [21235],
  'post-public': [1],
  'react-zap-reply': [1, 7, 9734],
  'dm-private': [4, 13, 1059],
  'upload-photo': [24242],
  'mutate-identity': [0],
});

/** Every kind any scope maps to, sorted ascending, deduped. */
export const ALL_SCOPE_KINDS: readonly number[] = Object.freeze(
  sortedUniqueKinds(Object.values(SCOPE_KINDS).flat()),
);

/** Kinds that must never appear in a compiled `allowedKinds`. */
export const NEVER_LISTED_KINDS: readonly number[] = Object.freeze([24133, 31000]);

/** Interactive stages: `get_public_key` + `sign_event` only. */
export const INTERACTIVE_STAGE_METHODS: readonly string[] = Object.freeze([
  'get_public_key',
  'sign_event',
]);

/** Autonomous stages add silent crypto. */
export const AUTONOMOUS_STAGE_METHODS: readonly string[] = Object.freeze([
  'get_public_key',
  'sign_event',
  'nip44_encrypt',
  'nip44_decrypt',
]);

/** Methods the guardian's own slot must always list (§3.3). */
export const GUARDIAN_REQUIRED_METHODS: readonly string[] = Object.freeze([
  'sign_event',
  'get_public_key',
  'nip44_encrypt',
  'nip44_decrypt',
]);

/** Label the paired-child MySignet install connects with (`default`-labelled
 *  slots inherit the client's metadata name). */
export const CHILD_DEVICE_LABEL = 'MySignet';
/** The app's own remote-mint label prefix for a child's device slot (D2 route 2). */
export const CHILD_DEVICE_LABEL_PREFIX = 'signet:child-device:';

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function sortedUniqueKinds(kinds: readonly number[]): number[] {
  return Array.from(new Set(kinds)).sort((a, b) => a - b);
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

function sameSortedKinds(a: readonly number[], b: readonly number[]): boolean {
  const sa = sortedUniqueKinds(a);
  const sb = sortedUniqueKinds(b);
  if (sa.length !== sb.length) return false;
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

function lower(s: string | null | undefined): string {
  return (s ?? '').toLowerCase();
}

/**
 * The child's OWN device slot (vs a guardian-installed app pairing acting as
 * the dep) is recognised by label — post-D2 the app never knows the child's
 * client pubkey up front (§3.2).
 */
export function isChildDeviceSlot(slot: Pick<DeviceClientSlot, 'label'>): boolean {
  const label = slot.label ?? '';
  return label === CHILD_DEVICE_LABEL || label.startsWith(CHILD_DEVICE_LABEL_PREFIX);
}

/**
 * §3.0 reachability rule: only a slot the device must BUTTON on
 * (`autoApprove: false`) with `escalate` set can ever park a request and
 * raise a C4 card. Anything else the slot doesn't allow is a hard deny.
 */
export function expectedToEscalate(
  policy: Pick<SlotPolicyUpdate, 'autoApprove' | 'escalate'>,
): boolean {
  return !policy.autoApprove && policy.escalate;
}

function isAutonomousStage(stage: AutonomyStage): boolean {
  return (
    stage === 'autonomous-alerts' ||
    stage === 'autonomous-logging' ||
    stage === 'full-autonomy'
  );
}

/**
 * Scopes whose kinds must be dropped from an autonomous ceiling (§2 + §3.1):
 * any ACTIVE grant (not tombstoned, not expired) that is a deny, or an allow
 * carrying a per-origin schedule. The device is origin-blind, so a single
 * denied origin poisons the whole scope (fail-closed).
 */
export function excludedScopes(grants: readonly CompilerGrant[]): Set<string> {
  const out = new Set<string>();
  for (const g of grants) {
    if (g.tombstoned || g.expired) continue;
    if (g.decision === 'deny' || (g.decision === 'allow' && g.hasSchedule)) {
      out.add(g.scope);
    }
  }
  return out;
}

/**
 * The autonomous-stage kind ceiling: every scope's kinds minus every excluded
 * scope's kinds. A kind shared between an excluded and a non-excluded scope
 * (kind 1: post-public vs react-zap-reply) is still removed — fail-closed.
 * Returns `{ kinds, exclusionApplied }` so `full-autonomy` can distinguish
 * "no exclusion ⇒ `[]` (all kinds)" from "explicit list minus exclusions".
 */
export function autonomousKinds(
  grants: readonly CompilerGrant[],
): { kinds: number[]; exclusionApplied: boolean } {
  const excluded = excludedScopes(grants);
  const excludedKinds = new Set<number>();
  for (const scope of excluded) {
    const ks = SCOPE_KINDS[scope];
    if (!ks) continue;
    for (const k of ks) excludedKinds.add(k);
  }
  const kinds = ALL_SCOPE_KINDS.filter(
    (k) => !excludedKinds.has(k) && !NEVER_LISTED_KINDS.includes(k),
  );
  return { kinds: sortedUniqueKinds(kinds), exclusionApplied: excludedKinds.size > 0 };
}

// ---------------------------------------------------------------------------
// Child-direct slots (child's own phone paired straight to the Heartwood)
// ---------------------------------------------------------------------------

/** Heartwood slot label prefix for a child's own phone; distinct from the
 *  legacy `signet:child-device:` (no `v2:`) remote-mint label. */
export const CHILD_DIRECT_LABEL_PREFIX = 'signet:child-device:v2:';

export function childDirectSlotLabel(depId: string): string {
  return CHILD_DIRECT_LABEL_PREFIX + depId.slice(0, 16);
}

export function isChildDirectSlot(label: string): boolean {
  return typeof label === 'string' && label.startsWith(CHILD_DIRECT_LABEL_PREFIX);
}

/** What the compiler needs of a ChildRule. Timestamps are milliseconds, as on `ChildRule`. */
export interface ChildRuleLike {
  scope: string;
  decision: 'allow' | 'deny';
  tombstonedAt?: number;
  expiresAt?: number;
  updatedAt?: number;
}

export interface ChildDirectCompileInput {
  stage: AutonomyStage;
  /** `defaultSchedule?.paused === true` */
  paused: boolean;
  rules: ChildRuleLike[];
  approvedOnceKinds: { kind: number; until: number }[];
  boundPersona: string;
  auditVisible: boolean;
  nowSeconds: number;
}

/** Firmware MAX_ALLOWED_KINDS: the most kinds one slot ceiling can list. */
export const CHILD_CEILING_MAX = 64;

/** Kinds the child's own app signs as a persona regardless of rules (relay AUTH). */
const CHILD_INTERNAL_KINDS: readonly number[] = Object.freeze([22242]);

const CHILD_DIRECT_METHODS: readonly string[] = Object.freeze([
  'get_public_key',
  'sign_event',
  'nip44_encrypt',
  'nip44_decrypt',
]);

/**
 * Spec §6. The Heartwood holds a CEILING; the child's app applies the per-site
 * and per-app rules. The kind list is never empty (the firmware reads `[]` as
 * "all kinds") except at full-autonomy, where that is the intent.
 */
export function compileChildDirectPolicy(input: ChildDirectCompileInput): SlotPolicyUpdate {
  const bound = input.boundPersona.toLowerCase();
  if (input.paused) {
    return { ...LOCKED_SLOT_POLICY, allowedMethods: [], allowedKinds: [], boundIdentity: bound };
  }
  const base = {
    allowedMethods: [...CHILD_DIRECT_METHODS],
    autoApprove: true,
    escalate: false,
    petitionOnDeny: false,
    auditChildWrap: input.auditVisible,
    boundIdentity: bound,
  };
  if (input.stage === 'full-autonomy') return { ...base, allowedKinds: [] };

  // Priority order (the firmware lists at most CHILD_CEILING_MAX kinds):
  // 1 stage/scope kinds + relay AUTH, 2 approved-once, 3 `kind:<n>` rules newest first.
  const tier1 = new Set<number>(CHILD_INTERNAL_KINDS);
  for (const scope of Object.keys(SCOPE_KINDS)) {
    if (resolvePolicy(input.stage, scope as Scope).startsWith('auto')) {
      for (const k of SCOPE_KINDS[scope]) tier1.add(k);
    }
  }
  const nowMs = input.nowSeconds * 1000;
  const kindRules: { kind: number; at: number }[] = [];
  // At full-control the gate ignores allow rules, so they must not widen the ceiling.
  if (input.stage !== 'full-control') {
    for (const r of input.rules) {
      if (r.decision !== 'allow') continue;
      if (typeof r.tombstonedAt === 'number' && r.tombstonedAt > 0) continue;
      if (typeof r.expiresAt === 'number' && r.expiresAt > 0 && r.expiresAt <= nowMs) continue;
      const n = kindFromScope(r.scope);
      if (n !== null) kindRules.push({ kind: n, at: r.updatedAt ?? 0 });
      else if (!r.scope.startsWith('kind:')) for (const k of SCOPE_KINDS[r.scope] ?? []) tier1.add(k);
    }
  }
  const tier2 = input.approvedOnceKinds
    .filter(a => Number.isInteger(a.kind) && a.kind >= 0 && a.kind <= 65535 && a.until > input.nowSeconds)
    .map(a => a.kind);
  kindRules.sort((x, y) => y.at - x.at);
  const ordered: number[] = [];
  const seen = new Set<number>();
  const push = (k: number) => { if (!seen.has(k) && !NEVER_LISTED_KINDS.includes(k)) { seen.add(k); ordered.push(k); } };
  push(22242);
  sortedUniqueKinds([...tier1]).forEach(push);
  tier2.forEach(push);
  kindRules.forEach(r => push(r.kind));
  return { ...base, allowedKinds: sortedUniqueKinds(ordered.slice(0, CHILD_CEILING_MAX)) };
}

// ---------------------------------------------------------------------------
// Per-slot compilation
// ---------------------------------------------------------------------------

/**
 * §3.1 stage table for a dependant-bound slot. `boundIdentity` is echoed
 * from the slot as found — the compiler never re-binds.
 */
export function compileDependantSlotPolicy(
  dep: CompilerDependant,
  slot: DeviceClientSlot,
): SlotPolicyUpdate {
  const bound = lower(slot.boundIdentity);
  if (bound && dep.dormantIdentityPubkeys.includes(bound)) {
    const locked: SlotPolicyUpdate = { ...LOCKED_SLOT_POLICY, allowedMethods: [], allowedKinds: [] };
    if (slot.boundIdentity) locked.boundIdentity = slot.boundIdentity;
    return locked;
  }

  const autonomous = isAutonomousStage(dep.autonomyStage);
  const methods = [...(autonomous ? AUTONOMOUS_STAGE_METHODS : INTERACTIVE_STAGE_METHODS)];

  let autoApprove: boolean;
  let allowedKinds: number[];

  if (dep.hasDefaultSchedule) {
    // Interactive override: the schedule-free floor is empty, so park every
    // sign rather than hard-deny everything (guardian approve-once inside
    // the window). Methods stay per stage (nip44 kept at autonomous stages).
    autoApprove = false;
    allowedKinds = [];
  } else if (!autonomous) {
    // full-control / request-approve: park every sign — a non-empty kind
    // list would hard-deny ungranted kinds under strict semantics.
    autoApprove = false;
    allowedKinds = [];
  } else if (dep.autonomyStage === 'full-autonomy') {
    const { kinds, exclusionApplied } = autonomousKinds(dep.grants);
    autoApprove = true;
    allowedKinds = exclusionApplied ? kinds : [];
  } else {
    // autonomous-alerts / autonomous-logging
    autoApprove = true;
    allowedKinds = autonomousKinds(dep.grants).kinds;
  }

  const auditChildWrap = dep.auditVisible && isChildDeviceSlot(slot);

  const policy: SlotPolicyUpdate = {
    allowedMethods: methods,
    allowedKinds,
    autoApprove,
    escalate: true,
    petitionOnDeny: dep.petitionOnDeny === true,
    auditChildWrap,
  };
  if (slot.boundIdentity) policy.boundIdentity = slot.boundIdentity;
  return policy;
}

/**
 * §3.3 — the guardian phone's own pairing. Existing methods are preserved
 * (so a non-strict slot listing `heartwood_derive_persona` for D4 keeps it)
 * and the four sync-rail methods are added; on a strict slot only
 * `TOFU_SAFE_METHODS` survive. Never escalates (the guardian must not park
 * a request to themselves); no child-wrap fields; `boundIdentity` omitted.
 */
export function compileGuardianSlotPolicy(slot: DeviceClientSlot): SlotPolicyUpdate {
  let methods = uniqueStrings([...(slot.allowedMethods ?? []), ...GUARDIAN_REQUIRED_METHODS]);
  if (slot.strictPermissions) {
    methods = methods.filter((m) => TOFU_SAFE_METHODS.includes(m));
  }
  return {
    allowedMethods: methods,
    allowedKinds: [],
    autoApprove: true,
    escalate: false,
    petitionOnDeny: false,
    auditChildWrap: false,
  };
}

/**
 * Does the compiled policy differ from what the device already lists?
 * Methods compare as sets, kinds as sorted arrays, all four flags, and
 * `boundIdentity` only when the policy carries one.
 */
export function policyDiffersFromSlot(policy: SlotPolicyUpdate, slot: DeviceClientSlot): boolean {
  if (!sameSet(policy.allowedMethods, slot.allowedMethods ?? [])) return true;
  if (!sameSortedKinds(policy.allowedKinds, slot.allowedKinds ?? [])) return true;
  if (policy.autoApprove !== slot.autoApprove) return true;
  if (policy.escalate !== slot.escalate) return true;
  if (policy.petitionOnDeny !== slot.petitionOnDeny) return true;
  if (policy.auditChildWrap !== slot.auditChildWrap) return true;
  if (policy.boundIdentity !== undefined && lower(policy.boundIdentity) !== lower(slot.boundIdentity)) {
    return true;
  }
  return false;
}

function compileChildDirectSlot(
  dep: CompilerDependant,
  slot: DeviceClientSlot,
  nowSeconds: number,
): SlotPolicyUpdate {
  const bound = lower(slot.boundIdentity);
  if (!bound || dep.dormantIdentityPubkeys.includes(bound)) {
    // Never compile a ceiling for a dormant (or unbound) identity.
    const locked: SlotPolicyUpdate = { ...LOCKED_SLOT_POLICY, allowedMethods: [], allowedKinds: [] };
    if (bound) locked.boundIdentity = bound;
    return locked;
  }
  return compileChildDirectPolicy({
    stage: dep.autonomyStage,
    paused: dep.defaultSchedulePaused === true,
    rules: dep.childRules ?? [],
    approvedOnceKinds: dep.approvedOnceKinds ?? [],
    boundPersona: bound,
    auditVisible: dep.auditVisible,
    nowSeconds,
  });
}

function isGuardianSlot(slot: DeviceClientSlot, guardianClientPubkey: string | null): boolean {
  if (!guardianClientPubkey) return false;
  const g = lower(guardianClientPubkey);
  if (lower(slot.currentPubkey) === g) return true;
  return (slot.authorizedPubkeys ?? []).some((p) => lower(p) === g);
}

function findDependantForSlot(
  slot: DeviceClientSlot,
  dependants: readonly CompilerDependant[],
): CompilerDependant | null {
  if (isChildDirectSlot(slot.label ?? '')) {
    // The label names the dependant; the bound persona must also be theirs.
    const tag = (slot.label ?? '').slice(CHILD_DIRECT_LABEL_PREFIX.length);
    const bound0 = lower(slot.boundIdentity);
    for (const dep of dependants) {
      if (tag.length > 0 && dep.id.slice(0, 16).toLowerCase() === tag.toLowerCase()
        && dep.identityPubkeys.some((p) => lower(p) === bound0)) return dep;
    }
    return null;
  }
  const bound = lower(slot.boundIdentity);
  if (!bound) return null;
  for (const dep of dependants) {
    if (dep.identityPubkeys.some((p) => lower(p) === bound)) return dep;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Compile a policy for every FAMILY slot in the device inventory. Guardian
 * classification wins over dependant classification; slots that are neither
 * (consumer pairings, Sapwood, …) are counted `untouched` and never emitted.
 */
export function compileSlotPolicies(input: CompilerInput): CompileResult {
  const slots: CompiledSlot[] = [];
  const warnings: string[] = [];
  let untouched = 0;
  let guardianSeen = false;
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  for (const slot of input.deviceSlots) {
    if (isGuardianSlot(slot, input.guardianClientPubkey)) {
      guardianSeen = true;
      const policy = compileGuardianSlotPolicy(slot);
      slots.push({
        slotIndex: slot.slotIndex,
        secretFingerprint: slot.secretFingerprint,
        policy,
        reason: 'guardian',
        changed: policyDiffersFromSlot(policy, slot),
      });
      continue;
    }
    const dep = findDependantForSlot(slot, input.dependants);
    if (dep) {
      const policy = isChildDirectSlot(slot.label ?? '')
        ? compileChildDirectSlot(dep, slot, nowSeconds)
        : compileDependantSlotPolicy(dep, slot);
      slots.push({
        slotIndex: slot.slotIndex,
        secretFingerprint: slot.secretFingerprint,
        policy,
        reason: 'dependant',
        dependantId: dep.id,
        changed: policyDiffersFromSlot(policy, slot),
      });
      continue;
    }
    untouched += 1;
  }

  if (input.guardianClientPubkey && !guardianSeen) {
    warnings.push('guardian client pubkey not found in device inventory — sync rails unmanaged');
  }

  return { slots, untouched, warnings };
}

// ---------------------------------------------------------------------------
// App-record bridge
// ---------------------------------------------------------------------------

/**
 * Turn app records into `CompilerInput`. Pure — `nowSeconds` is injected so
 * grant expiry is deterministic under test.
 */
export function buildCompilerInput(args: {
  dependants: DependantIdentity[];
  grants: RememberedGrant[];
  guardianClientPubkey: string | null;
  deviceSlots: DeviceClientSlot[];
  nowSeconds: number;
  /** Child-direct rules (any dependant); absent ⇒ none. */
  childRules?: (ChildRuleLike & { dependantId: string })[];
  /** Approved-once kinds per dependant id; absent ⇒ none. */
  approvedOnceKinds?: Record<string, { kind: number; until: number }[]>;
}): CompilerInput {
  const approvedFor = (id: string): { kind: number; until: number }[] => {
    const out: { kind: number; until: number }[] = [];
    for (const [k, v] of Object.entries(args.approvedOnceKinds ?? {})) if (k.toLowerCase() === id.toLowerCase()) out.push(...v);
    return out;
  };
  const dependants: CompilerDependant[] = args.dependants.map((dep) => {
    const identityPubkeys = uniqueStrings(
      [
        dep.naturalPerson?.publicKey,
        dep.persona?.publicKey,
        ...(dep.extraPersonas ?? []).map((p) => p.publicKey),
      ]
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .map((p) => p.toLowerCase()),
    );
    const grants: CompilerGrant[] = args.grants
      .filter((g) => g.dependantId.toLowerCase() === dep.id.toLowerCase())
      .map((g) => ({
        scope: g.scope,
        decision: g.decision,
        hasSchedule: !!g.schedule,
        tombstoned: !!g.tombstonedAt,
        expired: typeof g.expiresAt === 'number' && g.expiresAt < args.nowSeconds,
      }));
    const dormantIdentityPubkeys = isDependantNaturalPersonActive(dep) || !dep.naturalPerson?.publicKey
      ? []
      : [dep.naturalPerson.publicKey.toLowerCase()];
    return {
      id: dep.id,
      identityPubkeys,
      dormantIdentityPubkeys,
      autonomyStage: dep.autonomyStage,
      hasDefaultSchedule: !!dep.defaultSchedule,
      auditVisible: resolveAuditVisibility(dep.autonomyStage, dep.auditVisibility),
      petitionOnDeny: dep.petitionOnDeny === true,
      grants,
      defaultSchedulePaused: dep.defaultSchedule?.paused === true,
      childRules: (args.childRules ?? []).filter((r) => r.dependantId.toLowerCase() === dep.id.toLowerCase()),
      approvedOnceKinds: approvedFor(dep.id),
    };
  });
  return {
    dependants,
    guardianClientPubkey: args.guardianClientPubkey,
    deviceSlots: args.deviceSlots,
    nowSeconds: args.nowSeconds,
  };
}
