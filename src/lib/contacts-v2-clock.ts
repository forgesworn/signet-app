/**
 * Lamport clock for contacts v2 operations (§8.2 review note).
 *
 * A per-device counter is NOT comparable across devices that never observe
 * each other: a rarely used phone would carry a low counter and lose every
 * conflict regardless of when its operation actually happened. So the clock is
 * a Lamport clock — on merge, local becomes max(local, observed) + 1 — and the
 * reducer breaks a tie by actor pubkey and then operation id.
 *
 * Pure: no storage, no time, no randomness.
 */

import type { ContactOperation } from '../types';

/** What this device has seen: the highest clock and every operation id it holds. */
export interface OpFrontier {
  maxClock: number;
  opIds: Set<string>;
}

function safeClock(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** The clock to stamp on the next locally authored operation. */
export function nextClock(local: number, observedMax: number): number {
  return Math.max(safeClock(local), safeClock(observedMax)) + 1;
}

export function frontierOf(ops: ContactOperation[]): OpFrontier {
  let maxClock = 0;
  const opIds = new Set<string>();
  for (const op of ops) {
    opIds.add(op.operationId);
    const clock = safeClock(op.logicalClock);
    if (clock > maxClock) maxClock = clock;
  }
  return { maxClock, opIds };
}

/**
 * Union two operation sets by `operationId`. The local copy wins a duplicate:
 * operations are immutable, so two rows with one id are the same fact, and
 * preferring the local one keeps the merge free of surprises.
 */
export function mergeOps(
  local: ContactOperation[],
  remote: ContactOperation[],
): { ops: ContactOperation[]; frontier: OpFrontier } {
  const byId = new Map<string, ContactOperation>();
  for (const op of remote) byId.set(op.operationId, op);
  for (const op of local) byId.set(op.operationId, op);
  const ops = Array.from(byId.values());
  return { ops, frontier: frontierOf(ops) };
}
