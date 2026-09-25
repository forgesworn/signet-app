import type { SignetIdentity } from '../types';
import { isValidHexKey, validateMnemonic } from './signet';
import { LocalSigningBackend, createLocalBackends } from './signing-backend';

/**
 * Resolve a {@link LocalSigningBackend} for one of the guardian's OWN keypairs
 * (`natural-person`, the built-in `persona`, or an extra-persona's public key)
 * from a **decrypted** identity.
 *
 * Centralises the key derivation that `handleApproveAuth` and
 * `handleApproveConnect` both perform, so the two approval paths can't drift.
 *
 * Returns `null` when the key material isn't available — either the identity is
 * still in its public-only (`encrypted: true`) form, or the selected slot has
 * no matching private key. Callers MUST treat `null` as "re-acquire auth and
 * fresh-decrypt the identity, then retry"; if it still fails, report missing or
 * mismatched keys. The app
 * auto-locks (the inactivity timer, or the 30s visibility-hidden grace timer)
 * and reverts `identity` to public-only while an approval screen is still open,
 * so `null` here routinely means "locked", not "broken".
 *
 * @param keypairType `'natural-person'` | `'persona'` | an extra-persona's hex `publicKey`.
 */
export function resolveGuardianBackend(
  keypairType: string,
  identity: SignetIdentity,
): LocalSigningBackend | null {
  // Public-only identity — no private keys to sign with.
  if (identity.encrypted) return null;

  const isNP = keypairType === 'natural-person';
  const isBuiltInPersona = keypairType === 'persona';
  const slot = isNP ? identity.naturalPerson : isBuiltInPersona ? identity.persona
    : identity.extraPersonas?.find(e => e.publicKey === keypairType);
  if (!slot || !isValidHexKey(slot.publicKey)) return null;

  function matching(backend: LocalSigningBackend): LocalSigningBackend | null {
    if (backend.activePublicKeyHex === slot!.publicKey.toLowerCase()) return backend;
    backend.destroy();
    return null;
  }

  if (isValidHexKey(slot.privateKey)) {
    return matching(new LocalSigningBackend(slot.privateKey));
  }

  // Older single-key imports may use the same public identity in both slots.
  // Never substitute the real-name key for a distinct persona.
  if (isBuiltInPersona && slot.publicKey === identity.naturalPerson.publicKey
    && isValidHexKey(identity.naturalPerson.privateKey)) {
    return matching(new LocalSigningBackend(identity.naturalPerson.privateKey));
  }

  if ((isNP || isBuiltInPersona) && identity.mnemonic && validateMnemonic(identity.mnemonic)) {
    const derived = createLocalBackends(identity.mnemonic);
    const chosen = isBuiltInPersona ? derived.persona : derived.naturalPerson;
    (isBuiltInPersona ? derived.naturalPerson : derived.persona).destroy();
    derived.professional.destroy();
    return matching(chosen);
  }

  return null;
}

/** Refuse a stale or wrongly routed signer before it performs an approval. */
export function assertSigningIdentity(
  backend: { activePublicKeyHex: string },
  expectedPubkey: string | null,
): void {
  if (!expectedPubkey || !isValidHexKey(expectedPubkey)
    || backend.activePublicKeyHex.toLowerCase() !== expectedPubkey.toLowerCase()) {
    throw new Error('The signing key does not match this identity. Reconnect its signer or restore this identity before trying again.');
  }
}

/** Known signing routes, including keys that can be unlocked on this device. */
export function guardianSigningPubkeys(
  identity: SignetIdentity,
  options: { localIdentity: boolean; routedSigner: boolean; externalPubkey?: string },
): string[] {
  const slots = [
    { ...identity.naturalPerson, imported: false, hidden: false },
    { ...identity.persona, imported: false, hidden: false },
    ...(identity.extraPersonas ?? []),
  ];
  return slots.filter(slot => {
    if (slot.hidden || !isValidHexKey(slot.publicKey)) return false;
    if (options.localIdentity || (!identity.encrypted && isValidHexKey(slot.privateKey))) return true;
    // Imported keys remain local after migration and in a locked public record.
    if (slot.imported) return !!identity.encrypted;
    return options.routedSigner || slot.publicKey === options.externalPubkey;
  }).map(slot => slot.publicKey);
}

/**
 * The guardian slots an approval picker offers, and which of them are only
 * WAITING. In bunker mode a device-held slot (key on the paired signer) stays
 * listed while the per-persona router is down — locked, reconnecting, probing
 * — because the router is torn down on every lock by design; dropping those
 * slots made the picker shrink to the locally-keyed ones and the default
 * silently move onto a different persona. They are marked waiting until the
 * route is back (or the bounded wait lapses). A signer that answered it cannot
 * route personas (generic bunker) keeps the old NP-only listing.
 */
export function approvalGuardianPubkeys(
  identity: SignetIdentity,
  o: {
    signingMode: string | undefined;
    unlocked: boolean;
    routerReady: boolean;
    routerUnsupported: boolean;
    routeWaitLapsed: boolean;
    externalPubkey?: string;
  },
): { listed: string[]; waiting: string[] } {
  const localIdentity = !o.signingMode || o.signingMode === 'local';
  // Both route slots over a paired signer whose router is torn down on lock
  // and rebuilt after reconnect: a paired-child install routes its own
  // non-NP slots the same way.
  const bunker = o.signingMode === 'bunker' || o.signingMode === 'paired-child';
  const listed = guardianSigningPubkeys(identity, {
    localIdentity,
    routedSigner: o.routerReady || (bunker && !o.routerUnsupported),
    externalPubkey: o.externalPubkey,
  });
  if (!bunker || o.routeWaitLapsed) return { listed, waiting: [] };
  const ready = new Set(guardianSigningPubkeys(identity, {
    localIdentity,
    routedSigner: o.routerReady && o.unlocked,
    externalPubkey: o.externalPubkey,
  }));
  return { listed, waiting: listed.filter(pubkey => !ready.has(pubkey)) };
}

export function isImportedGuardianPersona(identity: SignetIdentity | null, keypair: string | undefined): boolean {
  return !!identity?.extraPersonas?.find(slot => slot.publicKey === keypair)?.imported;
}
