import type { DependantIdentity, SignetIdentity } from '../types';
import { isNaturalPersonActive, isDependantNaturalPersonActive } from './identity-display';

export interface ContactIdentityList { ownerIdentityPubkey: string; label: string }

/** Only identities belonging to this vault. Hidden personas still own their lists. */
export function contactIdentityLists(identity: SignetIdentity | null, dependant: DependantIdentity | null = null): ContactIdentityList[] {
  if (!identity) return [];
  const holder = dependant ?? identity;
  const active = holder.naturalPerson ? (dependant ? isDependantNaturalPersonActive(dependant) : isNaturalPersonActive(identity)) : false;
  const slots = [holder.persona,
    ...(holder.extraPersonas ?? []),
    ...(active || !holder.persona?.publicKey ? [holder.naturalPerson] : []),
    ...(!dependant && identity.professionalPersona ? [identity.professionalPersona] : []),
  ];
  const seen = new Set<string>();
  return slots.flatMap((slot) => {
    const key = slot?.publicKey?.toLowerCase();
    if (!key || !/^[0-9a-f]{64}$/.test(key) || seen.has(key)) return [];
    seen.add(key);
    return [{ ownerIdentityPubkey: key, label: slot?.displayName || `Identity ${key.slice(0, 8)}` }];
  });
}
