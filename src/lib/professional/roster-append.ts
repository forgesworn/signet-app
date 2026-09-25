/**
 * Roster-append event builder for the Lead "Add staff via QR scan" flow.
 * Spec: 2026-04-25-pro-surface-architecture-design.md §4.2, §6.9
 *
 * Produces a new kind-30202 roster EventTemplate that replaces the current
 * roster for the given firm. The new member is appended; duplicates are
 * deduplicated. Signing is performed by the caller via the Lead's proBackend.
 */

import type { EventTemplate } from 'nostr-tools';
import type { AnchorContext, RosterMember } from './role-anchor';
import { PRO_ROSTER } from './kinds';

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Build a kind-30202 roster EventTemplate that appends newStaffPubkey to the
 * existing member list. If newStaffPubkey is already present, it is not
 * duplicated. Optionally assigns a sub-role label to the new member.
 *
 * The event is unsigned — the caller signs it via `proBackend.signEvent(template)`.
 */
export function buildRosterAppendEvent(
  ctx: AnchorContext,
  existingMembers: RosterMember[],
  newStaffPubkey: string,
  newMemberRole: string = '',
): EventTemplate {
  // Deduplicate: if the pubkey is already in the roster, don't add again.
  const alreadyPresent = existingMembers.some(m => m.pubkey === newStaffPubkey);
  const updatedMembers: RosterMember[] = alreadyPresent
    ? existingMembers
    : [...existingMembers, { pubkey: newStaffPubkey, role: newMemberRole }];

  const dTagValue = `${ctx.registry}:${ctx.identifier}`;

  const memberTags: string[][] = updatedMembers.map(m =>
    m.scope
      ? ['p', m.pubkey, m.role, m.scope]
      : ['p', m.pubkey, m.role]
  );

  return {
    kind: PRO_ROSTER,
    created_at: now(),
    tags: [
      ['d', dTagValue],
      ['profession', ctx.professionKind],
      ['registry', ctx.registry],
      ['identifier', ctx.identifier],
      ['entity', ctx.entityName],
      ...memberTags,
    ],
    content: '',
  };
}
