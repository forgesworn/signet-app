/**
 * Which contacts directory the current surface is acting in, and as what.
 *
 * Three cases, and only three:
 *
 *  - the owner on their own device  -> `owner` directory, actor role `owner`;
 *  - a guardian who has scoped the app to a dependant (carousel dep row, or
 *    child mode) -> that dependant's directory, actor role `guardian`.
 *    CHILD MODE ON THE GUARDIAN'S DEVICE IS THE GUARDIAN ACTING (controller
 *    ruling R-CHILD-MODE): the guardian unlocked this device, so what is done
 *    here is a guardian act and the implicit child ceiling does not apply to
 *    it. That ceiling is for operations a dependant authors on their OWN
 *    paired device, which is the case below;
 *  - a paired-child install -> that SAME dependant's directory, actor role
 *    `dependant`.
 *
 * **Unresolvable case:** A paired-child install with null or empty `identity.id`
 * produces `directoryId: null`. This is a degenerate state (the child should
 * always have an identity id), but the scope is still flagged as
 * `actorRole: 'dependant'` / `directoryIsDependant: true` for error handling
 * consistency. `useContactsV2` already accepts `directoryId: null` and idles on it.
 *
 * Controller ruling: a paired-child device has no guardian roster to read —
 * its own `identity.id` IS the dependant id the guardian's device already
 * resolves via `directoryIdForDependant`, so this function applies the exact
 * same rule to the local identity id and lands on the identical directory
 * (`dependant:${identityId}`, never `owner`). This mirrors
 * `pairedChildImportRefs` in `contacts-v2-directories.ts`, which routes the
 * kid's own legacy rows into that same directory for the same reason.
 * `directoryIsDependant` is still true, so the guardian ceiling and the
 * `defaultChildCeiling` cap apply exactly as they do on the guardian device.
 */
import { OWNER_DIRECTORY_ID, type ContactActorRole, type ContactCeilingTier, type Page } from '../types';
import type { EffectiveContext } from './contacts-v2-effective';
import { directoryIdForDependant } from './contacts-v2-ids';

export interface ContactsScopeInput {
  /** `AppPreferences.signingMode`. */
  signingMode: string;
  /** The local identity's own record id — only consulted in `paired-child` mode. */
  identityId: string | null;
  activeDependant: { id: string; displayName: string } | null;
  /** True when the guardian has handed the device over (carousel child mode). */
  childMode: boolean;
  dependantCount: number;
}

export interface ContactsScope {
  /** Directory ID, or null when unresolvable (e.g. paired-child with no identity id). */
  directoryId: string | null;
  actorRole: ContactActorRole;
  directoryIsDependant: boolean;
  /** Whose contacts these are, for dependant-scoped copy; null on the owner's own directory. */
  subjectName: string | null;
  /** The guardian-only family manager is reachable from this surface. */
  canManageFamily: boolean;
}

export function resolveContactsScope(input: ContactsScopeInput): ContactsScope {
  if (input.signingMode === 'paired-child') {
    const identityId = input.identityId?.trim();
    return {
      directoryId: identityId ? directoryIdForDependant({ id: identityId }) : null,
      actorRole: 'dependant',
      directoryIsDependant: true,
      subjectName: null,
      canManageFamily: false,
    };
  }

  const dep = input.activeDependant;
  if (dep) {
    return {
      directoryId: directoryIdForDependant(dep),
      actorRole: 'guardian',
      directoryIsDependant: true,
      subjectName: dep.displayName,
      canManageFamily: false,
    };
  }

  return {
    directoryId: OWNER_DIRECTORY_ID,
    actorRole: 'owner',
    directoryIsDependant: false,
    subjectName: null,
    canManageFamily: !input.childMode && input.dependantCount > 0,
  };
}

