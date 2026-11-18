import { describe, it, expect } from 'vitest';
import {
  resolveContactsScope, scopeEffectiveContext, familyLogNeeded, familyLogEnabled,
  dependantIdsMissingChildSettings, contactsScopeActorPubkey,
} from './contacts-v2-scope';

const GUARDIAN = '1'.repeat(64);
const DEP = 'c'.repeat(64);
const KID = 'd'.repeat(64);

describe('resolveContactsScope', () => {
  it('puts the owner in the owner directory as owner', () => {
    const scope = resolveContactsScope({
      signingMode: 'local', identityId: null, activeDependant: null, childModeNow: 'off', childDependantId: null, dependantCount: 2,
    });
    expect(scope).toEqual({
      directoryId: 'owner',
      actorRole: 'owner',
      directoryIsDependant: false,
      subjectName: null,
      canManageFamily: true,
    });
  });

  it('hides the family manager when there are no dependants', () => {
    const scope = resolveContactsScope({
      signingMode: 'local', identityId: null, activeDependant: null, childModeNow: 'off', childDependantId: null, dependantCount: 0,
    });
    expect(scope.canManageFamily).toBe(false);
  });

  it('puts a guardian acting as a dependant in that dependant directory, tree-derived or imported alike', () => {
    const scope = resolveContactsScope({
      signingMode: 'local',
      identityId: null,
      activeDependant: { id: DEP, displayName: 'Sam' },
      childModeNow: 'off', childDependantId: null,
      dependantCount: 1,
    });
    expect(scope.directoryId).toBe(`dependant:${DEP}`);
    expect(scope.actorRole).toBe('guardian');
    expect(scope.directoryIsDependant).toBe(true);
    expect(scope.subjectName).toBe('Sam');
    // A dep-scoped surface is not the place to open the cross-family table.
    expect(scope.canManageFamily).toBe(false);
  });

  it('child mode makes the scoped dependant the actor: dependant directory, role dependant, no family manager', () => {
    const scope = resolveContactsScope({
      signingMode: 'local',
      identityId: null,
      activeDependant: { id: DEP, displayName: 'Sam' },
      childModeNow: 'on', childDependantId: DEP,
      dependantCount: 3,
    });
    expect(scope).toEqual({
      directoryId: `dependant:${DEP}`,
      actorRole: 'dependant',
      directoryIsDependant: true,
      subjectName: 'Sam',
      canManageFamily: false,
    });
  });

  it('child mode resolves to the same scope a paired-child install of that dependant gets', () => {
    const childMode = resolveContactsScope({
      signingMode: 'local', identityId: null, activeDependant: { id: DEP, displayName: 'Sam' },
      childModeNow: 'on', childDependantId: DEP, dependantCount: 1,
    });
    const paired = resolveContactsScope({
      signingMode: 'paired-child', identityId: DEP, activeDependant: null, childModeNow: 'off', childDependantId: null, dependantCount: 0,
    });
    expect({ ...childMode, subjectName: null }).toEqual(paired);
  });

  it('a guardian on a dependant row with child mode off is still the guardian (D2)', () => {
    const scope = resolveContactsScope({
      signingMode: 'local', identityId: null, activeDependant: { id: DEP, displayName: 'Sam' },
      childModeNow: 'off', childDependantId: null, dependantCount: 3,
    });
    expect(scope.actorRole).toBe('guardian');
    expect(scope.directoryId).toBe(`dependant:${DEP}`);
    expect(scope.canManageFamily).toBe(false);
  });

  it('child mode with no resolved child (saved-session window, lock flash) idles: directory null, never owner', () => {
    for (const childModeNow of ['on', 'unknown'] as const) {
      const noDependant = resolveContactsScope({
        signingMode: 'local', identityId: null, activeDependant: null,
        childModeNow, childDependantId: null, dependantCount: 2,
      });
      expect(noDependant.directoryId).toBeNull();
      expect(noDependant.actorRole).toBe('dependant');
      expect(noDependant.canManageFamily).toBe(false);
    }
  });

  it('an unknown child-mode state is treated as child mode even with a dependant row scoped', () => {
    const scope = resolveContactsScope({
      signingMode: 'local', identityId: null, activeDependant: { id: DEP, displayName: 'Sam' },
      childModeNow: 'unknown', childDependantId: null, dependantCount: 2,
    });
    expect(scope.directoryId).toBeNull();
    expect(scope.canManageFamily).toBe(false);
  });

  it('child mode never lands on a dependant who is not the child (stale scope)', () => {
    const scope = resolveContactsScope({
      signingMode: 'local', identityId: null, activeDependant: { id: DEP, displayName: 'Sam' },
      childModeNow: 'on', childDependantId: KID, dependantCount: 2,
    });
    expect(scope.directoryId).toBeNull();
  });

  it('matches the child id case-insensitively', () => {
    const scope = resolveContactsScope({
      signingMode: 'local', identityId: null, activeDependant: { id: DEP.toUpperCase(), displayName: 'Sam' },
      childModeNow: 'on', childDependantId: DEP, dependantCount: 2,
    });
    expect(scope.directoryId).toBe(`dependant:${DEP}`);
    expect(scope.actorRole).toBe('dependant');
  });

  it('resolves a paired-child install to its own dependant directory, matching the guardian device', () => {
    const scope = resolveContactsScope({
      signingMode: 'paired-child', identityId: KID, activeDependant: null, childModeNow: 'off', childDependantId: null, dependantCount: 0,
    });
    expect(scope.directoryId).toBe(`dependant:${KID}`);
    expect(scope.actorRole).toBe('dependant');
    expect(scope.directoryIsDependant).toBe(true);
    expect(scope.canManageFamily).toBe(false);
  });

  it('keeps a paired-child scoped to its own identity even if a dependant record is active', () => {
    const scope = resolveContactsScope({
      signingMode: 'paired-child',
      identityId: KID,
      activeDependant: { id: DEP, displayName: 'Sam' },
      childModeNow: 'off', childDependantId: null,
      dependantCount: 1,
    });
    expect(scope.actorRole).toBe('dependant');
    expect(scope.directoryId).toBe(`dependant:${KID}`);
  });

  it('yields null directoryId for unresolvable paired-child with null or empty identity', () => {
    // null case
    const scopeNull = resolveContactsScope({
      signingMode: 'paired-child', identityId: null, activeDependant: null, childModeNow: 'off', childDependantId: null, dependantCount: 0,
    });
    expect(scopeNull.directoryId).toBe(null);
    expect(scopeNull.actorRole).toBe('dependant');
    expect(scopeNull.directoryIsDependant).toBe(true);
    expect(scopeNull.canManageFamily).toBe(false);

    // empty string case
    const scopeEmpty = resolveContactsScope({
      signingMode: 'paired-child', identityId: '', activeDependant: null, childModeNow: 'off', childDependantId: null, dependantCount: 0,
    });
    expect(scopeEmpty.directoryId).toBe(null);

    // whitespace-only case
    const scopeWhitespace = resolveContactsScope({
      signingMode: 'paired-child', identityId: '  \t\n', activeDependant: null, childModeNow: 'off', childDependantId: null, dependantCount: 0,
    });
    expect(scopeWhitespace.directoryId).toBe(null);
  });
});

