/**
 * Helpers that resolve a picked AuthSelection to the underlying
 * keypair's display name / pubkey / token. Used by ApproveAuth
 * (both viewport modes) to feed <SharePreview> — kept here so the
 * resolution logic can never drift apart.
 */

import type { AuthSelection } from '../pages/ApproveAuth';
import type { SignetIdentity, DependantIdentity, KeypairToken, PersonaPublicProfile } from '../types';
import type { KeypairOption } from './keypair-policy';
import { isNaturalPersonActive, isDependantNaturalPersonActive } from './identity-display';
import { resolveDependantCardSlot } from './carousel-utils';

/**
 * Display-ready view of the picked slot's kind-0 publish state. The
 * `displayName` etc. come from the slot itself (source-of-truth post
 * persona-card refactor); `enabled` + `lastEventId/At/Relay` come from
 * the slot's `publicProfile` state-only block.
 */
export interface SelectedPublicProfile {
  enabled: boolean;
  displayName: string;
  pictureUrl?: string;
  about?: string;
  nip05?: string;
  lastEventId?: string;
  lastPublishedAt?: number;
  lastPublishedRelay?: string;
}

/** Subset of DependantIdentity fields we need for selection resolution. */
type DepLite = Pick<
  DependantIdentity,
  'id' | 'naturalPerson' | 'persona' | 'extraPersonas' | 'displayName' | 'dateOfBirth' | 'primaryKeypair'
>;

export function resolveSelectedDisplayName(
  sel: AuthSelection | null,
  identity: SignetIdentity,
  dependants?: ReadonlyArray<DepLite>,
): string | null {
  if (!sel) return null;
  if (sel.source === 'guardian') {
    if (sel.keypairType === 'natural-person') return identity.naturalPerson.displayName || null;
    if (sel.keypairType === 'persona') return identity.persona.displayName || null;
    const ep = (identity.extraPersonas ?? []).find(p => p.publicKey === sel.keypairType);
    return ep?.displayName || null;
  }
  const dep = dependants?.find(d => d.id === sel.dependantId);
  if (!dep) return null;
  if (sel.keypairType === 'natural-person') return dep.naturalPerson.displayName || null;
  if (sel.keypairType === 'persona') return dep.persona.displayName || null;
  const ep = (dep.extraPersonas ?? []).find(p => p.publicKey === sel.keypairType);
  return ep?.displayName || null;
}

export function resolveSelectedToken(sel: AuthSelection | null): KeypairToken | null {
  if (!sel) return null;
  if (sel.keypairType === 'natural-person') return 'natural-person';
  if (sel.keypairType === 'persona') return 'persona';
  return 'extra-persona';
}

export function resolveSelectedPubkey(
  sel: AuthSelection | null,
  identity: SignetIdentity,
  dependants?: ReadonlyArray<DepLite>,
): string | null {
  if (!sel) return null;
  if (sel.source === 'guardian') {
    if (sel.keypairType === 'natural-person') return identity.naturalPerson.publicKey;
    if (sel.keypairType === 'persona') return identity.persona.publicKey || null;
    return sel.keypairType;
  }
  const dep = dependants?.find(d => d.id === sel.dependantId);
  if (!dep) return null;
  if (sel.keypairType === 'natural-person') return dep.naturalPerson.publicKey;
  if (sel.keypairType === 'persona') return dep.persona.publicKey || null;
  return sel.keypairType;
}

/**
 * Resolve the publicProfile state for the picked auth-selection slot. Used by
 * the §6.8 sign-in correlation hint in `ApproveAuth` — when this returns a
 * profile with `.enabled === true`, the picker renders a row warning the
 * user that the consumer site can look up their kind-0 on Nostr.
 *
 * Returns `null` when the selection doesn't map to any slot, or `undefined`
 * when the slot exists but has no publicProfile (which renders identically
 * to enabled=false in the UI — no hint).
 */
export function resolveSelectedPublicProfile(
  sel: AuthSelection | null,
  identity: SignetIdentity,
  dependants?: ReadonlyArray<DepLite>,
): SelectedPublicProfile | undefined | null {
  if (!sel) return null;
  function buildFromSlot(slot: {
    displayName: string;
    about?: string;
    pictureUrl?: string;
    nip05?: string;
    publicProfile?: PersonaPublicProfile;
  }): SelectedPublicProfile | undefined {
    const pp = slot.publicProfile;
    if (!pp) return undefined;
    return {
      enabled: pp.enabled,
      displayName: slot.displayName,
      pictureUrl: slot.pictureUrl,
      about: slot.about,
      nip05: slot.nip05,
      lastEventId: pp.lastEventId,
      lastPublishedAt: pp.lastPublishedAt,
      lastPublishedRelay: pp.lastPublishedRelay,
    };
  }

  if (sel.source === 'guardian') {
    if (sel.keypairType === 'natural-person') return buildFromSlot(identity.naturalPerson);
    if (sel.keypairType === 'persona') return buildFromSlot(identity.persona);
    const ep = (identity.extraPersonas ?? []).find(p => p.publicKey === sel.keypairType);
    return ep ? buildFromSlot(ep) : null;
  }
  const dep = dependants?.find(d => d.id === sel.dependantId);
  if (!dep) return null;
  if (sel.keypairType === 'natural-person') return buildFromSlot(dep.naturalPerson);
  if (sel.keypairType === 'persona') return buildFromSlot(dep.persona);
  const ep = (dep.extraPersonas ?? []).find(p => p.publicKey === sel.keypairType);
  return ep ? buildFromSlot(ep) : null;
}

