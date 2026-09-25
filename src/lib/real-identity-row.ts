import type { SignetIdentity, DependantIdentity } from '../types';
import { isNaturalPersonActive, isDependantNaturalPersonActive } from './identity-display';

/** State of the Settings → Personas "Real identity" row. */
export type RealIdentityRowState =
  /** Activated — the row shows the legal name and opens the NP Advanced page. */
  | 'active'
  /** Key present, not activated — the row offers activation. */
  | 'dormant'
  /** No natural-person key exists at all (nsec import) — activation is not offered. */
  | 'unavailable';

/**
 * Spec §7.2 / §7.5.
 *
 * `unavailable` keys off the ABSENCE OF A KEY, not off the absence of a
 * mnemonic: an identity migrated onto a Heartwood has no local mnemonic but
 * still has a real-name key on the device, and activation only writes a name
 * plus the flag — it derives nothing. An nsec import into the persona slot is
 * the one shape with no natural-person key to name.
 */
export function resolveRealIdentityRow(identity: SignetIdentity): RealIdentityRowState {
  if (!identity.naturalPerson.publicKey) return 'unavailable';
  return isNaturalPersonActive(identity) ? 'active' : 'dormant';
}

/**
 * Dependant flavour of `resolveRealIdentityRow` (spec §7.6). Drives the
 * "Real identity" row in the dependant settings surface. `unavailable` keys off
 * the absence of a KEY — a view-only imported dependant has no NP key to name.
 */
export function resolveDependantRealIdentityRow(dep: DependantIdentity): RealIdentityRowState {
  if (!dep.naturalPerson.publicKey) return 'unavailable';
  return isDependantNaturalPersonActive(dep) ? 'active' : 'dormant';
}
