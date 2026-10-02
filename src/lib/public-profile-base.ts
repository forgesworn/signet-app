/**
 * Resolution rule for a slot's device-local `publicProfileBase` when
 * `setPersonaPublicProfile` / `setDependantPersonaPublicProfile` write it
 * alongside the publication state (one atomic write, §5.1.3).
 *
 *   incoming object -> set it
 *   incoming null   -> clear it (a publish whose content was too big to store)
 *   incoming absent -> leave the stored one alone (a plain card save must
 *                      never drop the comparison base) — EXCEPT when the state
 *                      itself is being removed: a base only exists alongside a
 *                      published / matched profile, so none survives without one.
 */
import type { PersonaPublicProfile, PublicProfileBase } from '../types';

export function resolvePublicProfileBase(
  stored: PublicProfileBase | undefined,
  incoming: PublicProfileBase | null | undefined,
  state: PersonaPublicProfile | undefined,
): PublicProfileBase | undefined {
  if (incoming) return incoming;
  if (incoming === null) return undefined;
  return state ? stored : undefined;
}
