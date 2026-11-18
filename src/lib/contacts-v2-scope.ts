/**
 * Which contacts directory the current surface is acting in, and as what.
 *
 * Four cases:
 *
 *  - the owner on their own device  -> `owner` directory, actor role `owner`;
 *  - a guardian who has scoped the app to a dependant row WITHOUT handing the
 *    phone over (child mode off) -> that dependant's directory, actor role
 *    `guardian` (D2: only child mode flips);
 *  - CHILD MODE on the guardian's device (R-CHILD-MODE, reversed 2026-11-18):
 *    the child is the actor. The scoped dependant, when it is the child, gives
 *    that dependant's directory with actor role `dependant`, exactly what a
 *    paired-child install of the same dependant authors, so the child ceiling,
 *    the guardian's blocks and the `set-picture` refusal apply. Guardian
 *    decisions wait for the PIN exit. Child mode with no resolved child (the
 *    saved-session window before the restore, the lock flash) or a state not
 *    yet known is treated as child mode and idles on `directoryId: null`:
 *    never the owner directory (D4, fail closed);
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
import type { ChildModeState } from './child-mode-sign-in';

export interface ContactsScopeInput {
  /** `AppPreferences.signingMode`. */
  signingMode: string;
  /** The local identity's own record id — only consulted in `paired-child` mode. */
  identityId: string | null;
  activeDependant: { id: string; displayName: string } | null;
  /**
   * Child mode as the guardian's phone knows it (`childModeState`): `'on'`
   * while live or still saved and not yet restored, `'unknown'` until the saved
   * session has been read, `'off'` otherwise. Anything but `'off'` is child mode.
   */
  childModeNow: ChildModeState;
  /** The live child-mode dependant's id, when one is resolved. */
  childDependantId: string | null;
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

  if (input.childModeNow !== 'off') {
    // Child mode: the child acts. Only the scoped dependant that IS the child
    // resolves; anything else idles (never the owner directory).
    const dep = input.activeDependant;
    const childId = input.childDependantId?.trim().toLowerCase();
    const isChild = !!dep && !!childId && dep.id.toLowerCase() === childId && input.childModeNow === 'on';
    return {
      directoryId: isChild ? directoryIdForDependant(dep) : null,
      actorRole: 'dependant',
      directoryIsDependant: true,
      subjectName: isChild ? dep.displayName : null,
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
    canManageFamily: input.dependantCount > 0,
  };
}

/**
 * The pubkey that authors ops for THIS surface (the `useContactsV2` actor,
 * contact rights, own-block checks, the Rolodex). In child mode that is the
 * child's id (the dependant's primary pubkey, lowercased), exactly what a
 * paired-child install stamps; with child mode on but no resolved child, or
 * not yet known, it is empty (no actor, so nothing can be written). Otherwise
 * it is `actorPubkey`.
 *
 * It is NOT the install-wide guardian identity: the owner directory's guardian
 * set, the family hook, the legacy import, the picture-backup sweep and app
 * proposals keep reading `contactsActorPubkey` in App.tsx, which child mode
 * must never re-stamp.
 */
export function contactsScopeActorPubkey(input: {
  childModeNow: ChildModeState;
  childDependantId: string | null;
  isPairedChild: boolean;
  /** `contactsActorPubkey`: the paired child's id, or the guardian's stable pubkey. */
  actorPubkey: string;
}): string {
  if (input.isPairedChild || input.childModeNow === 'off') return input.actorPubkey;
  if (input.childModeNow === 'unknown') return '';
  return input.childDependantId?.trim().toLowerCase() ?? '';
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
 * expression had a bug: `resolveContactsScope` returns
 * `canManageFamily: false` whenever `activeDependant` is set (a dependant row),
 * but the ceremony page (and the PersonaAdvanced dependant-removal route)
 * only ever render WITH `activeDependant` set — `onNavigateDeepPage` sets
 * `activeDependantId` before navigating to either. Gating those two routes
 * on `canManageFamily` therefore disabled the family log every time it was
 * actually needed, leaving `resolveIndependenceGate` and
 * `planDependantContactRemoval` reading an empty directory.
 *
 * The fix is `actorRole === 'guardian'` for both routes: a guardian picking
 * a dependant row (child mode off) is the guardian acting, so
 * the family log is needed exactly when a guardian actor — never a paired-child
 * install nor child mode, which get `actorRole: 'dependant'` (and refuse both
 * pages anyway) — is looking at either route, regardless of whether a specific
 * dependant is currently scoped in.
 *
 * `family-contacts` keeps the original `canManageFamily` gate (plus the
 * explicit unlock) — that page is the owner-only cross-family table, never
 * reached with `activeDependant` set, so the bug above doesn't apply there.
 *
 * `personaAdvancedForDependant` guards the `persona-advanced` clause against
 * the inverse mistake: the OWNER'S OWN slot entries into that page (Personas
 * page "Manage persona" / "Real identity advanced") never set or clear
 * `activeDependantId`, so a guardian who was just looking at a dependant
 * (a prior dependant-scoped route, or child mode just exited) and then opens
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
