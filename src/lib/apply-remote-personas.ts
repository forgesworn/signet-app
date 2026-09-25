/**
 * Pure part of `useIdentity`'s `applyRemotePersonas` bulk write (personas
 * sync rail). Factored out of the hook so the two invariants that actually
 * matter — local private keys are never clobbered by a keyless remote, and
 * the professional slot's `updatedAt` is stamped with EXACTLY the remote's
 * value rather than "now" — are testable without React or IndexedDB.
 *
 * The hook keeps the I/O: decrypt the identity, call this, re-encrypt.
 */

import type { RemotePersonasPatch, SignetIdentity } from '../types';

/**
 * Apply a merged personas patch to a decrypted identity, returning the
 * record to persist.
 *
 * - `extraPersonas` is a full replacement list, already merged and ordered
 *   by `mergePersonas`. An incoming persona with `privateKey === ''` for a
 *   `derivationName` that exists locally with a non-empty key keeps the
 *   local key (same idea as dependants-sync's `preserveLocalPrivateKey`) —
 *   a keyless receiver's wire record must never strip real key material.
 * - `professional` (name + stamp, one pair) updates an existing local
 *   professional persona; when the local identity has none, the slot is
 *   CONJURED from `patch.professionalSlot` if the caller supplied one (a
 *   restored device that never opened the Pro surface still holds the
 *   other device's Pro name, and would otherwise publish a record with no
 *   `professional` block at all and destroy that backup). Either way the
 *   stamp written is the remote's own `updatedAt`, never `Date.now()`, so a
 *   third device comparing stamps sees the same LWW ordering this device
 *   saw. With no local slot and no `professionalSlot`, the rename is
 *   dropped — better nothing than a slot with no key behind it.
 * - `naturalPersonDisplayName` names the real-identity slot, and ONLY when the
 *   freshly-decrypted record has no name of its own. The merge already applied
 *   that rule against a React snapshot; re-checking it here against the record
 *   actually being written is what makes "a remote record can never rename your
 *   real identity" true rather than merely likely.
 */
export function applyRemotePersonasPatch(
  decrypted: SignetIdentity,
  patch: RemotePersonasPatch,
): SignetIdentity {
  const localByDerivationName = new Map(
    (decrypted.extraPersonas ?? [])
      .filter((p) => p.derivationName)
      .map((p) => [p.derivationName, p] as const),
  );

  const extraPersonas = patch.extraPersonas.map((remote) => {
    if (remote.privateKey !== '') return remote;
    const local = localByDerivationName.get(remote.derivationName);
    if (local && local.privateKey !== '') {
      return { ...remote, privateKey: local.privateKey };
    }
    return remote;
  });

  return {
    ...decrypted,
    extraPersonas,
    extraPersonaTombstones: patch.tombstones,
    ...(patch.naturalPersonActive ? { naturalPersonActive: true as const } : {}),
    ...naturalPersonNamePatch(decrypted, patch),
    ...professionalPatch(decrypted, patch),
  };
}

function professionalPatch(
  decrypted: SignetIdentity,
  patch: RemotePersonasPatch,
): Pick<SignetIdentity, 'professionalPersona'> | Record<string, never> {
  if (!patch.professional) return {};
  const { displayName, updatedAt } = patch.professional;
  if (decrypted.professionalPersona) {
    return { professionalPersona: { ...decrypted.professionalPersona, displayName, updatedAt } };
  }
  if (patch.professionalSlot) {
    return { professionalPersona: { ...patch.professionalSlot, displayName, updatedAt } };
  }
  return {};
}

function naturalPersonNamePatch(
  decrypted: SignetIdentity,
  patch: RemotePersonasPatch,
): Pick<SignetIdentity, 'naturalPerson'> | Record<string, never> {
  if (!patch.naturalPersonDisplayName) return {};
  if (decrypted.naturalPerson.displayName.trim() !== '') return {};
  return {
    naturalPerson: { ...decrypted.naturalPerson, displayName: patch.naturalPersonDisplayName },
  };
}
