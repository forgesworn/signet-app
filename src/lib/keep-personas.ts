/**
 * Which persona does what for a Keep: who can sign (only a key this device
 * holds), what to call them, and which contacts they can invite.
 */
import type { EffectiveContact, SignetIdentity } from '../types';
import { contactBelongsToList } from './contacts-v2-membership';
import { contactIdentityLists } from './contacts-v2-identity-lists';
import { contactDisplayName } from './contacts-v2-name';
import { isVisibleContact } from './contacts-v2-list';
import { LocalSigningBackend } from './signing-backend';
import type { KeepDeps } from './keep-service';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * A signing backend for the persona with this public key, only when this
 * device holds its private key (an unlocked identity). A persona whose key
 * lives on a bunker or a Heartwood has an empty `privateKey`, so it gets
 * null: Keeps are not available for it yet.
 */
export function localBackendFor(identity: SignetIdentity | null, pubkey: string): LocalSigningBackend | null {
  if (!identity || identity.encrypted || !HEX64.test(pubkey)) return null;
  const slots = [
    identity.naturalPerson, identity.persona, identity.professionalPersona,
    ...(identity.extraPersonas ?? []),
  ];
  const slot = slots.find(s => s && s.publicKey?.toLowerCase() === pubkey);
  if (!slot || !HEX64.test(slot.privateKey ?? '')) return null;
  try {
    const backend = new LocalSigningBackend(slot.privateKey);
    if (backend.activePublicKeyHex !== pubkey) { backend.destroy(); return null; }
    return backend;
  } catch {
    return null;
  }
}

/** Whether `localBackendFor` would succeed, without building a backend. */
export function holdsKeyFor(identity: SignetIdentity | null, pubkey: string): boolean {
  if (!identity || identity.encrypted || !HEX64.test(pubkey)) return false;
  const slots = [
    identity.naturalPerson, identity.persona, identity.professionalPersona,
    ...(identity.extraPersonas ?? []),
  ];
  return slots.some(s => s && s.publicKey?.toLowerCase() === pubkey && HEX64.test(s.privateKey ?? ''));
}

/** Persona public key -> the name the person gave it. */
export function personaNameMap(identity: SignetIdentity | null): Record<string, string> {
  return Object.fromEntries(contactIdentityLists(identity).map(l => [l.ownerIdentityPubkey, l.label]));
}

export interface AccountPersona { pubkey: string; name: string; canSign: boolean }

/**
 * Every persona of the account, in the order the contact lists use, and whether
 * this device can sign for it. The same universe as the contact lists: the
 * persona, the extra personas, the real-name persona when activated, the
 * professional one. A dependant's personas belong to the dependant's own record
 * and are never in it, so a Keep is never linked to a child's persona.
 */
export function accountPersonas(identity: SignetIdentity | null): AccountPersona[] {
  return contactIdentityLists(identity).map(l => ({
    pubkey: l.ownerIdentityPubkey, name: l.label, canSign: holdsKeyFor(identity, l.ownerIdentityPubkey),
  }));
}

/** What the Keep service needs of this account: keys from the unlocked identity, and the personas an All-my-personas Keep links. */
export function keepDepsFor(identity: SignetIdentity | null, encryptionKey: string): KeepDeps {
  return {
    encryptionKey,
    backendFor: persona => localBackendFor(identity, persona),
    eligiblePersonas: () => accountPersonas(identity).filter(p => p.canSign).map(p => p.pubkey),
    personaName: persona => personaNameMap(identity)[persona] || `Persona ${persona.slice(0, 8)}`,
  };
}

export interface InviteCandidate {
  contactId: string;
  name: string;
  tier: 'kin' | 'kith';
  /** The contact's persona key an invite is bound to: the first identity listed. */
  persona: string;
}

/**
 * The contacts `owner` can invite: on the owner persona's own list, visible,
 * not blocked, effective tier Kin or Kith (one-way Ken contacts are left out)
 * and with a key. A contact with several personas gives the first one listed.
 */
export function inviteCandidates(contacts: readonly EffectiveContact[], owner: string): InviteCandidate[] {
  const out: InviteCandidate[] = [];
  for (const c of contacts) {
    if (!isVisibleContact(c) || c.lifecycle !== 'active' || c.blocked) continue;
    if (c.effectiveTier !== 'kin' && c.effectiveTier !== 'kith') continue;
    if (!contactBelongsToList(c, owner)) continue;
    const persona = c.identities[0]?.pubkey?.toLowerCase();
    if (!persona || !HEX64.test(persona) || persona === owner) continue;
    out.push({ contactId: c.contactId, name: contactDisplayName(c), tier: c.effectiveTier, persona });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
