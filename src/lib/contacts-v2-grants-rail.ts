/**
 * Contacts v2 app-grant registry rail (R-2, Phase E Task 26; fix round 1).
 *
 * WHY A SEPARATE RAIL. A grant's rail private key is fresh randomness: lose
 * it and that grant can never publish its projection again, and a second
 * device could never publish it at all. It therefore has to be backed up.
 * Putting it inside `CheckpointPayload` (`contacts-v2-sync.ts`) would mean
 * the registry rides a payload that is chunked across numbered events behind
 * a manifest — so a single failed chunk would lose every rail key silently —
 * and would need changes to the checkpoint parser, publisher, splitter,
 * reassembler and remote type, none of which Phase E may touch. Its own
 * single-envelope replaceable event is smaller, self-contained, and cannot
 * damage the contacts rail if it fails.
 *
 * TAG. The `d` tag is `sha256('signet:contacts:v2:grants:<author>')`
 * truncated to 32 hex — `contacts-v2-sync.ts`'s `tagFor` formula with a fifth
 * kind, SPELLED LOCALLY (not imported) so that Phase E adds no member to
 * `ContactsV2TagKind` and no Phase E change can reach the checkpoint rail's
 * code at all.
 *
 * WHAT IS ON THE WIRE (`WireGrantV2`). An ALLOW-LIST `Pick<>` of identity and
 * capability fields plus the rail keypair, `relay`, `maxStalenessSeconds`,
 * `revokedAt`, `appLabels` (fix round 1, I2) — NOT a `Omit<>` deny-list. A
 * deny-list silently ships a brand new field on `AppGrantV2` (device-local or
 * not) the day it's added; an allow-list ships nothing it wasn't told to.
 * `toWireGrant` builds `WireGrantV2` by NAMING every kept field rather than
 * spreading "everything except X", so a stray/bogus property on the runtime
 * object (or a future device-local field nobody remembered to exclude) can
 * never reach the wire.
 *
 * WHY THE RAIL KEY IS ON IT (R-3). A per-grant random key is unrecoverable
 * if lost and unusable by a second device if not shared. It is sealed inside
 * the owner's own envelope, the same boundary that already protects the
 * contacts themselves — anything that can open the vault can open every rail
 * in it. See SECURITY.md.
 *
 * UNITS (fix round 1, I3): two different clocks share this file. `now`
 * (`publishGrantsV2`'s argument), `GrantsRailPayload.createdAt` and the Nostr
 * event's own `created_at` are Unix-epoch SECONDS (NIP-01) — validated by
 * `normaliseNow` before use, so a caller that accidentally passes a
 * millisecond value (or a fractional one) cannot poison the monotonic
 * publish counter with a wildly future stamp every later publish would then
 * have to exceed forever. `AppGrantV2.updatedAt`/`revokedAt` and
 * `AppLabelEntry.updatedAt` (R-17) are MILLISECONDS, unrelated to the above.
 *
 * BOUNDS (fix round 1, R-20 — measured, not blind-sliced). The wire is
 * BYTE-FITTED against the exact predicate `sealVaultPayload` itself uses
 * (`padToBucket`, i.e. whether the padded body fits the top 64 KiB bucket),
 * never a blind `.slice(0, N)` over a mixed active+revoked list — the
 * original cut let a handful of revoked audit rows evict an active grant's
 * only rail-key backup. Build order: every ACTIVE grant (at most
 * `CONTACT_GRANT_V2_CAP`, most recently updated first), then revoked audit
 * rows (most-recently-revoked first). If the full set does not fit one
 * envelope, shrink in this order until it does: (1) revoked rows, oldest
 * first (an active grant is never sacrificed for one); (2) once no revoked
 * rows remain, per-grant `appLabels`, globally lowest-`updatedAt`-first
 * across every surviving active grant; (3) give up — `publishGrantsV2`
 * returns `'too-large'` rather than truncating a grant it cannot fully
 * represent (Task 27 surfaces this as a `backupState`, mirroring the
 * contacts checkpoint's own `'too-large'`). `parseGrantsPayload` mirrors this
 * on read: it caps ACTIVE grants at `CONTACT_GRANT_V2_CAP` but accepts any
 * number of revoked rows that arrived on the wire (bounded only by the
 * envelope's own ~100 KB ceiling upstream in `vault-envelope.ts`).
 *
 * MERGE. Per-grant last-writer-wins on `updatedAt`, with `revokedAt`
 * MONOTONIC (earliest wins, and a revocation never reverses — a device that
 * had not heard about it must not raise the dead), `appLabels` unioned PER
 * ENTRY (independent renames on two devices are data, not staleness — higher
 * `updatedAt` per scoped id wins, ties keep local, capped back to
 * `MAX_APP_LABELS_PER_GRANT` after the union), and every device-local field
 * taken from the LOCAL side always. `railPubkey` and `railPrivateKey` are
 * always taken from the SAME side (fix round 1, I4) — the winning side by
 * `updatedAt`, unless the winner's own key is empty, in which case BOTH come
 * from the other side; mixing one side's private key with the other's
 * declared pubkey would silently produce a keypair that does not match,
 * which is worse than an empty key because it looks fine until it's used. A
 * remote-only record is adopted only when it is ACTIVE and carries a usable
 * `railPrivateKey` (fix round 1, I5/R-21): a REVOKED remote-only row is never
 * adopted — a row this device has forgotten (R-13) must not come back from
 * the wire, and a revoked row this device never knew about carries nothing
 * it needs.
 *
 * R-23/R-26 (Task 28): the cap is enforced on ADOPTION, never by deletion.
 * Every LOCAL row survives a merge — capping the merged output meant a
 * remote payload carrying newer rows could silently delete a local grant's
 * only copy of its rail private key. Remote-only ACTIVE rows are adopted
 * most-recently-updated first, only while the active total stays within
 * `CONTACT_GRANT_V2_CAP`, and the rest are reported as
 * `GrantMergeResult.skippedRemote` rather than dropped in silence. A revoked
 * row never counts against the cap (R-13: kept for audit, not a reserved
 * slot). `capActiveGrants` now applies to the WIRE BUILD only, which is where
 * the bound actually has to hold; a local device may therefore legitimately
 * hold more active grants than it can publish, and the byte-fit above is what
 * bounds what goes out.
 *
 * `seenOperationIds` IS DELIBERATELY NOT SHARED (R-2/S6): a second device
 * starts its own replay window, bounded by proposal `createdAt` staleness
 * rather than by a shared list. Sharing it would put 500 ids × 10 grants on
 * the wire for a guarantee the `createdAt` window already gives.
 *
 * FETCH (Phase D R9, fix round 1, C1). An event that EXISTS but cannot be
 * opened or parsed is classified `present` with a `null` payload, NEVER
 * `missing-after-seen` — the latter claims "there used to be a backup and now
 * there isn't", which is false; there is one, this device just could not
 * read it. `remoteState` is therefore computed from whether a `d`-tag-
 * matching event was found at all (`validEvent !== null`), not from whether
 * it happened to parse.
 *
 * ONE sealed replaceable event, `legacyFallback: false` (this rail never had
 * a v1 format), author-pinned fetch (with the returned event's own `d` tag
 * re-checked against the tag queried for), never publish an information-free
 * record, never throw out of a publish or a fetch — same posture as every
 * other Phase D rail. This module reuses `vault-envelope.ts`, `sync-relays.ts`
 * and `sync-seen.ts`; it does NOT import from `contacts-v2-sync.ts` (R-2) —
 * that file's diff must stay empty for this task.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import {
  MAX_APP_LABEL, MAX_APP_NAME, MAX_CAPABILITIES,
  isCapability, normaliseCapabilities, clampStaleness,
} from '@forgesworn/signet-contacts/wire';
import type { Capability } from '@forgesworn/signet-contacts/wire';
import { sealVaultPayload, openVaultPayload, padToBucket } from './vault-envelope';
import { publishToRelays, fetchNewestFromRelays } from './sync-relays';
import { isValidRelayUrl } from './relay-url';
import { getSyncSeen, setSyncSeen, classifyFetchOutcome } from './sync-seen';
import type { SyncRemoteState } from './sync-seen';
import { sanitizeDisplayName } from './text-sanitize';
import type { DecryptingSigningBackend } from './signing-backend';
import { CONTACT_GRANT_V2_CAP, MAX_APP_LABELS_PER_GRANT } from '../types';
import type { AppGrantV2, AppLabelEntry } from '../types';

/** Same replaceable-event kind as every other sync rail. */
export const GRANTS_RAIL_KIND = 30078;

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** Same domain as `AppGrantV2.directoryId`'s own doc comment — Phase B/C's
 *  three directory-id shapes. Spelled locally rather than imported so this
 *  rail has no reach into the reducer's internals either. */
