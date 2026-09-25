/**
 * Validate an inbound app proposal against its grant.
 *
 * A proposal is a REQUEST, never a write (exploration §5.2, §5.10). Five things
 * are checked before it may become a contact operation, and the order matters
 * only in what it costs to fail: grant binding, replay, capability, value
 * shape, and — for a rename — that the contact is one this grant has actually
 * been shown. That last check is what stops an app renaming a contact it was
 * never projected, by guessing or by replaying another grant's scoped id.
 *
 * `proposal.grantId` is APP-SUPPLIED data, not authentication — this module
 * only checks that it equals `ctx.grantId`, the grant record the CALLER
 * already resolved and trusts. Everything about why that trust is warranted
 * is the CALLER's job, before this function (or `validateProposalBatch`) is
 * ever invoked:
 *   1. the event/message carrying the proposal was authored by the pubkey on
 *      file for the grant (`grant.appPubkey`, compared lowercase) — nothing
 *      here re-derives or checks a signature;
 *   2. `grant.revokedAt` is unset — a revoked grant's proposals must never
 *      reach this function at all;
 *   3. any accepted outcome is applied ONLY to `grant.directoryId` — the
 *      grant names exactly one directory, and this function accepting a
 *      proposal is not itself a check that the caller is about to write to
 *      the right one.
 *
 * A `rename-app-label`'s `updatedAt` (ms epoch) is required and validated here
 * (R-7) and threaded through into the accepted outcome — the app applier
 * (Task 25) is what actually compares it against the record's existing label
 * clock and applies last-writer-wins; this module has no access to that
 * record, so it can only reject a missing, malformed, or implausibly future
 * clock, not a stale-vs-the-current-record one (R-17, not this module's job —
 * `AppGrantV2.appLabels`'s own LWW/cap enforcement is Task 21's).
 *
 * Pure: no IndexedDB, no clock. `now` and the seen-set are supplied.
 */
import {
  MAX_APP_LABEL, MAX_DISPLAY_NAME, MAX_PROPOSALS_PER_BATCH, MAX_STALENESS_SECONDS, sanitizeWireText,
} from '@forgesworn/signet-contacts/wire';
import type { AddKenValue, Capability, ContactProposalV1, ProposalBatch, RenameAppLabelValue } from '@forgesworn/signet-contacts/wire';
import { SEEN_OPERATION_ID_CAP } from '../types';

export type ProposalRejectReason =
  | 'wrong-grant' | 'replay' | 'capability-missing' | 'unknown-action' | 'invalid-value'
  | 'unknown-contact' | 'bad-operation-id' | 'future-dated' | 'stale' | 'batch-too-large';

export type ProposalOutcome =
  // `reason?: undefined` on the accepted variants is deliberate, not incidental:
  // it lets a caller (and this module's own tests) read `.reason` off any
  // `ProposalOutcome` without narrowing to `'rejected'` first — TypeScript
  // refuses bare property access on a union unless every member has the
  // property, and an accepted outcome has no reason to give.
  | { kind: 'add-ken'; operationId: string; pubkey: string; displayName: string; reason?: undefined }
  | { kind: 'rename-app-label'; operationId: string; scopedContactId: string; label: string; updatedAt: number; reason?: undefined }
  | { kind: 'rejected'; operationId: string | null; reason: ProposalRejectReason };

export interface ProposalContext {
  grantId: string;
  capabilities: readonly Capability[];
  seenOperationIds: ReadonlySet<string>;
  /** Grant-scoped ids this grant has projected. A rename may only target one. */
  knownScopedIds: ReadonlySet<string>;
  now: number;
  /** Seconds. Omit to use the SDK's `MAX_STALENESS_SECONDS`. See the caller
   *  obligations in the file header before constructing this context. */
  maxAgeSeconds?: number;
}

/** Tolerated clock skew on a proposing device. Beyond this a future timestamp
 *  is a poisoning attempt on recency reasoning, not a slow clock. */