/** Normalised guardian pubkeys: lowercase hex, de-duplicated, empties dropped. */
function normalisePubkeys(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pk of raw) {
    const lower = pk.trim().toLowerCase();
    if (!lower || seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

/**
 * Whether the App-wide family operation log (`useFamilyContactsV2`) needs to
 * be loaded for the current page/scope.
 *
 * Pulled out of App.tsx's `familyContacts` `enabled` expression because that
 * expression had the R-CHILD-MODE bug: `resolveContactsScope` returns
 * `canManageFamily: false` whenever `activeDependant` is set (child mode),
 * but the ceremony page (and the PersonaAdvanced dependant-removal route)
 * only ever render WITH `activeDependant` set — `onNavigateDeepPage` sets
 * `activeDependantId` before navigating to either. Gating those two routes
 * on `canManageFamily` therefore disabled the family log every time it was
 * actually needed, leaving `resolveIndependenceGate` and
 * `planDependantContactRemoval` reading an empty directory.
 *
 * The fix is `actorRole === 'guardian'` for both routes: child mode on the
 * guardian's own device IS the guardian acting (R-CHILD-MODE, see the module
 * docstring above), so the family log is needed exactly when a guardian —
 * never a paired-child install, which gets `actorRole: 'dependant'` — is
 * looking at either route, regardless of whether a specific dependant is
 * currently scoped in.
 *
 * `family-contacts` keeps the original `canManageFamily` gate (plus the
 * explicit unlock) — that page is the owner-only cross-family table, never
 * reached with `activeDependant` set, so the bug above doesn't apply there.
 *
 * `personaAdvancedForDependant` guards the `persona-advanced` clause against
 * the inverse mistake: the OWNER'S OWN slot entries into that page (Personas
 * page "Manage persona" / "Real identity advanced") never set or clear
 * `activeDependantId`, so a guardian who was just looking at a dependant
 * (carousel child mode, or a prior dependant-scoped route) and then opens
 * their OWN persona's Advanced page keeps a STALE `activeDependant` —
 * `scope.actorRole` reads 'guardian' from that leftover state even though
 * this visit has nothing to do with any dependant, and the family log would
 * load for no reason. Callers must pass the actual page-local fact — "is
 * `pendingPersonaAdvancedTarget.depPubkey` set for THIS visit" — not derive
 * it from `scope`, which the stale `activeDependant` has already polluted.
 */
export function familyLogNeeded(
  page: Page,
  scope: ContactsScope,
  familyContactsUnlocked: boolean,
  personaAdvancedForDependant: boolean,
): boolean {
  if (page === 'family-contacts') return familyContactsUnlocked && scope.canManageFamily;
  if (page === 'persona-advanced') return personaAdvancedForDependant && scope.actorRole === 'guardian';
  if (page === 'transition-ceremony') return scope.actorRole === 'guardian';
  return false;
}

/**
 * P7: App.tsx's `useFamilyContactsV2({ enabled: … })` expression, pulled out
 * to a pure function so it can be pinned by a test instead of only being
 * exercised implicitly through the App.tsx render tree. Identical to what
 * the call site computed inline: `familyLogNeeded` already returns `false`
 * for a paired-child install (every one of its three page checks requires
 * `scope.actorRole === 'guardian'`, and `resolveContactsScope` never
 * produces that role in `paired-child` mode) and for a STALE
 * `activeDependant` on an owner-slot `persona-advanced` visit (guarded by
 * `personaAdvancedForDependant` there) — this wrapper adds nothing new to
 * that logic, it only requires an unlock key too, matching the call site's
 * original `!!encryptionKey && …`.
 */
export function familyLogEnabled(
  encryptionKey: string | null,
  page: Page,
  scope: ContactsScope,
  familyContactsUnlocked: boolean,
  pendingPersonaAdvancedDepPubkey: string | null | undefined,
): boolean {
  return !!encryptionKey
    && familyLogNeeded(page, scope, familyContactsUnlocked, !!pendingPersonaAdvancedDepPubkey);
}

/**
 * I2: which of these dependant ids have no row in `loadedIds` yet — the
 * gate for App.tsx's "load every dependant's child settings while the
 * family log is enabled" effect. `childSettingsMap` used to hold only the
 * ACTIVE dependant's row (populated by a separate, narrower effect), so the
 * family manager resolved every OTHER dependant's ceiling column with
 * `DEFAULT_CHILD_CEILING` regardless of what was actually stored.
 */
export function dependantIdsMissingChildSettings(dependantIds: string[], loadedIds: string[]): string[] {
  const loaded = new Set(loadedIds);
  return dependantIds.filter(id => !loaded.has(id));
}

export function scopeEffectiveContext(
  scope: ContactsScope,
  activeGuardianPubkeys: string[],
  defaultChildCeiling: ContactCeilingTier,
): Omit<EffectiveContext, 'creatingActorRole'> {
  return {
    activeGuardianPubkeys: normalisePubkeys(activeGuardianPubkeys),
    defaultChildCeiling,
    directoryIsDependant: scope.directoryIsDependant,
  };
}