const DIRECTORY_ID = /^(owner|quarantine|dependant:[0-9a-f]{64})$/;
/** M2: a relay URL cap for wire data, mirroring `bunker-url.ts`'s own single-
 *  relay-string cap — `isValidRelayUrl` checks the scheme, this bounds the
 *  length a hostile/malformed relay string could otherwise carry. */
const MAX_RELAY_LEN = 256;

/**
 * Deterministic opaque `d` tag for the grants rail. Domain-separated from
 * every `contacts-v2-sync.ts` tag by construction — this string literal
 * shares no prefix arithmetic with `tagFor`, it just happens to follow the
 * same `sha256(...).slice(0, 32)` shape.
 */
export function grantsRailTag(authorPubkey: string): string {
  const base = `signet:contacts:v2:grants:${authorPubkey.toLowerCase()}`;
  return bytesToHex(sha256(new TextEncoder().encode(base))).slice(0, 32);
}

/**
 * What rides the wire for one grant. An ALLOW-LIST (`Pick<>`), not a deny-
 * list — see the module header (I2). `toWireGrant` builds this by naming
 * every field, never by spreading the source object.
 */
export type WireGrantV2 = Pick<
  AppGrantV2,
  | 'grantId' | 'directoryId' | 'appPubkey' | 'createdAt' | 'updatedAt' | 'appName'
  | 'capabilities' | 'railPubkey' | 'railPrivateKey' | 'relay' | 'maxStalenessSeconds'
  | 'autoAcceptInvites' | 'revokedAt' | 'appLabels' | 'ownerIdentityPubkey'
