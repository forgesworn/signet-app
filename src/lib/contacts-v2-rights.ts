/**
 * What the current actor may do to one contact record.
 *
 * Spec section 7.9: a dependant may always Block as a safety action, and may
 * only lift a block they applied themselves; one guardian cannot clear another
 * guardian's block. That rule is here, once, so no page can offer an Unblock
 * button the reducer would then reject.
 */
import type { BlockFact, ContactActorRole, ContactRecord, EffectiveContact } from '../types';
import {
  DEPENDANT_BLOCK_LOCK_COPY, GUARDIAN_BLOCK_LOCK_COPY, OTHER_GUARDIAN_BLOCK_LOCK_COPY,
} from './contacts-v2-copy';

export interface ActorIdentity {
  actorRole: ContactActorRole;
  actorPubkey: string;
}

export interface ActorRights {
  canRename: boolean;
  canSetTier: boolean;
  canEditRoles: boolean;
  canEditMethods: boolean;
  canEditNote: boolean;
  canAddIdentity: boolean;
  canBlock: boolean;
  canUnblock: boolean;
  /** Why Unblock is disabled, or null when it is enabled / not applicable. */
  unblockBlockedReason: string | null;
  canRemove: boolean;
  canArchive: boolean;
  canVouch: boolean;
  canSetCeiling: boolean;
}

const NO_RIGHTS: ActorRights = {
  canRename: false, canSetTier: false, canEditRoles: false, canEditMethods: false,
  canEditNote: false, canAddIdentity: false, canBlock: false, canUnblock: false,
  unblockBlockedReason: null, canRemove: false, canArchive: false,
  canVouch: false, canSetCeiling: false,
};

export function activeBlocks(record: Pick<ContactRecord, 'blocks'>): BlockFact[] {
  return record.blocks.filter(b => !b.liftedByOperationId);
}

export function ownBlocks(record: Pick<ContactRecord, 'blocks'>, actorPubkey: string): BlockFact[] {
  const actor = actorPubkey.toLowerCase();
  return activeBlocks(record).filter(b => b.blockedBy.toLowerCase() === actor);
}

export function resolveActorRights(
  record: EffectiveContact,
  actor: ActorIdentity,
  /**
   * M7: guardians whose pubkeys count as "a guardian" for the unblock-lock
   * copy below — the same set `EffectiveContext.activeGuardianPubkeys`
   * carries for tier resolution. Optional (defaults to none) because most
   * callers never reach the branch that consults it: a `dependant` actor's
   * only possible "other" blocker in their own directory is a guardian, and
   * every other branch either has `allMine` true or no active block at all.
   */
  activeGuardianPubkeys: string[] = [],
): ActorRights {
  if (actor.actorRole === 'app') return { ...NO_RIGHTS };
  if (record.lifecycle === 'removed') return { ...NO_RIGHTS };

  const active = activeBlocks(record);
  const mine = ownBlocks(record, actor.actorPubkey);
  const allMine = active.length > 0 && active.length === mine.length;

  let unblockBlockedReason: string | null = null;
  if (active.length > 0 && !allMine) {
    if (actor.actorRole === 'dependant') {
      // A dependant's own directory has no other dependant to block them —
      // any "other" block there is always a guardian's.
      unblockBlockedReason = GUARDIAN_BLOCK_LOCK_COPY;
    } else {
      // M7/N2: choose by the BLOCK AUTHOR's role, not the current actor's —
      // a guardian locked out by a block the DEPENDANT applied themselves
      // must not be told "another guardian" applied it. BUT a non-actor
      // blocker outside `activeGuardianPubkeys` is only evidence of a
      // dependant author on a DEPENDANT directory — `guardianPubkeysFor`
      // (App.tsx) returns at most one pubkey, so on a `dependant:*`
      // directory with joint guardianship, or in the OWNER's own directory
      // (which has no dependant to block anyone), a co-guardian's own block
      // would otherwise fall outside that one-pubkey set and be misread as
      // a dependant's. The owner's own directory can never have a dependant
      // author at all, so it always reads as "another guardian".
      const actorLower = actor.actorPubkey.toLowerCase();
      const guardianSet = new Set(activeGuardianPubkeys.map(pk => pk.toLowerCase()));
      const others = active.filter(b => b.blockedBy.toLowerCase() !== actorLower);
      const isDependantDirectory = record.directoryId.startsWith('dependant:');
      const dependantApplied = isDependantDirectory
        && others.some(b => !guardianSet.has(b.blockedBy.toLowerCase()));
      unblockBlockedReason = dependantApplied ? DEPENDANT_BLOCK_LOCK_COPY : OTHER_GUARDIAN_BLOCK_LOCK_COPY;
    }
  }

  const guardianOverDependant = actor.actorRole === 'guardian';

  return {
    canRename: true,
    canSetTier: true,
    canEditRoles: true,
    canEditMethods: true,
    canEditNote: true,
    canAddIdentity: true,
    canBlock: active.length === 0,
    canUnblock: allMine,
    unblockBlockedReason,
    canRemove: true,
    canArchive: true,
    canVouch: guardianOverDependant,
    canSetCeiling: guardianOverDependant,
  };
}
