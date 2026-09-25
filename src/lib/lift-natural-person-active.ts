import type { SignetIdentity, DependantIdentity } from '../types';
import { isNaturalPersonActive, isDependantNaturalPersonActive } from './identity-display';

/**
 * Derive `naturalPersonActive` for records written before the field existed.
 *
 * Runs on every decrypt inside `useIdentity.loadAll`, next to
 * `liftPublicProfileConfig` — same contract: pure, idempotent, returns the
 * input by reference when there is nothing to do, never mutates.
 *
 * Rule (spec §3.2): `naturalPersonActive === undefined` ⇒
 * `naturalPerson.displayName.trim() !== ''`. Existing real-name users stay
 * active; Lite imports and nsec imports (empty NP display name) become dormant.
 */
export function liftNaturalPersonActive(identity: SignetIdentity): SignetIdentity {
  if (identity.naturalPersonActive !== undefined) return identity;
  return { ...identity, naturalPersonActive: isNaturalPersonActive(identity) };
}

/**
 * Dependant flavour of the §3.2 lift. Runs on every decrypt inside
 * `useDependants.migrateAndSort`, next to `liftDependantPublicProfileConfig` —
 * pure, idempotent, returns the input by reference when there is nothing to do.
 */
export function liftDependantNaturalPersonActive(dep: DependantIdentity): DependantIdentity {
  if (dep.naturalPersonActive !== undefined) return dep;
  return { ...dep, naturalPersonActive: isDependantNaturalPersonActive(dep) };
}