/**
 * Build the guardian's sign-in / connect picker options in ring order.
 *
 * ONE builder for both approval screens — `ApproveAuth` (Sign in with Signet)
 * and `ApproveConnect` (`nostrconnect://`) had byte-identical copies of this
 * list, which is exactly the kind of duplication that lets a dormant real
 * identity leak back into one picker but not the other.
 *
 * Order matches the carousel (spec §5): persona → visible extras → natural
 * person. The natural person is included ONLY when activated — a dormant slot
 * has no name to show and must not be selectable at all (spec §6). Hidden
 * extras are soft-deleted by the user and are excluded here too.
 */
export function buildGuardianKeypairOptions(identity: SignetIdentity): KeypairOption[] {
  const options: KeypairOption[] = [];

  if (identity.persona.publicKey) {
    options.push({
      key: 'persona',
      token: 'persona',
      label: identity.persona.displayName || 'Persona',
      pubkey: identity.persona.publicKey,
    });
  }

  for (const ep of (identity.extraPersonas ?? []).filter(e => !e.hidden)) {
    options.push({
      key: ep.publicKey,
      token: 'extra-persona',
      label: ep.displayName || 'Persona',
      pubkey: ep.publicKey,
    });
  }

  if (identity.naturalPerson.publicKey && isNaturalPersonActive(identity)) {
    options.push({
      key: 'natural-person',
      token: 'natural-person',
      label: identity.naturalPerson.displayName || 'Real identity',
      pubkey: identity.naturalPerson.publicKey,
    });
  }

  return options;
}

/**
 * Build ONE dependant's sign-in / connect picker options.
 *
 * ONE builder for both approval screens — `ApproveAuth` and `ApproveConnect`
 * had byte-identical inline copies, the same duplication that let a dormant
 * real identity leak back into one picker but not the other.
 *
 * Base order is unchanged from the shipped inline lists (real identity,
 * built-in persona, unhidden extras), then the dependant's ACTING slot —
 * `resolveDependantCardSlot`, the same resolver the card and the bunker route
 * default use — is moved to the front. For an existing, active-NP dependant
 * the acting slot IS the real identity, so the list and `resolvePolicy`'s
 * ranking come out exactly as before. For a persona-first dependant the
 * persona leads even after activation, because activation does not move
 * `primaryKeypair` (spec §7.6) and the picker must not lead with a key the
 * child does not sign as.
 *
 * The other behavioural change: a DORMANT real identity contributes no option
 * at all (spec §6, §7.6), so a newly created dependant is only ever acted as,
 * or paired as, their persona.
 */
export function buildDependantKeypairOptions(
  dep: Pick<DependantIdentity, 'naturalPerson' | 'persona' | 'extraPersonas' | 'primaryKeypair' | 'naturalPersonActive'>,
): KeypairOption[] {
  const options: KeypairOption[] = [];

  if (dep.naturalPerson.publicKey && isDependantNaturalPersonActive(dep)) {
    options.push({
      key: 'natural-person',
      token: 'natural-person',
      label: dep.naturalPerson.displayName || 'Real identity',
      pubkey: dep.naturalPerson.publicKey,
    });
  }

  if (dep.persona.publicKey) {
    options.push({
      key: 'persona',
      token: 'persona',
      label: dep.persona.displayName || 'Persona',
      pubkey: dep.persona.publicKey,
    });
  }

  for (const ep of dep.extraPersonas ?? []) {
    if (ep.hidden) continue;
    options.push({
      key: ep.publicKey,
      token: 'extra-persona',
      label: ep.displayName || 'Extra Persona',
      pubkey: ep.publicKey,
    });
  }

  // Lead with the acting slot. Stable otherwise — the rest keep their order.
  const actingPubkey = resolveDependantCardSlot(dep).slot.publicKey;
  const actingAt = options.findIndex(o => o.pubkey === actingPubkey);
  if (actingAt > 0) options.unshift(...options.splice(actingAt, 1));

  return options;
}
