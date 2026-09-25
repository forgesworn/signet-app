/**
 * Contacts v2 effective-state resolver (§7.9, §7.10; exploration §5.9 item 4).
 *
 * TWO independent outputs, not one ladder:
 *
 *   effectiveTier = min( max( capped own evidence , strongest active vouch ) ,
 *                        every active guardian ceiling )
 *   blocked       = any active block — a separate safety flag that NEVER
 *                   feeds `effectiveTier` (the tier facts stay readable while
 *                   blocked, for audit and for a later Unblock).
 *
 * Nothing here deletes or rewrites a fact: a revoked vouch falls back to the
 * next valid source, and a Blocked contact keeps its tier, provenance and
 * history.
 *
 * The implicit child ceiling answers the §7.10 self-classification loop: a
 * contact a dependant added themselves is capped at `ctx.defaultChildCeiling`
 * (default `'ken'`) so a child cannot promote a stranger to Kin and thereby
 * admit them under a `kin-only` contact policy. It caps the child's OWN
 * classification only — an active guardian vouch is independent evidence and
 * lifts the result to ITS tier (a `'kith'` vouch over a child's `'kin'` gives
 * `'kith'`, not `'kin'` and not `'ken'`). A guardian who wants the contact
 * held below their own vouch writes an explicit ceiling, which is applied
 * after and wins.
 *
 * Pure: no storage, no time, no randomness.
 */

import {
  CONTACT_TIER_RANK,
  type ContactActorRole,
  type ContactCeilingTier,
  type ContactRecord,
  type ContactTier,
  type ContactTierSource,
  type EffectiveContact,
} from '../types';

export interface EffectiveContext {
  /**
   * Guardians whose VOUCHES and CEILINGS still count — a departed guardian's
   * are ignored, because both are standing permissions and a person who is no
   * longer a guardian has no standing to raise or hold a tier.
   *
   * Blocks are deliberately NOT filtered by this list. A block is a safety
   * statement about a contact, not a permission held by its author, and §7.10
   * gives only the blocking authority the power to lift one — so a departing
   * guardian's block would be both un-expiring and unliftable if it were
   * dropped here. It therefore stands until its author lifts it (the spec's
   * "persists until reviewed"). The asymmetry is the point: forgetting a
   * departed guardian's ceiling widens access, forgetting their block widens
   * access too, so both are resolved in the safety-preserving direction.
   */
  activeGuardianPubkeys: string[];
  /** Ceiling applied to a dependant-created, unvouched contact. */
  defaultChildCeiling: ContactCeilingTier;
  /** True for a `dependant:*` directory. The implicit ceiling never applies to the owner's own directory. */
  directoryIsDependant: boolean;
  /** Optional override; otherwise each record's own `createdByActorRole` is used. */
  creatingActorRole?: ContactActorRole;
}

/**
 * R-7: a contact an APP proposed is capped at `'ken'` in EVERY directory,
 * including the owner's own.
 *
 * The child ceiling exists because a dependant's own classification is an
 * unreviewed claim. An app's is less than that: it is a claim by software the
 * owner connected for a specific purpose, landed without anyone looking at it
 * at the moment it arrived. Ken — "a key you recognise" — is exactly what an
 * app is entitled to assert. Anything above it is a statement about closeness
 * that only a person can make, and a `kin-only` contact policy has to mean
 * something.
 *
 * Like the child ceiling, this caps the record's OWN evidence only: an active
 * guardian vouch is independent evidence and is taken at its own tier.
 */
const APP_CREATED_CEILING: ContactCeilingTier = 'ken';

/** `'none'` is below every tier. */
function rankOf(tier: ContactCeilingTier): number {
  return tier === 'none' ? 0 : CONTACT_TIER_RANK[tier];
}

function tierOfRank(rank: number): ContactCeilingTier {
  if (rank >= CONTACT_TIER_RANK.kin) return 'kin';
  if (rank >= CONTACT_TIER_RANK.kith) return 'kith';
  if (rank >= CONTACT_TIER_RANK.ken) return 'ken';
  return 'none';
}

export function resolveEffective(record: ContactRecord, ctx: EffectiveContext): EffectiveContact {
  const guardians = new Set(ctx.activeGuardianPubkeys);

  const activeVouches = record.vouches.filter(
    v => !v.revokedByOperationId && guardians.has(v.guardianPubkey),
  );
  const directRank = rankOf(record.tier as ContactTier);
  let vouchedRank = 0;
  for (const v of activeVouches) {
    const r = rankOf(v.tier);
    if (r > vouchedRank) vouchedRank = r;
  }
  /** What the record would be worth with no ceiling of any kind. */
  const evidenceRank = Math.max(directRank, vouchedRank);

  // The implicit child ceiling caps the child's OWN classification; a guardian
  // vouch is independent evidence and is taken at its own tier afterwards.
  const creator = ctx.creatingActorRole ?? record.createdByActorRole;
  const tierActor = record.tierSetByActorRole ?? creator;
  const implicitApplies = ctx.directoryIsDependant && tierActor !== 'guardian';
  const appApplies = tierActor === 'app';
  let ownRank = implicitApplies
    ? Math.min(directRank, rankOf(ctx.defaultChildCeiling))
    : directRank;
  if (appApplies) ownRank = Math.min(ownRank, rankOf(APP_CREATED_CEILING));

  let effectiveRank = Math.max(ownRank, vouchedRank);
  // With a vouch in play the guardian is the operative source even when their
  // vouch only matches the capped own rank — nothing here is the child's own
  // unreviewed claim any more.
  const vouchWins = vouchedRank > 0 && vouchedRank >= ownRank;
  let tierSource: ContactTierSource = vouchWins ? 'guardian-vouched' : 'direct';

  const beforeExplicitCeilings = effectiveRank;
  for (const c of record.ceilings) {
    if (c.revokedByOperationId) continue;
    if (!guardians.has(c.guardianPubkey)) continue;
    const r = rankOf(c.maxTier);
    if (r < effectiveRank) effectiveRank = r;
  }
  if (effectiveRank < beforeExplicitCeilings) {
    tierSource = 'guardian-limited';          // an explicit ceiling held it down
  } else if (!vouchWins && effectiveRank < evidenceRank) {
    tierSource = 'guardian-limited';          // the implicit child ceiling did, unvouched
  }

  // NOT filtered by `guardians`: see the `activeGuardianPubkeys` docstring —
  // only the blocking authority may lift a block (§7.10).
  const activeBlocks = record.blocks.filter(b => !b.liftedByOperationId);

  return {
    ...record,
    effectiveTier: tierOfRank(effectiveRank),
    tierSource,
    blocked: activeBlocks.length > 0,
    blockedBy: Array.from(new Set(activeBlocks.map(b => b.blockedBy))),
  };
}

export function resolveEffectiveDirectory(
  records: Iterable<ContactRecord>,
  ctx: EffectiveContext,
): EffectiveContact[] {
  return Array.from(records, r => resolveEffective(r, ctx));
}
