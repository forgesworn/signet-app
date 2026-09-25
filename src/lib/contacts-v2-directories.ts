/**
 * Which pubkeys own which contacts directory.
 *
 * The legacy `contacts` / `ken` rows carry an `ownerPubkey` that is whichever
 * slot performed the ceremony — an owner persona, the NP, an extra, the
 * professional slot, or a dependant slot. The import needs the full slot set
 * per directory to route a row; a pubkey matching nothing is quarantined, and
 * that is exactly why these lists must be complete rather than NP-only.
 *
 * Pure: no storage, no time, no randomness.
 */

import type { DependantIdentity, SignetIdentity } from '../types';
import { directoryIdForDependant } from './contacts-v2-ids';
import type { ImportDependantRef } from './contacts-v2-import';

function uniqueNonEmpty(keys: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    if (typeof key === 'string' && key.length > 0 && !out.includes(key)) out.push(key);
  }
  return out;
}

export function ownerSlotPubkeys(identity: SignetIdentity | null): string[] {
  if (!identity) return [];
  return uniqueNonEmpty([
    identity.naturalPerson?.publicKey,
    identity.persona?.publicKey,
    identity.professionalPersona?.publicKey,
    ...(identity.extraPersonas ?? []).map(p => p.publicKey),
  ]);
}

export function dependantImportRefs(dependants: DependantIdentity[]): ImportDependantRef[] {
  return dependants.map(dep => ({
    directoryId: directoryIdForDependant(dep),
    slotPubkeys: uniqueNonEmpty([
      dep.naturalPerson?.publicKey,
      dep.persona?.publicKey,
      ...(dep.extraPersonas ?? []).map(p => p.publicKey),
    ]),
  }));
}

/**
 * A paired-child device's own import scope (Controller ruling). The kid has
 * no guardian-side dependant record to read — its own `identity.id` IS the
 * dependant id the guardian's device already resolves via
 * `directoryIdForDependant`, so calling the same rule locally lands on the
 * identical directory. Only the kid's OWN slot pubkeys go in — never a
 * guardian slot — because a kid-owned legacy row can only have been signed by
 * a kid-owned key.
 */
export function pairedChildImportRefs(identity: SignetIdentity | null): ImportDependantRef[] {
  if (!identity) return [];
  return [{
    directoryId: directoryIdForDependant({ id: identity.id }),
    slotPubkeys: ownerSlotPubkeys(identity),
  }];
}

/**
 * The ONE actor pubkey this install stamps on every contacts-v2 operation it
 * authors (controller ruling R-ACTOR).
 *
 * It is the natural-person pubkey — present even while the real identity is
 * dormant — falling back to the persona only for a record with no NP slot at
 * all. Deliberately NOT `identity.id`, which is *whichever keypair is
 * currently primary*: a `switchPrimary` would then silently re-author the
 * same person's operations under a second pubkey, splitting the sort order
 * (`logicalClock, actorPubkey, operationId`) and — worse — breaking the
 * per-author rules the reducer enforces, since only the guardian who wrote a
 * vouch, ceiling or block may revoke it.
 *
 * This is the same value as App.tsx's `guardianNpPubkey`, and therefore the
 * same value as `dep.guardianPubkey` on every dependant this install manages,
 * which is what makes `guardianPubkeysFor` below agree with it.
 *
 * It is ONLY ever an actor id inside the encrypted local log: never rendered,
 * never projected (Phase E strips actors), never on a public event.
 *
 * A PAIRED-CHILD install does not use this — the kid authors as their own
 * dependant record id (`identity.id`), which is stable there by construction.
 */
export function stableActorPubkey(identity: SignetIdentity | null): string | null {
  if (!identity) return null;
  const key = identity.naturalPerson?.publicKey || identity.persona?.publicKey || '';
  return key ? key.toLowerCase() : null;
}

/**
 * The guardians whose vouches and ceilings count in one dependant's directory
 * (R-ACTOR). Takes anything carrying a `guardianPubkey`: a `DependantIdentity`
 * on the guardian's own device, or the `PairedChildRecord` on the kid's device
 * (where the field is optional — a pairing made before it existed yields an
 * empty list, and the kid simply sees no guardian facts until they re-pair).
 */
export function guardianPubkeysFor(subject: { guardianPubkey?: string } | null | undefined): string[] {
  const key = subject?.guardianPubkey;
  return typeof key === 'string' && key.length > 0 ? [key.toLowerCase()] : [];
}
