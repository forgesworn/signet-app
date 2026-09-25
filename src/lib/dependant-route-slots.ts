import type { DependantIdentity } from '../types';
import { resolveDependantCardSlot, type DependantSlot } from './carousel-utils';
import { isDependantNaturalPersonActive } from './identity-display';

export interface DependantRouteSlots {
  /** The slot whose key signs when a NIP-46 request carries no explicit pubkey. */
  defaultSlot: DependantSlot;
  /**
   * Every slot the per-persona resolver may hand a backend for.
   *
   * Only slots that actually hold a private key are listed, so a caller can
   * build a `LocalSigningBackend` for each without relying on a throw. The
   * default slot is NOT force-added: when it is keyless, `defaultSlotSignable`
   * is `false` and the caller is expected to omit the route entirely rather
   * than serve a route whose default cannot sign.
   */
  addressableSlots: DependantSlot[];
  /**
   * Does `defaultSlot` hold a usable (64-hex) local private key?
   *
   * A standard NIP-46 client sends `sign_event` with no pubkey, so the default
   * slot is what actually signs; a route whose default cannot sign is a route
   * that answers `get_public_key` and then fails every signature. Callers must
   * check this BEFORE constructing any backend and skip the whole dependant
   * when it is `false` — previously that outcome depended on
   * `new LocalSigningBackend('')` happening to throw inside a try/catch, which
   * silently dropped the device route and the app route together.
   */
  defaultSlotSignable: boolean;
}

/** A local private key usable by `LocalSigningBackend`. */
function isUsablePrivateKey(privateKey: string | undefined): boolean {
  return !!privateKey && /^[0-9a-fA-F]{64}$/.test(privateKey);
}

/**
 * Which of a dependant's slots may the guardian's NIP-46 SERVER act as, and
 * which one does it default to? (spec §7.6, §8.)
 *
 * The default is the dependant's ACTING slot, resolved by the single shared
 * resolver `resolveDependantCardSlot` — the same answer the carousel card, the
 * gear-fab and `resolveSigningSelection` give. It follows `primaryKeypair`, not
 * activation: activating a persona-first dependant's real identity must NOT
 * flip the bunker default to the real-name key, or the child's pinned
 * `record.dependantPubkey` stops matching `get_public_key` ("Bunker pubkey
 * mismatch") and every template-without-pubkey `sign_event` silently signs
 * under the legal name (spec §7.6: "Activation does not change primaryKeypair,
 * so the child continues to land and sign as their handle").
 *
 * While the real identity is dormant the natural-person slot is NEVER the
 * default and NEVER addressable — there is no cross-slot fallback to the real
 * identity by construction, in either direction. Once activated it becomes
 * addressable (an explicit per-persona request may name it) but it only becomes
 * the default if it is also the primary.
 *
 * `null` is reserved for the case where the dependant record holds no private
 * key ANYWHERE — post-migration strip, or a record that never had one — so
 * there is nothing any caller could ever sign with for this dependant, local or
 * routed, and building a route object would be pointless. This check
 * deliberately ignores the activation gate: a dormant-but-keyed NP still means
 * the record is not fully keyless.
 */
export function resolveDependantRouteSlots(dep: DependantIdentity): DependantRouteSlots | null {
  const npUsable = !!dep.naturalPerson.publicKey && !!dep.naturalPerson.privateKey;
  const personaUsable = !!dep.persona.publicKey && !!dep.persona.privateKey;
  const extras = dep.extraPersonas ?? [];
  const anyExtraUsable = extras.some(ep => !!ep.publicKey && !!ep.privateKey);
  if (!npUsable && !personaUsable && !anyExtraUsable) return null;

  const npActive = isDependantNaturalPersonActive(dep);
  const defaultSlot = resolveDependantCardSlot(dep).slot;

  const addressableSlots: DependantSlot[] = [];
  if (npActive && npUsable) addressableSlots.push(dep.naturalPerson);
  if (personaUsable) addressableSlots.push(dep.persona);
  for (const ep of extras) {
    if (ep.publicKey && ep.privateKey) addressableSlots.push(ep);
  }
  return {
    defaultSlot,
    addressableSlots,
    defaultSlotSignable: isUsablePrivateKey(defaultSlot.privateKey),
  };
}
