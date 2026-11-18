import type { SignetIdentity } from '../types';
import { isNaturalPersonActive } from './identity-display';

export interface CompanionGrantPersona {
  pubkey: string;
  label: string;
}

/**
 * The keys a companion-app grant may offer. The real identity only once it has
 * been activated (a dormant one is never shown anywhere), then the persona,
 * then every extra persona that is not hidden (the same soft-delete rule as
 * sign-in and connect).
 */
export function companionGrantPersonas(identity: SignetIdentity): CompanionGrantPersona[] {
  return [
    ...(isNaturalPersonActive(identity)
      ? [{ pubkey: identity.naturalPerson.publicKey, label: identity.naturalPerson.displayName || 'Natural Person' }]
      : []),
    ...(identity.persona.publicKey
      ? [{ pubkey: identity.persona.publicKey, label: identity.persona.displayName || 'Persona' }]
      : []),
    ...(identity.extraPersonas ?? [])
      .filter(ep => !ep.hidden)
      .map(ep => ({ pubkey: ep.publicKey, label: ep.displayName || 'Persona' })),
  ];
}