>;

export interface GrantsRailPayload {
  v: 2;
  kind: 'grants';
  createdAt: number;
  grants: WireGrantV2[];
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Order app labels highest-`updatedAt`-first, then by key, and take at most
 * `limit`. Shared by `toWireGrant` (capping what we send), `parseAppLabels`
 * (M1 — capping what we read is order-independent of wire/JSON key order)
 * and `mergeGrantRegistry` (capping what a merge could otherwise grow past
 * 16).
 */
function capLabelCount(labels: Record<string, AppLabelEntry>, limit: number): Record<string, AppLabelEntry> {
  const entries = Object.entries(labels)
    .sort(([keyA, a], [keyB, b]) => {
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    })
    .slice(0, limit);
  const out: Record<string, AppLabelEntry> = {};
  for (const [key, entry] of entries) out[key] = entry;
  return out;
}

/** Truncate every label's text to `MAX_APP_LABEL`, then cap the count. */
function boundAppLabelsForWire(labels: Record<string, AppLabelEntry>): Record<string, AppLabelEntry> {
  const sanitised: Record<string, AppLabelEntry> = {};
  for (const [key, entry] of Object.entries(labels)) {
    sanitised[key] = { label: sanitizeDisplayName(entry.label, MAX_APP_LABEL), updatedAt: entry.updatedAt };
  }
  return capLabelCount(sanitised, MAX_APP_LABELS_PER_GRANT);
}

/**
 * Build `WireGrantV2` as an ALLOW-LIST (I2): every field is named explicitly,
 * never `...spread`, so neither a device-local field nor a bogus/unexpected
 * extra property on the runtime object can reach the wire. `appLabels ?? {}`
 * (I1) tolerates a pre-R-17 row that predates the field.
 *
 * R-27: EVERY bound `parseWireGrant` applies on READ is applied here on BUILD
 * too, so this rail can never publish a row its own reader would reject. The
 * asymmetry was real: `appName` and `capabilities` were copied verbatim while
 * the parser truncated the first to `MAX_APP_NAME` and normalised/sliced the
 * second to `MAX_CAPABILITIES`, so a row that had grown past either bound
 * published happily and then vanished from the registry on the next fetch —
 * on this device as much as on any other. A grant that is silently dropped by
 * every reader is worse than one that was never published: the rail reports
 * `'published'`, the owner believes the rail key is backed up, and it is not.
 *
 * `normaliseCapabilities` is the same function the parser uses, so the build
 * and read sides cannot drift: it dedupes (via a `Set`) and emits in the
 * canonical `CAPABILITIES` order, dropping anything unrecognised; the
 * `MAX_CAPABILITIES` slice afterwards mirrors the parser exactly. `relay` is
 * bounded too, but by DROPPING the whole grant in `buildGrantsWirePayload`
 * rather than truncating here — a truncated URL is a different relay, not a
 * shorter one, and silently repointing a grant at some other host is not a
 * bound, it is a redirection.
 */
export function toWireGrant(grant: AppGrantV2): WireGrantV2 {
  const appLabels = grant.appLabels ?? {};
  return {
    grantId: grant.grantId,
    directoryId: grant.directoryId,
    ...(grant.ownerIdentityPubkey ? { ownerIdentityPubkey: grant.ownerIdentityPubkey } : {}),
    appPubkey: grant.appPubkey,
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
    appName: sanitizeDisplayName(grant.appName, MAX_APP_NAME),
    capabilities: normaliseCapabilities(grant.capabilities ?? []).slice(0, MAX_CAPABILITIES),
    railPubkey: grant.railPubkey,
    railPrivateKey: grant.railPrivateKey,
    relay: grant.relay,
    maxStalenessSeconds: grant.maxStalenessSeconds,
    ...(grant.autoAcceptInvites !== undefined ? { autoAcceptInvites: grant.autoAcceptInvites } : {}),
    ...(grant.revokedAt !== undefined ? { revokedAt: grant.revokedAt } : {}),
    appLabels: boundAppLabelsForWire(appLabels),
  };
}

function asObject(raw: string): Record<string, unknown> | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  return obj as Record<string, unknown>;
}

/**
 * M1: collect every individually-valid entry first, THEN cap by
 * `capLabelCount` (highest `updatedAt` first, then key) — never by breaking
 * out of the loop early, which capped by wire/JSON key order instead of the
 * value that is supposed to decide survival.
 */
function parseAppLabels(value: unknown): Record<string, AppLabelEntry> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const collected: Record<string, AppLabelEntry> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!HEX32.test(key)) continue;
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.label !== 'string' || !isNonNegInt(entry.updatedAt)) continue;
    collected[key] = { label: sanitizeDisplayName(entry.label, MAX_APP_LABEL), updatedAt: entry.updatedAt };
  }
  return capLabelCount(collected, MAX_APP_LABELS_PER_GRANT);
}

/**
 * Validate and normalise one candidate grant off the wire. A malformed field
 * drops the WHOLE grant (never a partial record); an individually malformed
 * app-label entry drops only that entry (`parseAppLabels`).
 */
