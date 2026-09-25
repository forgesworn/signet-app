import type { SignetIdentity, DependantIdentity, PersonaPublicProfile } from '../types';

/**
 * Lift kind-0 config fields from `slot.publicProfile.{name,displayName,about,...}`
 * up to slot top-level. Idempotent — safe to run on already-lifted slots.
 * The publicProfile object shrinks to state-only afterwards.
 *
 * See 2026-05-17-persona-card-as-source-of-truth-design.md §6 migration.
 */
export function liftPublicProfileConfig(identity: SignetIdentity): SignetIdentity {
  if (!needsLift(identity)) return identity;
  const clone = structuredClone(identity);
  liftSlotInPlace(clone.naturalPerson);
  liftSlotInPlace(clone.persona);
  if (clone.professionalPersona) liftSlotInPlace(clone.professionalPersona);
  if (clone.extraPersonas) {
    for (const ep of clone.extraPersonas) liftSlotInPlace(ep);
  }
  return clone;
}

export function liftDependantPublicProfileConfig(dep: DependantIdentity): DependantIdentity {
  if (!needsLiftDep(dep)) return dep;
  const clone = structuredClone(dep);
  liftSlotInPlace(clone.naturalPerson);
  liftSlotInPlace(clone.persona);
  if (clone.extraPersonas) {
    for (const ep of clone.extraPersonas) liftSlotInPlace(ep);
  }
  return clone;
}

interface AnySlot {
  displayName?: string;
  about?: string;
  pictureUrl?: string;
  pictureBlossomHash?: string;
  bannerUrl?: string;
  bannerBlossomHash?: string;
  nip05?: string;
  lud16?: string;
  website?: string;
  publicProfile?: LegacyPublicProfile | PersonaPublicProfile;
}

interface LegacyPublicProfile {
  enabled: boolean;
  name?: string;
  displayName?: string;
  about?: string;
  pictureUrl?: string;
  pictureBlossomHash?: string;
  bannerUrl?: string;
  bannerBlossomHash?: string;
  nip05?: string;
  lud16?: string;
  website?: string;
  lastEventId?: string;
  lastPublishedAt?: number;
  lastPublishedRelay?: string;
  lastPublishedContentHash?: string;
}

function liftSlotInPlace(slot: AnySlot): void {
  const pp = slot.publicProfile as LegacyPublicProfile | undefined;
  if (!pp) return;

  // For each config field: top-level wins if present; otherwise use legacy value
  const CONFIG_KEYS = ['about', 'pictureUrl', 'pictureBlossomHash', 'bannerUrl', 'bannerBlossomHash', 'nip05', 'lud16', 'website'] as const;
  for (const k of CONFIG_KEYS) {
    if (slot[k] === undefined && pp[k] !== undefined) {
      slot[k] = pp[k];
    }
  }

  // displayName: legacy publicProfile.displayName (or .name) overrides ONLY
  // if slot has no displayName field at all. Use === undefined (not !slot.displayName)
  // so an intentionally-empty string is preserved — matches the CONFIG_KEYS
  // loop above. Audit pass 4.
  if (slot.displayName === undefined && (pp.displayName || pp.name)) {
    slot.displayName = pp.displayName || pp.name;
  }

  // Replace publicProfile with state-only. `lastPublishedContentHash` is
  // a new state field — legacy records won't have it, so the first publish
  // after upgrade just sets it (the short-circuit can't fire until then,
  // which is the correct behaviour — we don't know what content is on the
  // relay yet from this device's perspective).
  const stateOnly: PersonaPublicProfile = {
    enabled: pp.enabled,
    lastEventId: pp.lastEventId,
    lastPublishedAt: pp.lastPublishedAt,
    lastPublishedRelay: pp.lastPublishedRelay,
    lastPublishedContentHash: pp.lastPublishedContentHash,
  };
  slot.publicProfile = stateOnly;
}

function needsLift(identity: SignetIdentity): boolean {
  return slotNeedsLift(identity.naturalPerson)
    || slotNeedsLift(identity.persona)
    || (identity.professionalPersona ? slotNeedsLift(identity.professionalPersona) : false)
    || (identity.extraPersonas ?? []).some(slotNeedsLift);
}

function needsLiftDep(dep: DependantIdentity): boolean {
  return slotNeedsLift(dep.naturalPerson)
    || slotNeedsLift(dep.persona)
    || (dep.extraPersonas ?? []).some(slotNeedsLift);
}

function slotNeedsLift(slot: AnySlot): boolean {
  const pp = slot.publicProfile as LegacyPublicProfile | undefined;
  if (!pp) return false;
  return pp.name !== undefined
    || pp.displayName !== undefined
    || pp.about !== undefined
    || pp.pictureUrl !== undefined
    || pp.pictureBlossomHash !== undefined
    || pp.bannerUrl !== undefined
    || pp.bannerBlossomHash !== undefined
    || pp.nip05 !== undefined
    || pp.lud16 !== undefined
    || pp.website !== undefined;
}
