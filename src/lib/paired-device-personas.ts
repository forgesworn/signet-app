/**
 * Which of a dependant's personas may go to the paired child's phone — ONE
 * rule, shared by everything the guardian sends there: the pairing reply and
 * the rules rail's `personas` (`replyPersonas`), the persona inventory
 * (`usePersonaInventoryPublisher`) and the contact directory's persona list
 * (`childDirectoryPersonas`). They must agree: a persona the inventory sends
 * but the rules omit is a card with no route, and one the rules allow but the
 * inventory drops comes back on the next inventory.
 *
 * Refused:
 * - a soft-deleted extra (`ExtraPersona.hidden`);
 * - a persona removed from the phone (`childDevice.removedPersonas`, A51 —
 *   `revoke_client_identity` on the Heartwood);
 * - a key hidden from the paired device (`hiddenOnPairedDeviceKeys`).
 *
 * The bound persona of a child-direct pairing is never refused (A51: unpair,
 * not removal, is how it goes). It is `childDevice.boundPersona`; a caller
 * building the reply for a pairing not yet saved passes the persona the slot
 * is about to bind. Whether the real identity is active is a slot rule, not a
 * key rule — callers check it before asking.
 */
import type { DependantIdentity } from '../types';

export function pairedDeviceAllows(
  dep: Pick<DependantIdentity, 'hiddenOnPairedDeviceKeys' | 'childDevice'>,
  boundPersona: string | null | undefined = dep.childDevice?.boundPersona,
): (pubkey: string | undefined, softDeleted?: boolean) => boolean {
  const lower = (keys: readonly string[] | undefined) => new Set((keys ?? []).map(k => k.toLowerCase()));
  const hidden = lower(dep.hiddenOnPairedDeviceKeys);
  const removed = lower(dep.childDevice?.removedPersonas);
  const bound = (boundPersona ?? '').toLowerCase();
  return (pubkey, softDeleted = false) => {
    const p = (pubkey ?? '').toLowerCase();
    if (!p) return false;
    if (bound && p === bound) return true;
    return !softDeleted && !hidden.has(p) && !removed.has(p);
  };
}
