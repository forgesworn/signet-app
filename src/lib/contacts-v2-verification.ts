/**
 * What `ContactIdentity.verification` means, in one place: `unverified` <
 * `proven` (a one-sided proof that this is their key) < `mutual` (both sides
 * ran the My Signet exchange with the words confirmed). The reducer's own rank
 * (`add-identity` merge) uses the same order; `update-identity` does NOT
 * rank-check, so every writer must go through `verificationUpgrade`.
 */
import type { ContactIdentity, ContactVerification, EffectiveContact } from '../types';

const RANK: Record<ContactVerification, number> = { unverified: 0, proven: 1, mutual: 2 };

export function verificationRank(v: ContactVerification): number {
  return RANK[v];
}

/** An identity is confirmed once anything above `unverified` is recorded on it. */
export function isConfirmed(identity: Pick<ContactIdentity, 'verification'>): boolean {
  return identity.verification !== 'unverified';
}

/** A contact is confirmed when at least one of its identities is. A keyless contact has nothing to confirm, so it is not. */
export function isContactConfirmed(record: Pick<EffectiveContact, 'identities'>): boolean {
  return record.identities.some(isConfirmed);
}

/** Move to `target` only if it is strictly more confirmed: never downgrade `mutual` to `proven`. */
export function verificationUpgrade(
  current: ContactVerification,
  target: 'proven' | 'mutual',
): 'proven' | 'mutual' | null {
  return RANK[target] > RANK[current] ? target : null;
}

