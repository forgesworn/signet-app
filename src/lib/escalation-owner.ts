/**
 * Whose ask an escalation notice is. The Heartwood holds a request back for
 * the phone on a dependant's slot (C4) and also, since Sapwood's "Approve from
 * my phone" switch, on any of the owner's own app pairings. The notice names
 * the identity the request would sign as, so that pubkey decides how the ask
 * is worded: a family member's name, the owner's own identity, or, when this
 * phone does not recognise it (a dependant not synced here yet), neither.
 */

export interface EscalationOwnerDependant {
  displayName: string;
  /** Every pubkey the dependant signs as: NP, persona, extra personas. */
  publicKeys: readonly string[];
}

export interface EscalationOwnerSelf {
  displayName: string;
  publicKey: string;
}

export type EscalationOwner =
  | { kind: 'family'; name: string }
  | { kind: 'self'; name: string }
  | { kind: 'unknown' };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Family wins over self, so a key somehow listed as both is never shown as the
 * owner's own (the wording that invites a quick approve). An unrecognised key
 * stays unknown rather than defaulting to "you" for the same reason.
 */
export function escalationOwner(
  identityPubkey: string,
  dependants: readonly EscalationOwnerDependant[],
  own: readonly EscalationOwnerSelf[],
): EscalationOwner {
  if (!identityPubkey) return { kind: 'unknown' };
  for (const dep of dependants) {
    if (dep.publicKeys.some((pk) => pk && same(pk, identityPubkey))) return { kind: 'family', name: dep.displayName };
  }
  for (const slot of own) {
    if (slot.publicKey && same(slot.publicKey, identityPubkey)) return { kind: 'self', name: slot.displayName };
  }
  return { kind: 'unknown' };
}

/** The native notification for a newly held request. */
export function escalationNotificationText(owner: EscalationOwner, fallbackName: string): { title: string; body: string } {
  switch (owner.kind) {
    case 'family':
      return { title: `${owner.name} is waiting for a sign-in approval`, body: 'Open Signet to review it.' };
    case 'self':
      return { title: `An app wants to sign as ${owner.name || 'you'}`, body: 'Open Signet to approve or deny it.' };
    default:
      return { title: `A request for ${fallbackName} is waiting for approval`, body: 'Open Signet to review it.' };
  }
}

/** The inbox heading: "Family asks" only while every ask is a family one. */
export function escalationSectionTitle(owners: readonly EscalationOwner[]): string {
  return owners.every((o) => o.kind === 'family') ? 'Family asks' : 'Waiting for approval';
}
