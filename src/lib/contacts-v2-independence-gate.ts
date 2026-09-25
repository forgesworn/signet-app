/**
 * Spec section 7.8 makes a complete contact-transfer design a prerequisite for
 * enabling the independence ceremony in production: until contacts can move
 * with the dependant, completing the ceremony would rotate their identity and
 * leave their contacts recoverable only through the guardian's root.
 *
 * The gate is therefore data-driven rather than a feature flag — a dependant
 * whose directory is empty (or whose records are all tombstoned) has nothing
 * to strand, so their ceremony still completes.
 *
 * Only `lifecycle: 'removed'` clears the gate — which also covers an archived
 * record: the reducer's `archive` action sets `lifecycle: 'removed',
 * archived: true` (a durable tombstone with an extra flag, not a distinct
 * lifecycle state), so an archived record does not block the ceremony
 * either. That is intended, not an oversight: §7.8 lets the transition
 * ceremony's own contacts choice decide, per record, whether the dependant's
 * old contacts are deleted or retained as a read-only encrypted archive —
 * either outcome is "moved" as far as this gate is concerned.
 */
import type { ContactRecord } from '../types';
import { independenceGateCopy } from './contacts-v2-copy';

export interface IndependenceGate {
  allowed: boolean;
  reason: string | null;
}

export function resolveIndependenceGate(input: {
  dependantName: string;
  contacts: Pick<ContactRecord, 'lifecycle' | 'archived'>[];
}): IndependenceGate {
  const remaining = input.contacts.filter(c => c.lifecycle !== 'removed');
  if (remaining.length === 0) return { allowed: true, reason: null };
  return { allowed: false, reason: independenceGateCopy(input.dependantName) };
}
