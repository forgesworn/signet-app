// src/lib/persona-bunker-routes.ts
import type { BunkerRoute } from '../hooks/useBunkerServer';
import type { DecryptingSigningBackend } from './signing-backend';

/** One owner persona slot's keying material (NP/Persona/extra/Pro all share this shape). */
export interface OwnerPersonaSlot {
  publicKey: string;
  privateKey: string;
}

export interface OwnerPersonaRouteInputs {
  /**
   * Primary (Natural-Person) transport+signing backend — may be Heartwood /
   * NIP-07 / local. Null when no primary backend is available. The NP route is
   * built from this regardless of unlock state (it mirrors the existing
   * `bunkerBackendForServer` push, which has no `encryptionKey` guard).
   */
  primaryBackend: DecryptingSigningBackend | null;
  /**
   * The Natural Person's own serving backend, supplied ONLY when the real
   * identity is active (`isNaturalPersonActive`). Since the transport now
   * follows `primaryKeypair` (spec §8), `primaryBackend` is the persona on a
   * persona-primary install, and without this the NP would have no persistent
   * owner route at all — a client paired to the NP pubkey would find no route
   * after a reload. Dormant real identity ⇒ pass `null`, which is exactly the
   * pre-§8 behaviour for an unactivated identity. On an NP-primary install
   * this is the same backend as `primaryBackend` and the pubkey dedupe
   * collapses it to one route.
   *
   * Phase C residual: passing `null` here removes THIS route, not necessarily
   * every route bound to the NP pubkey. The guarantee is about the caller's
   * composition, not this function's: a dormant real identity is never the
   * PRIMARY keypair either (`resolveServerTransportBackend` follows
   * `primaryKeypair`, and activation is what sets it), so in practice no route
   * carries the NP pubkey while it is dormant. If a caller ever handed this a
   * `primaryBackend` bound to a dormant NP, the primary route would still be
   * built — this module routes what it is given and does not re-derive
   * activation.
   */
  naturalPersonBackend?: DecryptingSigningBackend | null;
  /** True once unlocked. The Persona / extra / Pro routes need decrypted keys. */
  unlocked: boolean;
  /** Default-Persona backend (from `createLocalBackends`). Null when unavailable. */
  personaBackend: DecryptingSigningBackend | null;
  /** Owner's extra personas. */
  extraPersonas?: ReadonlyArray<OwnerPersonaSlot>;
  /** Owner's professional persona slot, if present. */
  professionalPersona?: OwnerPersonaSlot | null;
}

/**
 * Build one guardian-shape NIP-46 route per owner persona (the primary slot,
 * the Natural Person when active, default Persona, each extra persona,
 * Professional). Each route is keyed by
 * the persona's pubkey and signs with that persona's own key — the bunker
 * server auto-routes an inbound request to the route whose key it targets, so
 * there is no "acting as" selector.
 *
 * `makeLocalBackend` is injected (rather than `new LocalSigningBackend(...)`
 * inline) so this routing logic is unit-testable without crypto; production
 * passes `(priv) => new LocalSigningBackend(priv)`. A factory that throws on a
 * malformed key causes that one persona to be skipped, never the whole set.
 *
 * Behaviour-equivalent to the previous inline block in `App.tsx`'s
 * `bunkerRoutes` memo (commit 082f3d3).
 */