function parseWireGrant(value: unknown): WireGrantV2 | null {
  if (typeof value !== 'object' || value === null) return null;
  const g = value as Record<string, unknown>;

  if (typeof g.grantId !== 'string' || !HEX32.test(g.grantId)) return null;
  if (typeof g.directoryId !== 'string' || !DIRECTORY_ID.test(g.directoryId)) return null;
  if (g.ownerIdentityPubkey !== undefined && (typeof g.ownerIdentityPubkey !== 'string' || !HEX64.test(g.ownerIdentityPubkey))) return null;
  if (typeof g.appPubkey !== 'string' || !HEX64.test(g.appPubkey)) return null;
  if (!isNonNegInt(g.createdAt)) return null;
  if (!isNonNegInt(g.updatedAt)) return null;
  if (typeof g.appName !== 'string') return null;
  if (!Array.isArray(g.capabilities)) return null;
  if (typeof g.railPubkey !== 'string' || !HEX64.test(g.railPubkey)) return null;
  if (typeof g.railPrivateKey !== 'string' || (g.railPrivateKey !== '' && !HEX64.test(g.railPrivateKey))) return null;
  // M2: length-capped before the scheme check, so a pathological string
  // doesn't get far.
  if (typeof g.relay !== 'string' || g.relay.length > MAX_RELAY_LEN || !isValidRelayUrl(g.relay)) return null;
  if (!isNonNegInt(g.maxStalenessSeconds)) return null;
  if (g.autoAcceptInvites !== undefined && typeof g.autoAcceptInvites !== 'boolean') return null;
  if (g.revokedAt !== undefined && !isNonNegInt(g.revokedAt)) return null;

  const capabilities: Capability[] = normaliseCapabilities(
    (g.capabilities as unknown[]).filter(isCapability),
  ).slice(0, MAX_CAPABILITIES);

  return {
    grantId: g.grantId,
    directoryId: g.directoryId,
    ...(typeof g.ownerIdentityPubkey === 'string' ? { ownerIdentityPubkey: g.ownerIdentityPubkey } : {}),
    appPubkey: g.appPubkey.toLowerCase(),
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    appName: sanitizeDisplayName(g.appName, MAX_APP_NAME),
    capabilities,
    railPubkey: g.railPubkey.toLowerCase(),
    railPrivateKey: g.railPrivateKey === '' ? '' : g.railPrivateKey.toLowerCase(),
    relay: g.relay,
    maxStalenessSeconds: clampStaleness(g.maxStalenessSeconds),
    ...(typeof g.autoAcceptInvites === 'boolean' ? { autoAcceptInvites: g.autoAcceptInvites } : {}),
    ...(g.revokedAt !== undefined ? { revokedAt: g.revokedAt } : {}),
    appLabels: parseAppLabels(g.appLabels),
  };
}

/**
 * Parse a decrypted grants-rail payload. Returns null for a broken envelope
 * (wrong version/kind, unparsable JSON, not an object, `grants` not an
 * array). An individually malformed grant is dropped, never the whole
 * payload. R-20/C2: ACTIVE grants read are capped at `CONTACT_GRANT_V2_CAP`;
 * revoked rows are NOT capped here — they are bounded only by the envelope's
 * own size ceiling upstream (`vault-envelope.ts`'s `MAX_ENVELOPE_CHARS`),
 * mirroring the fact that the publish side never sacrifices an active grant
 * to make room for a revoked one.
 */
export function parseGrantsPayload(raw: string): GrantsRailPayload | null {
  const obj = asObject(raw);
  if (!obj) return null;
  if (obj.v !== 2 || obj.kind !== 'grants') return null;
  if (!isNonNegInt(obj.createdAt)) return null;
  if (!Array.isArray(obj.grants)) return null;

  const grants: WireGrantV2[] = [];
  let activeCount = 0;
  for (const candidate of obj.grants) {
    const parsed = parseWireGrant(candidate);
    if (!parsed) continue;
    if (parsed.revokedAt === undefined) {
      if (activeCount >= CONTACT_GRANT_V2_CAP) continue;
      activeCount += 1;
    }
    grants.push(parsed);
  }
  return { v: 2, kind: 'grants', createdAt: obj.createdAt, grants };
}

/** `undefined` loses to any number; otherwise the smaller wins (monotonic revocation). */
function earlierDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** Union app labels by scoped id: per entry, higher `updatedAt` wins, ties keep local. */
function mergeAppLabels(
  local: Record<string, AppLabelEntry>,
  remote: Record<string, AppLabelEntry>,
): Record<string, AppLabelEntry> {
  const out: Record<string, AppLabelEntry> = { ...local };
  for (const [key, remoteEntry] of Object.entries(remote)) {
    const localEntry = out[key];
    if (!localEntry || remoteEntry.updatedAt > localEntry.updatedAt) out[key] = remoteEntry;
  }
  return capLabelCount(out, MAX_APP_LABELS_PER_GRANT);
}

/**
 * A remote-only grant is adopted only when it is ACTIVE (I5/R-21 — a revoked
 * remote-only row is never adopted: a row this device forgot must not come
 * back from the wire, and one it never knew about carries nothing it needs)
 * and carries a usable rail key.
 */
