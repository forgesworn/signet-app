// Present a stored `Contact` as kindred's mutual-tier view (KinEntry | KithEntry).
// ONE-WAY: storage stays Contact, so Contact-only fields (isChild,
// isDefaultForGroup) have no view representation and are never lost — they
// live on the Contact record. groupId/label become local-only annotations.
import type { Contact } from '../types';
import type { KinEntry, KithEntry, PrivateAnnotations } from '@forgesworn/kenspeckle';

/**
 * Sanitise a stored/synced timestamp into the non-negative safe integer
 * kenspeckle 0.2.0's `buildGrantEnvelope` requires for `addedAt`. A finite
 * fractional value is a legitimate timestamp that just isn't an integer, so
 * it is floored rather than dropped; `null` is returned only when no floor
 * can make it valid (NaN, +/-Infinity, negative, or too large to be a safe
 * integer).
 *
 * Both `contacts-sync.ts` (`verifiedAt`) and kenspeckle's own `parseEntry`
 * (`addedAt`, via `ken-sync.ts`) only require the value to be finite, which
 * lets exactly these bad values (a float, `-5`, `Infinity`) into local
 * storage from another device's payload. `buildGrantEnvelope` throws for the
 * WHOLE envelope over a single bad `addedAt`, so every envelope-building
 * path (`companion-rail.ts`'s `filterByScope`, which covers contacts AND
 * kens) sanitises through this function — never dropped upstream at the
 * display/adapter layer, where a garbage timestamp should still let the
 * user see and manage the record.
 */
export function sanitiseAddedAt(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  if (floored < 0 || !Number.isSafeInteger(floored)) return null;
  return floored;
}

/** Map a stored `Contact` onto its kindred view. Every contact maps — no
 *  dropping here; a contact whose `verifiedAt` can't be turned into a valid
 *  `addedAt` is still shown to the user (see `sanitiseAddedAt`'s doc
 *  comment) and is sanitised-or-dropped only at the envelope-building
 *  boundary (`companion-rail.ts`'s `filterByScope`). */
export function contactToKindredEntry(c: Contact): KinEntry | KithEntry {
  const annotations: PrivateAnnotations | undefined =
    c.groupId || c.label
      ? { ...(c.groupId ? { groupId: c.groupId } : {}), ...(c.label ? { label: c.label } : {}) }
      : undefined;
  const base = {
    pubkey: c.pubkey,
    ownerPubkey: c.ownerPubkey,
    displayName: c.displayName,
    addedAt: c.verifiedAt,
    sharedSecret: c.sharedSecret,
    verifiedAt: c.verifiedAt,
    ...(annotations ? { annotations } : {}),
  };
  return c.relationship
    ? ({ ...base, tier: 'kin', relationship: c.relationship } as KinEntry)
    : ({ ...base, tier: 'kith' } as KithEntry);
}
