import { contactIdentityLists } from './contacts-v2-identity-lists';
/**
 * Build local grant choices and projection contexts from available vaults and
 * owning identities. Identity keys stay local; projection serialization emits
 * neither this roster nor memberships in other identity lists.
 * Pure: no React, storage or clock.
 */
import type { DependantIdentity, SignetIdentity } from '../types';
import type { ProjectionDirectory } from '../hooks/useContactProjections';
import type { EffectiveContext } from './contacts-v2-effective';
import type { FamilyDirectoryRef } from '../hooks/useFamilyContactsV2';
import { directoryIdForDependant } from './contacts-v2-ids';

export type { ProjectionDirectory };

export interface GrantDirectoryOption { directoryId: string; label: string; ownerIdentityPubkey?: string }

export function grantOwnerPubkey(
  identity: SignetIdentity | null,
  dependants: readonly DependantIdentity[],
  directoryId: string,
): string | null {
  if (!identity) return null;
  if (directoryId === 'owner') return identity.persona?.publicKey || null;
  const dep = dependants.find((d) => directoryIdForDependant(d) === directoryId);
  return dep?.persona?.publicKey || null;
}

function contextFor(ref: FamilyDirectoryRef): Omit<EffectiveContext, 'creatingActorRole'> {
  return {
    activeGuardianPubkeys: ref.activeGuardianPubkeys,
    defaultChildCeiling: ref.defaultChildCeiling,
    directoryIsDependant: !ref.isOwner,
  };
}

/** One projection directory per ref whose owner persona resolves. A ref that
 *  does not resolve is DROPPED: this device does not hold that directory's
 *  identity. The returned identity roster is private projection input. */
export function buildProjectionDirectories(
  refs: readonly FamilyDirectoryRef[],
  identity: SignetIdentity | null,
  dependants: readonly DependantIdentity[],
): ProjectionDirectory[] {
  const out: ProjectionDirectory[] = [];
  for (const ref of refs) {
    const dependant = ref.isOwner ? null : dependants.find(d => directoryIdForDependant(d) === ref.directoryId);
    if (!ref.isOwner && !dependant) continue;
    const lists = contactIdentityLists(identity, dependant ?? null);
    if (!lists.length) continue;
    out.push({ directoryId: ref.directoryId, context: contextFor(ref), ownerIdentityPubkeys: lists.map(l => l.ownerIdentityPubkey) });
  }
  return out;
}

/**
 * R-34: the refs whose projection context is actually KNOWN.
 *
 * A dependant directory's `defaultChildCeiling` decides what tier the child's
 * own contacts are projected at, and it is read per dependant from
 * `db.getChildSettings`. Before that read completes there is no honest answer
 * — `DEFAULT_CHILD_CEILING` is a stand-in, not a fact — so the directory is
 * held out entirely rather than published under it and then republished with
 * different tiers a moment later. `resolvedDependantIds` means "the read
 * completed", including the read that found no stored row at all; a dependant
 * with no row legitimately resolves to the default.
 *
 * The owner directory has no such dependency and is never held.
 */
export function projectableDirectoryRefs(
  refs: readonly FamilyDirectoryRef[],
  dependants: readonly DependantIdentity[],
  resolvedDependantIds: ReadonlySet<string>,
): FamilyDirectoryRef[] {
  return refs.filter((ref) => ref.isOwner || dependants.some((dep) => (
    directoryIdForDependant(dep) === ref.directoryId && resolvedDependantIds.has(dep.id)
  )));
}

/**
 * The approval screen's radio list. Labels come from the refs — never a
 * literal in App.tsx, which is outside the copy guard's glob but still bound
 * by the copy rule.
 *
 * M1: the list is composed with the RESOLVED directories, not taken from the
 * refs alone, so the picker can only ever offer what the approval handler
 * would accept. A ref whose owner pubkey does not resolve on this device is
 * dropped by `buildProjectionDirectories`; offering it here would put a
 * choice on screen that refuses itself the moment it is taken.
 */
export function grantDirectoryOptions(
  refs: readonly FamilyDirectoryRef[],
  directories: readonly { directoryId: string }[],
): GrantDirectoryOption[] {
  const resolvable = new Set(directories.map((d) => d.directoryId));
  return refs
    .filter((ref) => resolvable.has(ref.directoryId))
    .map((ref) => ({ directoryId: ref.directoryId, label: ref.label }));
}

/** Approval names one identity, while storage and family policy stay vault-scoped. */
export function grantIdentityOptions(refs: readonly FamilyDirectoryRef[], directories: readonly { directoryId: string }[], identity: SignetIdentity | null, dependants: readonly DependantIdentity[]): GrantDirectoryOption[] {
  return refs.flatMap(ref => {
    if (!directories.some(d => d.directoryId === ref.directoryId)) return [];
    const dep = ref.isOwner ? null : dependants.find(d => directoryIdForDependant(d) === ref.directoryId);
    if (!ref.isOwner && !dep) return [];
    return contactIdentityLists(identity, dep ?? null).map(list => ({
      directoryId: ref.directoryId, ownerIdentityPubkey: list.ownerIdentityPubkey,
      label: ref.isOwner ? list.label : `${ref.label} · ${list.label}`,
    }));
  });
}