function fromWireOnly(remote: WireGrantV2): AppGrantV2 | null {
  if (remote.revokedAt !== undefined) return null;
  if (!HEX64.test(remote.railPrivateKey)) return null;
  return { ...remote, seenOperationIds: [], appLabels: { ...remote.appLabels } };
}

/** Merge one grant known to both sides. Returns null only if neither side
 *  ends up with a usable rail key (should not happen once `local` existed
 *  with one, but guarded rather than assumed). */
function mergeOne(local: AppGrantV2, remote: WireGrantV2): AppGrantV2 | null {
  // Re-scoping is a new consent decision and must mint a new grant id.
  // An old device may omit scope; it can disable an old grant, never broaden it.
  if (local.ownerIdentityPubkey && remote.ownerIdentityPubkey && local.ownerIdentityPubkey !== remote.ownerIdentityPubkey) return { ...local, revokedAt: earlierDefined(local.revokedAt, remote.revokedAt) };
  const remoteWins = remote.updatedAt > local.updatedAt;
  const base = remoteWins ? remote : local;

  // I4: `railPubkey` and `railPrivateKey` always come from the SAME side.
  // Mixing one side's private key with the other's declared pubkey would
  // silently produce a keypair that does not match — worse than an empty
  // key, because it looks fine until something tries to use it. The winner
  // supplies both, unless the winner's own key is empty, in which case BOTH
  // fields fall back to the other side together.
  const winnerSide = remoteWins ? remote : local;
  const otherSide = remoteWins ? local : remote;
  const keySource = HEX64.test(winnerSide.railPrivateKey) ? winnerSide : otherSide;
  const railPrivateKey = keySource.railPrivateKey;
  const railPubkey = keySource.railPubkey;
  if (!HEX64.test(railPrivateKey)) return null;

  const revokedAt = earlierDefined(local.revokedAt, remote.revokedAt);
  const appLabels = mergeAppLabels(local.appLabels, remote.appLabels);

  return {
    grantId: local.grantId,
    directoryId: base.directoryId,
    ...(base.ownerIdentityPubkey ? { ownerIdentityPubkey: base.ownerIdentityPubkey } : {}),
    appPubkey: base.appPubkey,
    createdAt: local.createdAt,
    updatedAt: base.updatedAt,
    appName: base.appName,
    capabilities: base.capabilities,
    ...((local.updatedAt === remote.updatedAt && (local.autoAcceptInvites === false || remote.autoAcceptInvites === false))
      ? { autoAcceptInvites: false } : base.autoAcceptInvites !== undefined ? { autoAcceptInvites: base.autoAcceptInvites } : {}),
    railPubkey,
    railPrivateKey,
    relay: base.relay,
    maxStalenessSeconds: base.maxStalenessSeconds,
    ...(revokedAt !== undefined ? { revokedAt } : {}),
    appLabels,
    // Device-local fields (S6/R-2): always the LOCAL side's — a second
    // device's replay window and publish state are its own.
    seenOperationIds: local.seenOperationIds,
    ...(local.lastProjectionHash !== undefined ? { lastProjectionHash: local.lastProjectionHash } : {}),
    ...(local.lastProjectionAt !== undefined ? { lastProjectionAt: local.lastProjectionAt } : {}),
    ...(local.lastPublishState !== undefined ? { lastPublishState: local.lastPublishState } : {}),
  };
}

/**
 * M3: only ACTIVE grants count toward `CONTACT_GRANT_V2_CAP` (R-13 — a
 * revoked row is kept for audit, not a reserved slot). The least-recently-
 * updated actives past the cap are dropped deterministically; every revoked
 * row survives this step regardless — the publish-time byte-fit (R-20) is
 * what eventually bounds them.
 *
 * R-23 (Task 28, item 4): this applies to the WIRE BUILD ONLY. Applying it
 * at the end of a merge meant a device already holding `CONTACT_GRANT_V2_CAP`
 * active grants could have one of its OWN silently deleted from local storage
 * by a remote payload that happened to carry newer-`updatedAt` rows — a merge
 * must never destroy a local grant's only copy of its rail private key. The
 * cap is a publishing bound, so it belongs where the publishing happens, and
 * `mergeGrantRegistry` refuses the ADOPTION instead (see `mergeGrantRegistry`).
 */
function capActiveGrants(grants: AppGrantV2[], limit: number): AppGrantV2[] {
  const active = grants.filter((g) => g.revokedAt === undefined);
  if (active.length <= limit) return grants;
  const keptIds = new Set(
    [...active].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit).map((g) => g.grantId),
  );
  return grants.filter((g) => g.revokedAt !== undefined || keptIds.has(g.grantId));
}

/**
 * What a merge produced, plus how many remote-only ACTIVE grants it had to
 * turn away because this device is already at `CONTACT_GRANT_V2_CAP`
 * (R-26). The count is surfaced by `useContactGrantsRail` and said out loud
 * by `GRANTS_SKIPPED_REMOTE_COPY` — a grant that quietly never arrives is
 * indistinguishable, from the owner's seat, from one that was never made.
 */
export interface GrantMergeResult {
  grants: AppGrantV2[];
  skippedRemote: number;
}