describe('scopeEffectiveContext', () => {
  it('carries the guardian list and ceiling onto a dependant directory', () => {
    const scope = resolveContactsScope({
      signingMode: 'local',
      identityId: null,
      activeDependant: { id: DEP, displayName: 'Lily' },
      childModeNow: 'off', childDependantId: null,
      dependantCount: 1,
    });
    expect(scopeEffectiveContext(scope, [GUARDIAN], 'ken')).toEqual({
      activeGuardianPubkeys: [GUARDIAN],
      defaultChildCeiling: 'ken',
      directoryIsDependant: true,
    });
  });

  it('lowercases and de-duplicates the guardian list', () => {
    const scope = resolveContactsScope({
      signingMode: 'local', identityId: null, activeDependant: null, childModeNow: 'off', childDependantId: null, dependantCount: 0,
    });
    const ctx = scopeEffectiveContext(scope, [GUARDIAN.toUpperCase(), GUARDIAN, ''], 'kith');
    expect(ctx.activeGuardianPubkeys).toEqual([GUARDIAN]);
    expect(ctx.directoryIsDependant).toBe(false);
  });
});

describe('familyLogNeeded', () => {
  const ownerScope = () => resolveContactsScope({
    signingMode: 'local', identityId: null, activeDependant: null, childModeNow: 'off', childDependantId: null, dependantCount: 2,
  });
  const ownerScopeNoDependants = () => resolveContactsScope({
    signingMode: 'local', identityId: null, activeDependant: null, childModeNow: 'off', childDependantId: null, dependantCount: 0,
  });
  // A guardian who picked a dependant's row WITHOUT child mode (D2): the guardian
  // is still the actor, `activeDependant` is set, `canManageFamily` is false.
  // (Child mode itself is the dependant acting and never needs the family log.)
  const guardianChildModeScope = () => resolveContactsScope({
    signingMode: 'local',
    identityId: null,
    activeDependant: { id: DEP, displayName: 'Sam' },
    childModeNow: 'off', childDependantId: null,
    dependantCount: 1,
  });
  const pairedChildScope = () => resolveContactsScope({
    signingMode: 'paired-child', identityId: KID, activeDependant: null, childModeNow: 'off', childDependantId: null, dependantCount: 0,
  });

  it('family-contacts: needs the log only when unlocked AND the owner can manage the family — personaAdvancedForDependant is irrelevant', () => {
    expect(familyLogNeeded('family-contacts', ownerScope(), true, false)).toBe(true);
    expect(familyLogNeeded('family-contacts', ownerScope(), true, true)).toBe(true);
    expect(familyLogNeeded('family-contacts', ownerScope(), false, false)).toBe(false);
    expect(familyLogNeeded('family-contacts', ownerScopeNoDependants(), true, false)).toBe(false);
    expect(familyLogNeeded('family-contacts', guardianChildModeScope(), true, false)).toBe(false);
    expect(familyLogNeeded('family-contacts', pairedChildScope(), true, false)).toBe(false);
  });

  it('persona-advanced: needs the log for a guardian actor ONLY when this visit is actually for a dependant slot — unlockedness is irrelevant', () => {
    // activeDependant set (a dependant's slot is being managed)
    // AND this visit is for that dependant (`personaAdvancedForDependant`)
    // must resolve true, even though canManageFamily is false here — this is
    // the case the App.tsx bug disabled the log for.
    expect(familyLogNeeded('persona-advanced', guardianChildModeScope(), false, true)).toBe(true);

    // N2: a STALE `activeDependant` (leftover from having been dependant-
    // scoped a moment ago) must NOT enable the log for an owner-slot visit —
    // `personaAdvancedForDependant: false` (no depPubkey on THIS route) wins
    // over `scope.actorRole === 'guardian'` reading true off the stale state.
    expect(familyLogNeeded('persona-advanced', guardianChildModeScope(), false, false)).toBe(false);

    expect(familyLogNeeded('persona-advanced', ownerScope(), false, true)).toBe(false);
    expect(familyLogNeeded('persona-advanced', ownerScope(), false, false)).toBe(false);
    expect(familyLogNeeded('persona-advanced', pairedChildScope(), false, true)).toBe(false);
  });

  it('transition-ceremony: needs the log for a guardian actor (always dependant-scoped in practice), never for paired-child — personaAdvancedForDependant is irrelevant', () => {
    expect(familyLogNeeded('transition-ceremony', ownerScope(), false, false)).toBe(false);
    expect(familyLogNeeded('transition-ceremony', guardianChildModeScope(), false, false)).toBe(true);
    expect(familyLogNeeded('transition-ceremony', guardianChildModeScope(), false, true)).toBe(true);
    expect(familyLogNeeded('transition-ceremony', pairedChildScope(), false, false)).toBe(false);
  });

  it('every other page never needs the log', () => {
    expect(familyLogNeeded('home', ownerScope(), true, false)).toBe(false);
    expect(familyLogNeeded('settings', guardianChildModeScope(), true, true)).toBe(false);
  });
});

