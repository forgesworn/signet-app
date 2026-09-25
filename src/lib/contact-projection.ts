/**
 * Build a ContactProjectionV2 from a directory's effective contacts.
 *
 * This is the ONLY place that decides what leaves the device for an app, and
 * the capability table in `contact-projection.test.ts` is the contract. Four
 * properties are load-bearing:
 *
 * 1. **Allowlist, not denylist.** Each projected field is written only when its
 *    capability is present. Nothing is copied wholesale and then trimmed, so a
 *    new field on `ContactRecord` cannot leak by being forgotten here — it has
 *    to be added deliberately, with a capability.
 * 2. **Blocked is gated by its own capability.** With `read:directory` but no
 *    `blocks.read`, a blocked contact is omitted entirely rather than emitted
 *    with `blocked: false` — anything else leaks block state through the exact
 *    field the capability exists to gate.
 * 3. **One sanitiser (R-6).** Every string goes through the SDK's
 *    `sanitizeWireText`, which is the function its parser uses. Using the app's
 *    own `sanitizeDisplayName` instead would risk a single character the
 *    producer keeps and the parser strips — and `buildProjection` throws on any
 *    such rewrite, so that grant's rail would die silently and permanently.
 *    Empty and over-cap method values are dropped HERE, before that check.
 * 4. **The body is fitted before it is built (R-5).** A directory that would
 *    exceed `MAX_WIRE_BYTES` is published with its most recently updated
 *    contacts and `truncated: true`, rather than failing to seal in a catch
 *    nobody reads.
 *
 * Pure: no IndexedDB, no clock, no randomness. `issuedAt` and the frontier are
 * supplied by the caller.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  MAX_APP_LABEL, MAX_CONTACTS_PER_PROJECTION, MAX_DISPLAY_NAME, MAX_IDENTITIES_PER_CONTACT,
  MAX_METHODS_PER_CONTACT, MAX_METHOD_VALUE, MAX_ROLES_PER_CONTACT,
  MAX_ROLE_LEN, MAX_WIRE_BYTES, buildProjection, clampStaleness, normaliseCapabilities,
  parseProjection, projectionByteLength, sanitizeWireText, scopedContactId,
} from '@forgesworn/signet-contacts/wire';
import type {
  Capability, ContactProjectionV2, ProjectedContact,
  ProjectedIdentity, ProjectedMethod, ProjectionFrontier,
} from '@forgesworn/signet-contacts/wire';
import type { EffectiveContact } from '../types';

export interface ProjectionInput {
  grantId: string;
  capabilities: readonly Capability[];
  contacts: readonly EffectiveContact[];
  frontier: ProjectionFrontier;
  appLabels: Record<string, string>;
  issuedAt: number;
  maxStalenessSeconds: number;
}

/** M1: codepoint order, not `localeCompare` — the wire order has to be the
 *  SAME on every device regardless of locale/ICU version, and this is also
 *  what fixes the wire bytes the hash is computed over. */
function compareCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** I4(b): identity/linked pubkeys must be exactly 64 LOWERCASE hex to survive
 *  the SDK's own `isHex(pubkey, 64)` read-side guard. */
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;

/**
 * I4(a): `sanitizeWireText` strips, trims, THEN slices — so slicing a long
 * trimmed string to `maxLen` can land the cut exactly after a space,
 * leaving a TRAILING space the first pass never sees as trailing (it
 * trimmed before it sliced). The SDK's own parser re-applies
 * `sanitizeWireText` to every string field it reads back, so an untreated
 * trailing space here would make the parser trim it away and disagree with
 * what we sent — the exact "would rewrite contact fields in transit" throw.
 * A second pass removes it and reaches a fixed point: re-sanitising a
 * string that already has no leading/trailing whitespace and is at or under
 * `maxLen` can never change it again.
 */
function sanitizeFixedPoint(raw: unknown, maxLen: number): string {
  return sanitizeWireText(sanitizeWireText(raw, maxLen), maxLen);
}