/**
 * Merge the local grant registry with a remote wire payload. See the module
 * header for the full rule set (per-grant LWW, monotonic `revokedAt`, per-
 * entry label union, same-side rail keypair, R-21 revoked-remote-only
 * rejection, device-local fields always local).
 *
 * R-23: EVERY local row survives — active or revoked, merged with its remote
 * twin where there is one. A merge is a reconciliation, never a deletion.
 * Even a local row whose rail key is unusable on both sides (`mergeOne`
 * returning null) is kept as-is rather than dropped: it is already
 * unpublishable, and deleting it would destroy the only record that the grant
 * was ever made.
 *
 * R-26: remote-only ACTIVE grants are adopted most-recently-updated first,
 * and only while the ACTIVE total stays within `CONTACT_GRANT_V2_CAP`. The
 * ones turned away are counted in `skippedRemote`. A remote-only REVOKED row
 * is never adopted at all (R-21) and is not counted — it is a deliberate
 * refusal, not a capacity problem, and telling the owner "an app could not be
 * added" about an app that was disconnected would be false. A remote-only
 * active row with no usable `railPrivateKey` is likewise not counted: nothing
 * about the cap stopped it, and adopting it would store a grant that can
 * never publish.
 */
export function mergeGrantRegistry(local: AppGrantV2[], remote: WireGrantV2[]): GrantMergeResult {
  const localById = new Map(local.map((g) => [g.grantId, g] as const));
  const remoteById = new Map(remote.map((g) => [g.grantId, g] as const));

  const out: AppGrantV2[] = [];
  for (const l of local) {
    const r = remoteById.get(l.grantId);
    out.push(r ? (mergeOne(l, r) ?? l) : l);
  }

  let active = out.filter((g) => g.revokedAt === undefined).length;
  let skippedRemote = 0;
  const remoteOnly = remote
    .filter((r) => !localById.has(r.grantId) && r.revokedAt === undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const r of remoteOnly) {
    const fresh = fromWireOnly(r);
    if (!fresh) continue;
    if (active >= CONTACT_GRANT_V2_CAP) { skippedRemote += 1; continue; }
    active += 1;
    out.push(fresh);
  }

  return { grants: out, skippedRemote };
}

/**
 * R-25: is the merged registry strictly RICHER than the remote payload it was
 * merged against — does it carry something the relay's copy does not?
 *
 * The personas rail's `isWireRicherThan` idea, in this rail's terms. It is
 * deliberately NOT a plain inequality: a merged registry is routinely
 * DIFFERENT from the remote one without being richer — a remote-only revoked
 * row is never adopted (R-21), and a remote-only active row can be turned away
 * at the cap (R-26) — and republishing then would overwrite a richer remote
 * record with a poorer one, and flap once per app start. Only things THIS
 * device has that the relay lacks count: a grant absent remotely, a newer
 * `updatedAt`, a revocation the relay has not heard about (or has dated
 * later, since the earliest revocation is the one that wins), or an app label
 * the relay lacks or holds an older version of.
 */
export function isRegistryRicherThan(local: AppGrantV2[], remote: WireGrantV2[]): boolean {
  const remoteById = new Map(remote.map((g) => [g.grantId, g] as const));
  for (const g of local) {
    const r = remoteById.get(g.grantId);
    if (!r) return true;
    if (g.updatedAt > r.updatedAt) return true;
    if (g.updatedAt === r.updatedAt && g.autoAcceptInvites === false && r.autoAcceptInvites !== false) return true;
    if (g.revokedAt !== undefined && (r.revokedAt === undefined || g.revokedAt < r.revokedAt)) return true;
    const remoteLabels = r.appLabels ?? {};
    for (const [key, entry] of Object.entries(g.appLabels ?? {})) {
      const remoteEntry = remoteLabels[key];
      if (!remoteEntry || entry.updatedAt > remoteEntry.updatedAt) return true;
    }
  }
  return false;
}

// Strictly monotonic within the process (S12), mirroring
// `contacts-v2-sync.ts`'s own `nextEventCreatedAt` — spelled locally rather
// than imported so this rail's publish timing has no coupling to the
// checkpoint rail's counter. Units: SECONDS (see the module header) — only
// ever fed a value that has already passed through `normaliseNow`.
let lastEventCreatedAt = 0;
function nextGrantsEventCreatedAt(now: number): number {
  const stamp = Math.max(Math.floor(now), lastEventCreatedAt + 1);
  lastEventCreatedAt = stamp;
  return stamp;
}

/**
 * I3: `now` must be an integer, positive, and plausibly SECONDS (below
 * 1e11 — comfortably above any real Unix-seconds value for centuries, and
 * comfortably below a millisecond epoch, which is ~1.7e12 today). A
 * fractional or millisecond-scale value falls back to the real clock rather
 * than being floored and used as-is, so a caller bug cannot poison the
 * monotonic counter with a value every later publish would then have to
 * exceed.
 */
function normaliseNow(now: number): number {
  return (Number.isInteger(now) && now > 0 && now < 1e11) ? now : Math.floor(Date.now() / 1000);
}

export type GrantsPublishOutcome = 'published' | 'empty' | 'too-large' | 'failed';

