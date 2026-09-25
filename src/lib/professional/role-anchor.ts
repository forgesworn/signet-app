/**
 * Nostr EventTemplate builders for Pro-surface events.
 * All builders return unsigned EventTemplate objects.
 * Signing is performed by the caller via SigningBackend.
 *
 * Spec: the internal Pro-surface architecture design doc, §3, §6.7
 */

import type { EventTemplate } from 'nostr-tools';
import type { NostrEvent } from 'signet-protocol';
import { signEvent, getPublicKey } from 'signet-protocol';
import type { ProfessionKind, RegistryId, Jurisdiction } from './types';
import { PRO_ROLE_ANCHOR, PRO_ROSTER, PRO_DIRECTORY_ADD, PRO_REVOCATION } from './kinds';

export interface AnchorContext {
  registry: RegistryId;
  identifier: string;
  professionKind: ProfessionKind;
  entityName: string;
  canonicalDomain: string;
  jurisdiction: Jurisdiction;
  /** Natural-person hex pubkey of the lead. */
  leadPubkey: string;
}

export interface RosterMember {
  pubkey: string;
  role: string;
  /** Scope within the entity, e.g. form group "8B" or department "Cardiology". */
  scope?: string;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function dTag(registry: RegistryId, identifier: string): string {
  return `${registry}:${identifier}`;
}

/**
 * Build a kind-30201 role-anchor event template.
 * The lead publishes this event once they've successfully verified their
 * signet.json is live and matches the registry record.
 */
export function buildRoleAnchorEvent(ctx: AnchorContext): EventTemplate {
  return {
    kind: PRO_ROLE_ANCHOR,
    created_at: now(),
    tags: [
      ['d', dTag(ctx.registry, ctx.identifier)],
      ['profession', ctx.professionKind],
      ['jurisdiction', ctx.jurisdiction],
      ['registry', ctx.registry],
      ['identifier', ctx.identifier],
      ['entity', ctx.entityName],
      ['domain', ctx.canonicalDomain],
    ],
    content: '',
  };
}

/**
 * Build a kind-30202 roster event template.
 * Signed by any pubkey in the authority union (leads ∪ delegates).
 * Replaces the previous roster event for the same d-tag at the relay.
 * Spec §3.5.3: delegates are carried as ['delegate', '<pubkey>'] tags.
 */
export function buildRosterEvent(
  ctx: AnchorContext,
  members: RosterMember[],
  delegates: string[] = [],
): EventTemplate {
  const memberTags: string[][] = members.map(m =>
    m.scope
      ? ['p', m.pubkey, m.role, m.scope]
      : ['p', m.pubkey, m.role]
  );
  const delegateTags: string[][] = delegates.map(d => ['delegate', d]);

  return {
    kind: PRO_ROSTER,
    created_at: now(),
    tags: [
      ['d', dTag(ctx.registry, ctx.identifier)],
      ['profession', ctx.professionKind],
      ['registry', ctx.registry],
      ['identifier', ctx.identifier],
      ['entity', ctx.entityName],
      ...memberTags,
      ...delegateTags,
    ],
    content: '',
  };
}

export interface RosterUpdateInput {
  currentMembers: RosterMember[];
  currentDelegates: string[];
  addDelegate?: string;
  removeDelegate?: string;
}

export interface RosterUpdateOutput {
  members: RosterMember[];
  delegates: string[];
}

/**
 * Compute the updated members + delegates list after a single add or remove
 * delegate operation. Pure function — does not build an event or sign.
 * Callers pass the result to buildRosterEvent.
 *
 * No-op semantics:
 * - addDelegate already present → no change.
 * - removeDelegate absent → no change.
 * Spec §3.5.3 + §3.5.5 (Tier 2 revocation path).
 */
export function buildRosterUpdate(input: RosterUpdateInput): RosterUpdateOutput {
  let delegates = [...input.currentDelegates];

  if (input.addDelegate !== undefined && !delegates.includes(input.addDelegate)) {
    delegates = [...delegates, input.addDelegate];
  }
  if (input.removeDelegate !== undefined) {
    delegates = delegates.filter(d => d !== input.removeDelegate);
  }

  return { members: input.currentMembers, delegates };
}

/**
 * Build a kind-30203 directory-add event template.
 * Published by the lead to opt their firm into the public Signet directory.
 * The directory is regenerated nightly from relay events of this kind.
 */
export function buildDirectoryAddEvent(ctx: AnchorContext): EventTemplate {
  return {
    kind: PRO_DIRECTORY_ADD,
    created_at: now(),
    tags: [
      ['d', dTag(ctx.registry, ctx.identifier)],
      ['profession', ctx.professionKind],
      ['jurisdiction', ctx.jurisdiction],
      ['registry', ctx.registry],
      ['identifier', ctx.identifier],
      ['entity', ctx.entityName],
      ['domain', ctx.canonicalDomain],
    ],
    content: '',
  };
}

/**
 * Build a kind-30204 revocation event template.
 * Published by the lead to remove a sub-role member from the active roster.
 * Tier 2 friction (fresh PIN + double-confirm) required before publishing.
 */
export function buildRevocationEvent(
  ctx: AnchorContext,
  revokedPubkey: string,
  revokedRole: string
): EventTemplate {
  return {
    kind: PRO_REVOCATION,
    created_at: now(),
    tags: [
      ['d', dTag(ctx.registry, ctx.identifier)],
      ['registry', ctx.registry],
      ['identifier', ctx.identifier],
      ['p', revokedPubkey],
      ['role', revokedRole],
    ],
    content: '',
  };
}

// ── Lead key rotation ─────────────────────────────────────────────────────────

export interface LeadKeyRotationInput {
  identifier: { kind: string; value: string };
  professionKind: ProfessionKind;
  canonicalUrl: string;
  firmName: string;
  /** The pubkey of the outgoing head (hex). Included for audit trail. */
  previousHeadPubkeyHex: string;
}

/**
 * Build and sign a kind-30201 role-anchor event with the new lead key.
 *
 * The `prev-head` tag records the outgoing head pubkey for audit trail.
 * Verifiers: accept roster events signed by either the current or the previous
 * head pubkey within a 90-day grace window from this rotation event's created_at.
 */
export async function buildLeadKeyRotationEvent(
  input: LeadKeyRotationInput,
  newLeadPrivkeyHex: string,
): Promise<NostrEvent> {
  const dTagValue = `${input.identifier.kind}:${input.identifier.value}`;
  const pubkey = getPublicKey(newLeadPrivkeyHex);

  const unsigned = {
    kind: PRO_ROLE_ANCHOR,
    created_at: now(),
    tags: [
      ['d', dTagValue],
      ['profession', input.professionKind],
      ['url', input.canonicalUrl],
      ['prev-head', input.previousHeadPubkeyHex],
    ],
    content: JSON.stringify({
      firmName: input.firmName,
      identifier: input.identifier,
      canonicalUrl: input.canonicalUrl,
      professionKind: input.professionKind,
      rotatedAt: new Date().toISOString(),
      previousHeadPubkey: input.previousHeadPubkeyHex,
    }),
    pubkey,
  };

  return signEvent(unsigned, newLeadPrivkeyHex);
}

// ── Roster revocation ─────────────────────────────────────────────────────────

export interface RosterRevocationMember {
  pubkey: string;
  subRole: string;
  scope?: string;
}

export interface RosterRevocationInput {
  identifier: { kind: string; value: string };
  professionKind: ProfessionKind;
  /** Full member list AFTER removal (the revoked member is absent). */
  remainingMembers: RosterRevocationMember[];
  /** Pubkey of the member being revoked (included in `revoked` tag for audit). */
  revokedPubkey: string;
}

/**
 * Build and sign a kind-30202 roster event that supersedes the previous roster.
 *
 * The `revoked` tag carries the removed member's pubkey for audit.
 * Verifiers always use the latest kind-30202 event for a given `d` tag;
 * credentials signed by the revoked member after this event's created_at
 * are rejected.
 */
export async function buildRosterRevocationEvent(
  input: RosterRevocationInput,
  leadPrivkeyHex: string,
): Promise<NostrEvent> {
  const dTagValue = `${input.identifier.kind}:${input.identifier.value}`;
  const pubkey = getPublicKey(leadPrivkeyHex);

  const unsigned = {
    kind: PRO_ROSTER,
    created_at: now(),
    tags: [
      ['d', dTagValue],
      ['profession', input.professionKind],
      ['revoked', input.revokedPubkey],
    ],
    content: JSON.stringify({
      identifier: input.identifier,
      professionKind: input.professionKind,
      members: input.remainingMembers,
      revokedPubkey: input.revokedPubkey,
      revokedAt: new Date().toISOString(),
    }),
    pubkey,
  };

  return signEvent(unsigned, leadPrivkeyHex);
}

// ── Role-anchor revocation ────────────────────────────────────────────────────

export interface RoleAnchorRevocationInput {
  identifier: { kind: string; value: string };
  professionKind: ProfessionKind;
  reason?: string;
}

/**
 * Build and sign a kind-30204 role-anchor revocation event.
 *
 * After this event is published, verifiers treating this firm's identifier
 * will check for a kind-30204 and if found, surface a "professional role revoked"
 * warning rather than green-lighting the credential.
 */
export async function buildRoleAnchorRevocationEvent(
  input: RoleAnchorRevocationInput,
  leadPrivkeyHex: string,
): Promise<NostrEvent> {
  const dTagValue = `${input.identifier.kind}:${input.identifier.value}`;
  const pubkey = getPublicKey(leadPrivkeyHex);

  const unsigned = {
    kind: PRO_REVOCATION,
    created_at: now(),
    tags: [
      ['d', dTagValue],
      ['profession', input.professionKind],
    ],
    content: JSON.stringify({
      identifier: input.identifier,
      professionKind: input.professionKind,
      revokedAt: new Date().toISOString(),
      reason: input.reason ?? null,
    }),
    pubkey,
  };

  return signEvent(unsigned, leadPrivkeyHex);
}

// ── Directory-add (signed variant) ────────────────────────────────────────────

export interface DirectoryAddInput {
  firmName: string;
  identifier: { kind: string; value: string };
  canonicalUrl: string;
  professionKind: ProfessionKind;
  /** When true, publishes a `listed: false` record — firm is opt-out. */
  optOut?: boolean;
}

/**
 * Build and sign a kind-30203 directory-add event.
 *
 * Kind 30203 — Signet Pro directory entry (parameterised replaceable).
 * `d` tag = "<identifierKind>:<identifierValue>" for deduplication.
 * Relay: wss://relay.forgesworn.dev (§12 Q8 default).
 *
 * This variant signs the event inline (for use in test helpers and passive-discovery
 * contexts where only a hex private key is available). For the main onboarding flow,
 * use `buildDirectoryAddEvent(ctx)` + `backend.signEvent(template)` instead.
 */
export async function buildDirectoryAddEventSigned(
  input: DirectoryAddInput,
  leadPrivkeyHex: string,
): Promise<NostrEvent> {
  const listed = input.optOut !== true;
  const dTagValue = `${input.identifier.kind}:${input.identifier.value}`;

  const pubkey = getPublicKey(leadPrivkeyHex);

  const unsigned = {
    kind: PRO_DIRECTORY_ADD,
    created_at: now(),
    tags: [
      ['d', dTagValue],
      ['profession', input.professionKind],
      ['url', input.canonicalUrl],
      ['listed', listed ? 'true' : 'false'],
    ],
    content: JSON.stringify({
      firmName: input.firmName,
      identifier: input.identifier,
      canonicalUrl: input.canonicalUrl,
      professionKind: input.professionKind,
      listed,
    }),
    pubkey,
  };

  return signEvent(unsigned, leadPrivkeyHex);
}