export function projectContact(
  contact: EffectiveContact,
  grantId: string,
  caps: ReadonlySet<Capability>,
  appLabels: Record<string, string>,
): ProjectedContact | null {
  const canReadDirectory = caps.has('signet.contacts.read:directory');
  const canReadBlocks = caps.has('signet.contacts.blocks.read');
  if (!canReadDirectory && !canReadBlocks) return null;

  // Rule 2: block state is only ever visible through its own capability.
  if (contact.blocked && !canReadBlocks) return null;
  // With blocks.read alone, the grant is a filter list, not a directory.
  if (!canReadDirectory && !contact.blocked) return null;
  // A live contact must be active; a BLOCKED one survives removal, because an
  // app still has to keep filtering someone the owner deleted and blocked.
  if (!contact.blocked && (contact.lifecycle !== 'active' || contact.archived === true)) return null;

  const scoped = scopedContactId(grantId, contact.contactId);
  const projected: ProjectedContact = {
    contactId: scoped,
    ...(canReadBlocks ? { blocked: contact.blocked } : {}),
  };

  const canReadChecks = canReadDirectory && caps.has('signet.contacts.read:checks');
  if (canReadDirectory && caps.has('signet.contacts.read:tier')) {
    projected.effectiveTier = contact.effectiveTier;
    projected.tierSource = contact.tierSource;
  }

  const identities: ProjectedIdentity[] = contact.identities
    // Public keys belong to this contact; linkage and evidence metadata stay private.
    // I4(b): lowercase FIRST — a mixed-case but otherwise valid pubkey is
    // still real data — THEN require exactly 64 lowercase hex chars. A
    // pubkey that fails this could never survive `buildProjection`'s round
    // trip anyway (the parser drops the whole identity), so dropping it
    // here keeps that guard unreachable rather than relying on it.
    .map((i) => ({ pubkey: i.pubkey.toLowerCase(), ...(canReadChecks ? { verification: i.verification } : {}) }))
    .filter((i) => LOWER_HEX_64.test(i.pubkey))
    .slice(0, MAX_IDENTITIES_PER_CONTACT);
    // Structurally two fields only — `direct.sharedSecret`, `itemId`, `label`
    // and provenance never get near the wire.
  if (identities.length > 0) projected.identities = identities;
  if (canReadDirectory && caps.has('signet.contacts.read:check-records') && contact.checks?.length) {
    const checks = contact.checks.filter(c => identities.some(i => i.pubkey === c.identityPubkey)).slice(0, 128)
      .map(c => ({ pubkey: c.identityPubkey, method: c.method, checkedAt: c.checkedAt }));
    if (checks.length) projected.checks = checks;
  }


  if (canReadDirectory) {
    const label = appLabels[scoped];
    const displayName = typeof label === 'string' && label.length > 0
      ? sanitizeFixedPoint(label, MAX_APP_LABEL)
      : sanitizeFixedPoint(contact.displayName, MAX_DISPLAY_NAME);
    if (displayName.length > 0) projected.displayName = displayName;

    if (caps.has('signet.contacts.read:roles')) {
      const roles = contact.roles
        .slice(0, MAX_ROLES_PER_CONTACT)
        .map((r) => sanitizeFixedPoint(r, MAX_ROLE_LEN))
        .filter((r) => r.length > 0);
      if (roles.length > 0) projected.roles = roles;
    }

    {
      const methods: ProjectedMethod[] = [];
      for (const m of contact.contactMethods) {
        if (m.sharingPolicy !== 'grantable' || !caps.has(`signet.contacts.read:method:${m.kind}`)) continue;
        if (methods.length >= MAX_METHODS_PER_CONTACT) break;
        // R-6: sanitise and drop HERE. A value that cleans to nothing is one
        // the SDK's parser would drop, and a dropped field makes
        // `buildProjection` throw — for that grant, on every rebuild, for ever.
        const value = sanitizeFixedPoint(m.value, MAX_METHOD_VALUE);
        if (value.length === 0) continue;
        methods.push({ kind: m.kind, value, ...(canReadChecks ? { verification: m.verification } : {}) });
      }
      if (methods.length > 0) projected.contactMethods = methods;
    }
  }

  return projected;
}