const FUTURE_SKEW_SECONDS = 300;
/** Same skew, in milliseconds — `RenameAppLabelValue.updatedAt` is ms epoch
 *  while `ContactProposalV1.createdAt` (and `ProposalContext.now`) are seconds
 *  (the SDK's own vector fixture pins exactly this split: `updatedAt` in ms,
 *  `createdAt` in s). Converting once here rather than mixing units inline. */
const FUTURE_SKEW_MS = FUTURE_SKEW_SECONDS * 1000;

/** Map, not a plain object: a plain-object lookup keyed by an attacker-chosen
 *  `proposal.action` string (e.g. `'__proto__'`, `'constructor'`) resolves
 *  through the prototype chain to a non-`Capability` value instead of
 *  `undefined`. A `Map.get` has no prototype chain to fall through. */
const ACTION_CAPABILITY = new Map<string, Capability>([
  ['add-ken', 'signet.contacts.propose:add-ken'],
  ['rename-app-label', 'signet.contacts.propose:rename-app-label'],
]);

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** `null`, a primitive, or an array is never a proposal — reject rather than
 *  let a later `.field` access explode (or, for an array, silently read
 *  `undefined` off numeric-looking keys). */
function isPlainProposalShape(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractOperationId(proposal: unknown): string | null {
  if (!isPlainProposalShape(proposal)) return null;
  return typeof proposal.operationId === 'string' ? proposal.operationId : null;
}

export function validateProposal(proposal: ContactProposalV1, ctx: ProposalContext): ProposalOutcome {
  if (!isPlainProposalShape(proposal)) {
    return { kind: 'rejected', operationId: null, reason: 'invalid-value' };
  }
  const operationId = extractOperationId(proposal);
  if (operationId === null || !HEX32.test(operationId)) {
    return { kind: 'rejected', operationId, reason: 'bad-operation-id' };
  }
  if (proposal.grantId !== ctx.grantId) {
    return { kind: 'rejected', operationId, reason: 'wrong-grant' };
  }
  if (ctx.seenOperationIds.has(operationId)) {
    return { kind: 'rejected', operationId, reason: 'replay' };
  }
  const requiredCapability = ACTION_CAPABILITY.get(proposal.action as string);
  if (requiredCapability === undefined) {
    return { kind: 'rejected', operationId, reason: 'unknown-action' };
  }
  if (!ctx.capabilities.includes(requiredCapability)) {
    return { kind: 'rejected', operationId, reason: 'capability-missing' };
  }
  // R-16: both bounds on `createdAt`. A malformed clock (NaN/negative/
  // fractional) is a data-shape problem, not a timing one, so it gets
  // `invalid-value` rather than either timing reason.
  if (!isNonNegativeInteger(proposal.createdAt)) {
    return { kind: 'rejected', operationId, reason: 'invalid-value' };
  }
  if (proposal.createdAt > ctx.now + FUTURE_SKEW_SECONDS) {
    return { kind: 'rejected', operationId, reason: 'future-dated' };
  }
  const maxAge = ctx.maxAgeSeconds ?? MAX_STALENESS_SECONDS;
  if (proposal.createdAt < ctx.now - maxAge) {
    return { kind: 'rejected', operationId, reason: 'stale' };
  }

  if (proposal.action === 'add-ken') {
    const value = proposal.value as AddKenValue;
    if (typeof value?.pubkey !== 'string' || !HEX64.test(value.pubkey)) {
      return { kind: 'rejected', operationId, reason: 'invalid-value' };
    }
    // A/M2 (R-6): the SDK's OWN sanitiser, which is the one `parseProposal`
    // already ran over this string. `sanitizeDisplayName` slices by UTF-16
    // code unit, so a name whose cap boundary falls inside a surrogate pair
    // would be stored with a lone surrogate the wire never carried — two
    // sanitisers disagreeing on one string is exactly what R-6 exists to
    // prevent. In practice this is now a fixed point, not a second pass.
    const displayName = sanitizeWireText(value.displayName, MAX_DISPLAY_NAME);
    if (displayName.length === 0) return { kind: 'rejected', operationId, reason: 'invalid-value' };
    return { kind: 'add-ken', operationId, pubkey: value.pubkey.toLowerCase(), displayName };
  }

  const value = proposal.value as RenameAppLabelValue;
  if (typeof value?.contactId !== 'string' || !HEX32.test(value.contactId)) {
    return { kind: 'rejected', operationId, reason: 'invalid-value' };
  }
  // M2: upper-bounded too — an `updatedAt` implausibly far in the future is
  // the same poisoning attempt on recency reasoning as a future `createdAt`,
  // just in the LWW clock Task 25/21 will compare against later. No lower
  // bound here: "stale vs the CURRENT record" needs the record, which this
  // module never sees (R-17).
  if (!isNonNegativeInteger(value?.updatedAt) || value.updatedAt > ctx.now * 1000 + FUTURE_SKEW_MS) {
    return { kind: 'rejected', operationId, reason: 'invalid-value' };
  }
  const label = sanitizeWireText(value.label, MAX_APP_LABEL);
  if (label.length === 0) return { kind: 'rejected', operationId, reason: 'invalid-value' };
  if (!ctx.knownScopedIds.has(value.contactId)) {
    return { kind: 'rejected', operationId, reason: 'unknown-contact' };
  }
  return { kind: 'rename-app-label', operationId, scopedContactId: value.contactId, label, updatedAt: value.updatedAt };
}

/** Validate a whole batch. Ids accepted earlier in the batch count as seen for
 *  the rest of it — otherwise one event could carry the same operation fifty
 *  times and be applied fifty times, which is exactly what idempotency by
 *  `operationId` is for.
 *
 *  A batch over `MAX_PROPOSALS_PER_BATCH` is rejected outright, before any
 *  proposal in it is looked at: this function is a trust boundary in its own
 *  right (it does not require its caller to have routed the batch through the
 *  SDK's own size-truncating parser first), and validating N-1 proposals from
 *  an oversized batch then silently dropping the rest is a worse failure mode
 *  than refusing the whole thing. The rejection is echoed ONE PER INPUT
 *  PROPOSAL (same reason on each), not a single sentinel entry — a caller
 *  that zips `outcomes` against `batch.proposals` by index must get an
 *  outcome for every index, or it will misattribute reasons by position. */
export function validateProposalBatch(batch: ProposalBatch, ctx: ProposalContext): ProposalOutcome[] {
  if (batch.proposals.length > MAX_PROPOSALS_PER_BATCH) {
    return batch.proposals.map((proposal) => ({
      kind: 'rejected' as const,
      operationId: extractOperationId(proposal),
      reason: 'batch-too-large' as const,
    }));
  }
  const seen = new Set<string>(ctx.seenOperationIds);
  const outcomes: ProposalOutcome[] = [];
  for (const proposal of batch.proposals) {
    const outcome = validateProposal(proposal, { ...ctx, seenOperationIds: seen });
    if (outcome.kind !== 'rejected') seen.add(outcome.operationId);
    outcomes.push(outcome);
  }
  return outcomes;
}

/** Append new ids, dedupe, and keep the newest `SEEN_OPERATION_ID_CAP`. Only
 *  well-formed (32-hex) ids are ever persisted — `existing` is filtered too,
 *  not just `added`, so a caller that already has junk in its stored seen-set
 *  (an old format, a corrupted record) doesn't keep carrying it forward
 *  forever under the guise of "already there". */
export function rememberOperationIds(existing: readonly string[], added: readonly string[]): string[] {
  const merged = existing.filter((id) => HEX32.test(id));
  const have = new Set(merged);
  for (const id of added) {
    if (!HEX32.test(id) || have.has(id)) continue;
    have.add(id);
    merged.push(id);
  }
  return merged.length <= SEEN_OPERATION_ID_CAP ? merged : merged.slice(merged.length - SEEN_OPERATION_ID_CAP);
}
