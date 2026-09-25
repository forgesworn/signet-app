import type { SignetIdentity, DependantIdentity, AppPreferences } from '../types';

/**
 * Which keypair the carousel focuses on app load.
 *
 * Always the persona (spec §5, §11): the anonymous identity is the default
 * everywhere, and the real identity must never be the incidental active row.
 * The `identity` parameter is kept so callers do not churn and so a future
 * per-identity landing rule has somewhere to live. When there is no persona
 * slot, `findRowForGuardianKeypair` falls back to row 0, which is then the
 * natural-person row.
 */
export function resolveLandingKeypair(_identity: SignetIdentity): string {
  return 'persona';
}

/**
 * Is the real-name (Natural Person) slot activated?
 *
 * The single read point for `SignetIdentity.naturalPersonActive`. Records
 * written before the field existed have it `undefined`; for those, fall back to
 * the same derivation the decrypt-time lift uses — a non-empty NP display name
 * means the user was already using their real name, so they stay active.
 */
export function isNaturalPersonActive(identity: SignetIdentity): boolean {
  return identity.naturalPersonActive ?? identity.naturalPerson.displayName.trim() !== '';
}

/**
 * Is a DEPENDANT's real-name slot activated? Same contract and same fallback
 * rule as `isNaturalPersonActive` for the owner (spec §3.2): a record written
 * before the field existed derives its answer from the NP display name, so
 * every existing dependant lifts to active and nothing about them moves.
 *
 * Takes the narrow `Pick` rather than the whole record so the approval screens,
 * whose `dependants` prop is already a projection, can call it without a cast.
 */
export function isDependantNaturalPersonActive(
  dep: Pick<DependantIdentity, 'naturalPerson' | 'naturalPersonActive'>,
): boolean {
  return dep.naturalPersonActive ?? dep.naturalPerson.displayName.trim() !== '';
}

/** Default-off: only an explicit `true` enables the blur, so existing
 *  preference records (no field) are NOT blurred. */
export function shouldBlurIdentity(prefs: AppPreferences): boolean {
  return prefs.blurIdentityNames === true;
}