/** Does `payload` fit the sealer's own top bucket? Reuses `padToBucket` —
 *  the EXACT predicate `sealVaultPayload` applies — rather than a separate
 *  byte-length threshold that could drift from it. */
function fitsEnvelope(payload: GrantsRailPayload): boolean {
  return padToBucket(JSON.stringify(payload)) !== null;
}

/**
 * Drop the single globally lowest-`updatedAt` app-label entry across every
 * wire grant in `wireGrants` (mutates the array's own entries, not the
 * caller's `AppGrantV2` records). Ties broken by grant index then key, for a
 * deterministic build. Returns false when there is nothing left to drop.
 */
function dropLowestLabelEntry(wireGrants: WireGrantV2[]): boolean {
  let target: { gi: number; key: string; updatedAt: number } | null = null;
  wireGrants.forEach((g, gi) => {
    for (const [key, entry] of Object.entries(g.appLabels)) {
      if (
        !target
        || entry.updatedAt < target.updatedAt
        || (entry.updatedAt === target.updatedAt && (gi < target.gi || (gi === target.gi && key < target.key)))
      ) {
        target = { gi, key, updatedAt: entry.updatedAt };
      }
    }
  });
  if (!target) return false;
  const { gi, key } = target as { gi: number; key: string };
  const { [key]: _dropped, ...rest } = wireGrants[gi].appLabels;
  wireGrants[gi] = { ...wireGrants[gi], appLabels: rest };
  return true;
}

interface BuiltGrantsPayload {
  payload: GrantsRailPayload;
  outcome: 'published';
}
interface BuiltTooLarge {
  payload: null;
  outcome: 'too-large';
}

/**
 * R-20: build the wire payload byte-fitted rather than blind-sliced. Order:
 * every ACTIVE grant (at most `CONTACT_GRANT_V2_CAP`, most recently updated
 * first), then revoked audit rows (most-recently-revoked first). If that
 * does not fit one envelope, shrink in order: (1) revoked rows, oldest first
 * — the array is sorted most-recent-first, so popping the tail drops the
 * oldest; (2) once no revoked rows remain, per-grant `appLabels`, globally
 * lowest-`updatedAt`-first across every surviving active grant; (3) give up
 * — active grants alone, with every label stripped, still do not fit.
 */