export function buildContactProjection(input: ProjectionInput): ContactProjectionV2 {
  const caps = new Set<Capability>(input.capabilities);

  // R-5: project in DROP order — the prefix is what survives truncation.
  //
  // R-28(c): APP-CREATED records go last, so they are the first to be dropped.
  // Contacts live in one shared directory log and every grant on that directory
  // projects from it, so without this an app the owner ticked one box for could
  // push the owner's own contacts out of a DIFFERENT, unrelated app's
  // projection simply by adding enough of its own — the volume is bounded
  // (`MAX_APP_CREATED_CONTACTS`) but the eviction order is what decides whose
  // records pay for it, and it should never be the owner's.
  //
  // Within each group: most recently updated first, `contactId` as the
  // tiebreak (M1: codepoint order, not `localeCompare`) so two contacts with
  // the same `updatedAt` always order the same way on every device.
  const appCreated = (c: EffectiveContact): number => (c.createdByActorRole === 'app' ? 1 : 0);
  const ordered = [...input.contacts].sort((a, b) => (
    appCreated(a) - appCreated(b)
    || b.updatedAt - a.updatedAt
    || compareCodepoint(a.contactId, b.contactId)
  ));
  const projectedAll = ordered
    .map((c) => projectContact(c, input.grantId, caps, input.appLabels))
    .filter((c): c is ProjectedContact => c !== null);
  // I4(c): the SDK caps a projection at MAX_CONTACTS_PER_PROJECTION and
  // SILENTLY drops the excess on parse (see `parseProjection`) — passing
  // more than that through would make `buildProjection`'s own round-trip
  // length check throw. Capping here, in the same most-recently-updated-
  // first order R-5 already uses, means ">2000 contacts" is handled by the
  // drop rule, not by the SDK's guard.
  const projected = projectedAll.slice(0, MAX_CONTACTS_PER_PROJECTION);

  const base = {
    v: 2 as const,
    grantId: input.grantId,
    // M2: normalised (sorted, AND filtered to the known `CAPABILITIES` set)
    // before it ever reaches the SDK. `normaliseCapabilities` drops any
    // string that is not one of the fixed capabilities — including one
    // persisted by an older or newer app build this one does not recognise
    // — so the scopes handed to `buildProjection` are already exactly its
    // own idea of "the known-valid subset". Its "would narrow scopes in
    // transit" guard can therefore never find anything left to narrow: an
    // unknown persisted capability string is dropped HERE, never shipped.
    scopes: normaliseCapabilities([...input.capabilities]),
    frontier: input.frontier,
    issuedAt: input.issuedAt,
    expiresAt: input.issuedAt + clampStaleness(input.maxStalenessSeconds),
  };

  /** Emitted order is by scoped id (M1: codepoint order), so the dedupe hash
   *  cannot churn on local record order. Only the DROP order above is by
   *  recency. */
  const emit = (keep: ProjectedContact[], truncated: boolean): ContactProjectionV2 => {
    const projection: ContactProjectionV2 = {
      ...base,
      contacts: [...keep].sort((a, b) => compareCodepoint(a.contactId, b.contactId)),
    };
    if (truncated) projection.truncated = true;
    return projection;
  };

  const full = emit(projected, false);
  if (projectionByteLength(full) <= MAX_WIRE_BYTES) return full;

  // I2: byte length is monotonic non-decreasing in the number of KEPT
  // contacts, because `keep` is always a prefix of the same fixed
  // (most-recently-updated-first) order — one more element can only ever
  // add bytes, never remove any. That makes the largest fitting prefix
  // binary-searchable in O(log n) full-body measurements, rather than
  // O(n) pops each re-measuring the whole body from scratch.
  let lo = 0;
  let hi = projected.length - 1;
  let best = emit([], true);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = emit(projected.slice(0, mid + 1), true);
    if (projectionByteLength(candidate) <= MAX_WIRE_BYTES) {
      // This count fits — it's the new best, and a larger count might too.
      best = candidate;
      lo = mid + 1;
    } else {
      // This count overflows — everything at or above it will too.
      hi = mid - 1;
    }
  }
  // Even empty, the header is a few hundred bytes — `best` staying at the
  // empty truncated projection seeded above is reachable only if
  // MAX_WIRE_BYTES were misconfigured, and that is still an honest result.
  return best;
}