describe('familyLogEnabled', () => {
  const KEY = 'unlock-key';
  const ownerScope = () => resolveContactsScope({
    signingMode: 'local', identityId: null, activeDependant: null, childModeNow: 'off', childDependantId: null, dependantCount: 2,
  });
  const guardianChildModeScope = () => resolveContactsScope({
    signingMode: 'local',
    identityId: null,
    activeDependant: { id: DEP, displayName: 'Sam' },
    childModeNow: 'off', childDependantId: null,
    dependantCount: 1,
  });
  const pairedChildScope = () => resolveContactsScope({
    signingMode: 'paired-child', identityId: KID, activeDependant: null, childModeNow: 'off', childDependantId: null, dependantCount: 0,
  });

  it('requires an unlock key on top of familyLogNeeded, matching the call site\'s original expression', () => {
    expect(familyLogEnabled(null, 'family-contacts', ownerScope(), true, undefined)).toBe(false);
    expect(familyLogEnabled(KEY, 'family-contacts', ownerScope(), true, undefined)).toBe(true);
    expect(familyLogEnabled(KEY, 'family-contacts', ownerScope(), false, undefined)).toBe(false);
  });

  it('is never enabled on a paired-child install, regardless of page or unlock', () => {
    expect(familyLogEnabled(KEY, 'family-contacts', pairedChildScope(), true, undefined)).toBe(false);
    expect(familyLogEnabled(KEY, 'persona-advanced', pairedChildScope(), true, 'dep-pubkey')).toBe(false);
    expect(familyLogEnabled(KEY, 'transition-ceremony', pairedChildScope(), true, undefined)).toBe(false);
  });

  it('a stale activeDependantId does not enable the log for an owner-slot persona-advanced visit', () => {
    // guardianChildModeScope's actorRole reads 'guardian' (leftover from a
    // prior dependant-scoped visit), but this visit's own depPubkey is unset.
    expect(familyLogEnabled(KEY, 'persona-advanced', guardianChildModeScope(), false, undefined)).toBe(false);
    expect(familyLogEnabled(KEY, 'persona-advanced', guardianChildModeScope(), false, DEP)).toBe(true);
  });
});