export function buildOwnerPersonaRoutes(
  inputs: OwnerPersonaRouteInputs,
  makeLocalBackend: (privateKeyHex: string) => DecryptingSigningBackend,
): BunkerRoute[] {
  const { primaryBackend, naturalPersonBackend, unlocked, personaBackend, extraPersonas, professionalPersona } = inputs;
  const routes: BunkerRoute[] = [];

  // Primary route — the identity a generic pairing binds to (§8: the persona
  // for a persona-primary install, the natural person otherwise). Present
  // whenever a primary backend exists (no unlock guard; matches the existing
  // `bunkerBackendForServer` push).
  if (primaryBackend && primaryBackend.activePublicKeyHex) {
    routes.push({ pubkey: primaryBackend.activePublicKeyHex, backend: primaryBackend });
  }

  // Natural-Person route. Only reached on a persona-primary install with the
  // real identity ACTIVE — the caller passes `null` while it is dormant, and on
  // an NP-primary install this pubkey is already the primary route's. Same
  // no-unlock-guard rule as the primary route: the backend arrives ready-made.
  if (naturalPersonBackend?.activePublicKeyHex
    && !routes.some(r => r.pubkey.toLowerCase() === naturalPersonBackend.activePublicKeyHex.toLowerCase())) {
    routes.push({ pubkey: naturalPersonBackend.activePublicKeyHex, backend: naturalPersonBackend });
  }

  if (!unlocked) return routes;

  // Default-Persona route (guardian-shape: transport key === signing key).
  if (personaBackend) {
    const personaPub = personaBackend.activePublicKeyHex;
    if (personaPub && personaPub.toLowerCase() !== (primaryBackend?.activePublicKeyHex ?? '').toLowerCase()) {
      routes.push({ pubkey: personaPub, backend: personaBackend });
    }
  }

  // Extra-persona routes.
  for (const ep of extraPersonas ?? []) {
    if (!ep.privateKey || !ep.publicKey) continue;
    if (routes.some(r => r.pubkey.toLowerCase() === ep.publicKey.toLowerCase())) continue;
    try {
      routes.push({ pubkey: ep.publicKey, backend: makeLocalBackend(ep.privateKey) });
    } catch {
      // Malformed private key — skip this persona, keep the others.
    }
  }

  // Professional-persona route.
  if (professionalPersona?.privateKey && professionalPersona.publicKey) {
    const proPub = professionalPersona.publicKey;
    if (!routes.some(r => r.pubkey.toLowerCase() === proPub.toLowerCase())) {
      try {
        routes.push({ pubkey: proPub, backend: makeLocalBackend(professionalPersona.privateKey) });
      } catch {
        // Skip — pro persona is opt-in; NP/persona routes still work.
      }
    }
  }

  return routes;
}

/**
 * Owner persona routes are pubkey-keyed: the route's pubkey IS the signing
 * identity. A `sign_event` template that explicitly names a DIFFERENT pubkey
 * than the connection is bound to must be refused, so a client paired to
 * persona X can never obtain an event attributed to persona Y. A template with
 * no pubkey (the standard NIP-46 case — the bunker is bound to the identity)
 * signs as the route's persona and is NOT a mismatch.
 */
export function ownerRoutePubkeyMismatch(
  routePubkey: string,
  templatePubkey: string | undefined,
): boolean {
  if (!templatePubkey) return false;
  return templatePubkey.toLowerCase() !== routePubkey.toLowerCase();
}

/**
 * Owner-route gate for silent NIP-46 crypto methods (security audit 2026-06-15).
 *
 * Unlike `sign_event`, the bunker server has no approval-prompt path for
 * `nip04_*` / `nip44_*` — they are silent crypto operations. The owner route's
 * pubkey is public (it IS the user's persona pubkey), so without a gate any
 * relay client could send decrypt requests during an owner-serve window and
 * use the owner's key as a decryption oracle or an encryption oracle. We
 * therefore require the SAME bearer credential the silent `sign_event` path
 * requires — a `ConnectedClient` with `allowAlways: true`.
 *
 * Dependant/app routes (routeDependantId set) are exempt here because they run
 * their own autonomy-stage + charter + rate-limit policy gate before the
 * operation; this helper only governs owner (guardian / owner-persona) routes.
 */
export function ownerRouteNip44Authorised(
  routeDependantId: string | undefined,
  connectedClient: { allowAlways?: boolean } | null | undefined,
): boolean {
  if (routeDependantId) return true;
  return connectedClient?.allowAlways === true;
}