/** The tombstone a revoked grant publishes: empty, revoked, immediately. The
 *  consumer clears its directory and keeps its Blocked set. */
export function buildRevocationProjection(
  grantId: string, capabilities: readonly Capability[],
  issuedAt: number, deviceId: string,
): ContactProjectionV2 {
  return {
    v: 2,
    grantId,
    scopes: normaliseCapabilities([...capabilities]),
    frontier: { maxClock: 0, opCount: 0, publishedAt: issuedAt, deviceId },
    issuedAt,
    expiresAt: issuedAt,
    contacts: [],
    revoked: true,
  };
}

/**
 * Dedupe hash. `issuedAt`, `expiresAt` and `frontier.publishedAt` are
 * EXCLUDED: all three move on every rebuild, and including any of them would
 * defeat the dedupe entirely — every jittered run would publish an identical
 * directory under a new timestamp, which is exactly the churn the hash exists
 * to prevent. `maxClock`, `opCount` and `deviceId` ARE included: they say what
 * the snapshot is of and who made it.
 *
 * I1: `contacts` is hashed in its SDK-CANONICAL form, not the app's own
 * object literal. `projectContact` builds each `ProjectedContact` with ITS
 * OWN key order (`identities`, `linkedPubkeys`, `displayName`, `roles`,
 * `contactMethods`); the SDK's `parseProjectedContact` reconstructs the same
 * values in ITS key order (`identities`, `displayName`, `avatar`, `roles`,
 * `contactMethods`, `linkedPubkeys`). `JSON.stringify` is key-order
 * sensitive, so hashing our own literal would make a freshly built
 * projection hash DIFFERENTLY from the byte-identical content a consumer
 * gets back after `buildProjection` + `parseProjection` — the exact
 * "fetched projection can never hash equal to a freshly built one" churn
 * this hash exists to prevent. Running the projection through the SDK's own
 * round trip first pins the hash to the shape that actually goes over the
 * wire; the SDK does not export its internal canonical serialiser, so this
 * public round trip is the closest equivalent. Per I4 that round trip is
 * unreachable-by-construction as a THROW for anything this module produces,
 * but the `catch` below still keeps this function itself from ever being a
 * new throw path if that guarantee is ever violated upstream.
 *
 * Not a security primitive; it only has to be order-stable and
 * content-sensitive. Same role as `hashSnapshot` on the v1 rail.
 */
export function hashProjection(projection: ContactProjectionV2): string {
  let canonicalContacts: readonly ProjectedContact[] = projection.contacts;
  try {
    const reparsed = parseProjection(buildProjection(projection));
    if (reparsed !== null) canonicalContacts = reparsed.contacts;
  } catch {
    // Fall back to the app's own contacts array — see doc comment above.
  }
  const canonical = JSON.stringify({
    grantId: projection.grantId,
    scopes: projection.scopes,
    frontier: {
      maxClock: projection.frontier.maxClock,
      opCount: projection.frontier.opCount,
      deviceId: projection.frontier.deviceId,
    },
    revoked: projection.revoked === true,
    truncated: projection.truncated === true,
    contacts: canonicalContacts,
  });
  return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}

/** Reverse the one-way scoped id by enumeration: the producer knows every real
 *  contactId, so it recomputes the digest for each and matches. The app can
 *  never do this in the other direction, which is the point. */
export function scopedIdIndex(
  grantId: string, contacts: readonly { contactId: string }[],
): Map<string, string> {
  const index = new Map<string, string>();
  for (const c of contacts) index.set(scopedContactId(grantId, c.contactId), c.contactId);
  return index;
}