describe('dependantIdsMissingChildSettings', () => {
  it('returns ids with no loaded row', () => {
    expect(dependantIdsMissingChildSettings(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
  });

  it('returns nothing once every id is loaded', () => {
    expect(dependantIdsMissingChildSettings(['a', 'b'], ['a', 'b', 'c'])).toEqual([]);
  });

  it('returns everything when nothing is loaded yet', () => {
    expect(dependantIdsMissingChildSettings(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});

describe('contactsScopeActorPubkey', () => {
  const NP = '1'.repeat(64);
  it('is the guardian actor pubkey outside child mode', () => {
    expect(contactsScopeActorPubkey({ childModeNow: 'off', childDependantId: null, isPairedChild: false, actorPubkey: NP })).toBe(NP);
  });
  it('is the child id, lowercased, in child mode', () => {
    expect(contactsScopeActorPubkey({ childModeNow: 'on', childDependantId: DEP.toUpperCase(), isPairedChild: false, actorPubkey: NP })).toBe(DEP);
  });
  it('is empty (no actor, no writes) when child mode has no resolved child or is unknown', () => {
    expect(contactsScopeActorPubkey({ childModeNow: 'on', childDependantId: null, isPairedChild: false, actorPubkey: NP })).toBe('');
    expect(contactsScopeActorPubkey({ childModeNow: 'unknown', childDependantId: DEP, isPairedChild: false, actorPubkey: NP })).toBe('');
  });
  it('is untouched on a paired-child install, whatever the saved child-mode state says', () => {
    expect(contactsScopeActorPubkey({ childModeNow: 'unknown', childDependantId: null, isPairedChild: true, actorPubkey: KID })).toBe(KID);
  });
});