function buildGrantsWirePayload(grants: AppGrantV2[], now: number): BuiltGrantsPayload | BuiltTooLarge {
  // Item 5: `MAX_RELAY_LEN` is applied on the BUILD side too, not only in
  // `parseWireGrant`. Without it a grant whose `relay` outgrew the cap would
  // be published and then rejected by every reader — including this device
  // after its next restart — which is strictly worse than not publishing it:
  // the registry looks backed up and silently is not. Dropped with the same
  // determinism as the labels, before any byte-fitting, so the same input
  // always produces the same wire.
  const publishable = capActiveGrants(
    grants.filter((g) => typeof g.relay === 'string' && g.relay.length <= MAX_RELAY_LEN),
    CONTACT_GRANT_V2_CAP,
  );

  const active = publishable
    .filter((g) => g.revokedAt === undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(toWireGrant);

  const revoked = publishable
    .filter((g) => g.revokedAt !== undefined)
    .sort((a, b) => (b.revokedAt as number) - (a.revokedAt as number))
    .map(toWireGrant);

  const payloadOf = (activeGrants: WireGrantV2[], revokedGrants: WireGrantV2[]): GrantsRailPayload => ({
    v: 2, kind: 'grants', createdAt: now, grants: [...activeGrants, ...revokedGrants],
  });

  let candidate = payloadOf(active, revoked);
  if (fitsEnvelope(candidate)) return { payload: candidate, outcome: 'published' };

  // (1) Drop revoked rows oldest-first.
  const remainingRevoked = [...revoked];
  while (remainingRevoked.length > 0) {
    remainingRevoked.pop();
    candidate = payloadOf(active, remainingRevoked);
    if (fitsEnvelope(candidate)) return { payload: candidate, outcome: 'published' };
  }

  // (2) No revoked rows left. Drop labels globally, lowest-updatedAt-first.
  const shrinkingActive = active.map((g) => ({ ...g, appLabels: { ...g.appLabels } }));
  candidate = payloadOf(shrinkingActive, []);
  while (!fitsEnvelope(candidate)) {
    if (!dropLowestLabelEntry(shrinkingActive)) break;
    candidate = payloadOf(shrinkingActive, []);
  }
  if (fitsEnvelope(candidate)) return { payload: candidate, outcome: 'published' };

  // (3) Give up. DEFENSIVE, and unreachable by legitimate volume since R-27:
  // every field that reaches the wire is now bounded on BUILD as well as on
  // read, so the largest registry this rail can legitimately produce is
  // `CONTACT_GRANT_V2_CAP` active grants each carrying a `MAX_APP_NAME`
  // `appName`, at most `MAX_CAPABILITIES` capabilities, a `MAX_RELAY_LEN`
  // relay and `MAX_APP_LABELS_PER_GRANT` labels of `MAX_APP_LABEL` each —
  // and the label-drop pass above always brings that inside one envelope
  // (proven by `the largest legitimate registry never reaches "too-large"`
  // in the test suite, built at every bound simultaneously). The branch is
  // kept rather than replaced with an assertion because "the bounds are all
  // still consistent with the bucket size" is a property of five constants
  // spread across two packages: if a future constant bump breaks it, the
  // honest outcome is a reported `'too-large'` the owner can see, not a
  // truncated registry or a thrown publish.
  return { payload: null, outcome: 'too-large' };
}

/**
 * Seal and publish the grants registry as one replaceable event. Never
 * publishes an information-free record (zero grants ⇒ `'empty'`); never
 * throws — every failure path (bad relay pool, bad backend, a build that
 * cannot fit even active grants alone, a signer refusal, no relay accepting
 * it) resolves to a `GrantsPublishOutcome` rather than a rejection.
 */
export async function publishGrantsV2(args: {
  grants: AppGrantV2[];
  now: number;
  backend: DecryptingSigningBackend;
  relayUrls: string[];
}): Promise<GrantsPublishOutcome> {
  const targets = args.relayUrls.filter(isValidRelayUrl);
  if (targets.length === 0) return 'failed';
  if (!HEX64.test(args.backend.activePublicKeyHex)) return 'failed';
  if (args.grants.length === 0) return 'empty';

  const now = normaliseNow(args.now);

  // I1: building the payload (including every `toWireGrant` call) happens
  // inside the try — a malformed/legacy row must not escape as an unhandled
  // rejection out of a path whose contract everywhere else is "never throw".
  let content: string | null;
  try {
    const built = buildGrantsWirePayload(args.grants, now);
    if (built.outcome === 'too-large') return 'too-large';
    if (built.payload.grants.length === 0) return 'empty';
    content = await sealVaultPayload(JSON.stringify(built.payload), args.backend);
  } catch {
    return 'failed';
  }
  if (content === null) return 'failed';

  const event: UnsignedEvent = {
    kind: GRANTS_RAIL_KIND,
    pubkey: args.backend.activePublicKeyHex.toLowerCase(),
    created_at: nextGrantsEventCreatedAt(now),
    tags: [['d', grantsRailTag(args.backend.activePublicKeyHex)]],
    content,
  };
  try {
    const signed = await args.backend.signEvent(event);
    const ok = await publishToRelays(signed, targets);
    return ok ? 'published' : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * Fetch and open the grants registry. Author-pinned via
 * `fetchNewestFromRelays`; the returned event's own `d` tag is asserted
 * against the tag we queried for, so one misbehaving relay handing back some
 * OTHER event under this author cannot be read as "the grants registry".
 * Records `syncSeen` whenever a `d`-tag-matching event was found — REGARDLESS
 * of whether it could be opened/parsed (Phase D R9, fix round 1 C1): an
 * unreadable-but-present event is still evidence a backup exists, which is
 * exactly what lets a LATER genuinely-missing fetch report
 * `missing-after-seen` instead of `never-seen`. Never throws.
 */
export async function fetchGrantsV2(args: {
  authorPubkey: string;
  backend: DecryptingSigningBackend;
  relayUrls: string[];
}): Promise<{ payload: GrantsRailPayload | null; remoteState: SyncRemoteState }> {
  const authorPubkey = args.authorPubkey.toLowerCase();
  if (!HEX64.test(authorPubkey)) return { payload: null, remoteState: 'unreachable' };

  const targets = args.relayUrls.filter(isValidRelayUrl);
  if (targets.length === 0) return { payload: null, remoteState: 'unreachable' };

  const dTag = grantsRailTag(authorPubkey);
  const probe = await fetchNewestFromRelays(
    { kinds: [GRANTS_RAIL_KIND], authors: [authorPubkey], '#d': [dTag], limit: 1 },
    targets,
    authorPubkey,
  );

  const event: NostrEvent | null = probe.event ?? null;
  const carriesTag = event ? event.tags.some((t) => t[0] === 'd' && t[1] === dTag) : false;
  const validEvent = event && carriesTag ? event : null;

  // Phase D R9 (fix round 1, C1): an event that EXISTS but cannot be opened
  // or parsed is `present` with a null payload, never `missing-after-seen` —
  // classification below is keyed on `validEvent`, never on `payload`.
  let payload: GrantsRailPayload | null = null;
  if (validEvent) {
    let plaintext: string | null = null;
    try {
      plaintext = await openVaultPayload(validEvent.content, args.backend, authorPubkey, { legacyFallback: false });
    } catch {
      plaintext = null;
    }
    if (plaintext !== null) payload = parseGrantsPayload(plaintext);
  }

  let seenBefore = false;
  try {
    seenBefore = (await getSyncSeen(authorPubkey, dTag, { legacyAuthorScopedTag: true })) !== null;
  } catch {
    seenBefore = false;
  }

  const remoteState = classifyFetchOutcome({
    found: validEvent !== null,
    reachableRelays: probe.reachableRelays,
    seenBefore,
  });

  if (validEvent) {
    try {
      await setSyncSeen(authorPubkey, dTag, { eventId: validEvent.id, createdAt: validEvent.created_at });
    } catch {
      // Never fail the read over a failed write of routing metadata.
    }
  }

  return { payload, remoteState };
}
