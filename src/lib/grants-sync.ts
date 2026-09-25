/**
 * Cross-device grants sync.
 *
 * Extends the per-user sync pattern (NIP-44-encrypted kind-30078
 * replaceable events) to `RememberedGrant` records so a guardian who
 * approves `allow-always roblox.com` on their phone doesn't re-prompt on
 * their iPad. LWW merge per compound key (dependantId, scope, origin).
 *
 * **Tombstones.** Revocations soft-delete on the publishing device —
 * `revokeGrant` flips `tombstonedAt` rather than hard-deleting the row —
 * so the absence of a grant in the latest sync payload isn't ambiguous
 * with "it was never there." Tombstones ride along as regular records
 * with `tombstonedAt` set. The merge compares `max(decidedAt, tombstonedAt)`
 * on each side so the newest action (allow, deny, or revoke) wins.
 *
 * **Author.** The guardian's natural-person pubkey — same anchor used by
 * contacts / credentials / dependants sync, so all four rails publish
 * under the same stable identity.
 */

import type { UnsignedEvent } from 'signet-protocol';
import type { RememberedGrant, GrantSchedule } from '../types';
import { validateSchedule } from './grant-schedule';
import type { DecryptingSigningBackend } from './signing-backend';
import { isValidRelayUrl } from './relay-url';
import { readSyncPlaintext, type SyncDecryptCache } from './sync-decrypt-cache';
import { publishToRelays, fetchNewestFromRelays } from './sync-relays';
import { sealVaultPayload, openVaultPayloadOrThrow } from './vault-envelope';

export const SYNC_D_TAG = 'signet:grants';
const SYNC_KIND = 30078;
const SCHEMA_V = 1;

interface SyncedGrantsPayload {
  v: number;
  grants: RememberedGrant[];
}

/**
 * Publish the full grants set (live records + tombstones) to the user's
 * relay. Returns true on relay acceptance, false on any error — a false
 * return is not fatal; the next mutation triggers another publish.
 */
export async function publishGrantsSync(
  grants: RememberedGrant[],
  backend: DecryptingSigningBackend,
  relayUrls: string | string[],
): Promise<boolean> {
  const targets = (typeof relayUrls === 'string' ? [relayUrls] : relayUrls).filter(isValidRelayUrl);
  if (targets.length === 0) return false;

  const payload: SyncedGrantsPayload = { v: SCHEMA_V, grants };
  // Never publish an information-free record (see personas-sync.ts) — an
  // empty record carries no information and can only destroy a real one.
  // Grant tombstones ride along as ordinary records with `tombstonedAt`
  // set, so a zero-length list really is zero records AND zero tombstones.
  if (payload.grants.length === 0) return false;
  // Vault envelope v2 (see `vault-envelope.ts`): AES-256-GCM over a padded
  // body, with only the 32-byte content key on the NIP-44 leg. A payload over
  // the top bucket cannot be chunked by this rail, so it refuses to publish
  // rather than truncating — same posture as the information-free guard above.
  const encrypted = await sealVaultPayload(JSON.stringify(payload), backend);
  if (encrypted === null) return false;
  const event: UnsignedEvent = {
    kind: SYNC_KIND,
    pubkey: backend.activePublicKeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', SYNC_D_TAG]],
    content: encrypted,
  };
  const signed = await backend.signEvent(event);

  return publishToRelays(signed, targets);
}

/**
 * Fetch the latest grants-sync event for `authorPubkey` and decrypt it.
 *
 * Returns `null` when no event has been published, the relay is
 * unreachable, or the payload fails validation.
 */
export async function fetchGrantsSync(
  authorPubkey: string,
  backend: DecryptingSigningBackend,
  relayUrls: string | string[],
  sinceCreatedAt?: number,
  /**
   * Optional decrypt cache (family-bunker §11.1.10). On a hit, an
   * unchanged relay event needs no `nip44_decrypt` round-trip to the
   * signing device — which post-migration is a 0.4–2 s NIP-46 call.
   */
  cache?: SyncDecryptCache,
): Promise<{ grants: RememberedGrant[]; createdAt: number; eventId: string; reachableRelays: number } | null | 'unreachable'> {
  const targets = (typeof relayUrls === 'string' ? [relayUrls] : relayUrls).filter(isValidRelayUrl);
  if (targets.length === 0) return 'unreachable';
  // A malformed author is a caller bug, not a relay-reachability fact —
  // return null (nothing found), not 'unreachable'.
  if (!/^[0-9a-f]{64}$/i.test(authorPubkey)) return null;

  const { event: latest, reachableRelays } = await fetchNewestFromRelays(
    { kinds: [SYNC_KIND], authors: [authorPubkey], '#d': [SYNC_D_TAG], limit: 1 },
    targets,
    authorPubkey,
  );

  if (reachableRelays === 0) return 'unreachable';
  if (!latest) return null;
  if (sinceCreatedAt !== undefined && latest.created_at <= sinceCreatedAt) {
    return null;
  }
  try {
    const plaintext = await readSyncPlaintext(
      cache,
      latest,
      () => openVaultPayloadOrThrow(latest.content, backend, authorPubkey),
    );
    const grants = parsePayload(plaintext);
    if (!grants) return null;
    return { grants, createdAt: latest.created_at, eventId: latest.id, reachableRelays };
  } catch {
    return null;
  }
}

const HEX64 = /^[0-9a-f]{64}$/i;

export function parsePayload(raw: string): RememberedGrant[] | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (typeof obj !== 'object' || obj === null) return null;
  const p = obj as Record<string, unknown>;
  if (typeof p.v !== 'number' || p.v > SCHEMA_V) return null;
  if (!Array.isArray(p.grants)) return null;

  const out: RememberedGrant[] = [];
  for (const item of p.grants) {
    if (typeof item !== 'object' || item === null) continue;
    const g = item as Record<string, unknown>;
    if (typeof g.dependantId !== 'string' || !HEX64.test(g.dependantId)) continue;
    if (typeof g.scope !== 'string' || g.scope.length === 0) continue;
    if (typeof g.origin !== 'string' || g.origin.length === 0) continue;
    if (g.decision !== 'allow' && g.decision !== 'deny') continue;
    if (typeof g.decidedAt !== 'number' || g.decidedAt <= 0) continue;

    const rec: RememberedGrant = {
      dependantId: g.dependantId.toLowerCase(),
      scope: g.scope.toLowerCase(),
      origin: g.origin.toLowerCase(),
      decision: g.decision,
      decidedAt: g.decidedAt,
    };
    if (typeof g.expiresAt === 'number' && g.expiresAt > 0) rec.expiresAt = g.expiresAt;
    if (typeof g.lastUsedAt === 'number' && g.lastUsedAt > 0) rec.lastUsedAt = g.lastUsedAt;
    if (typeof g.tombstonedAt === 'number' && g.tombstonedAt > 0) rec.tombstonedAt = g.tombstonedAt;
    // Charter clause #1: schedule on the wire (phase 3). Validate
    // defensively — the wire is decrypted from gift-wrap addressed to
    // our own pubkey, but a buggy / rogue / older client could
    // include a malformed schedule. Drop the schedule field on
    // validation failure rather than rejecting the whole grant
    // (the rest of the record is still useful).
    const candidateSchedule = parseScheduleField(g.schedule);
    if (candidateSchedule) rec.schedule = candidateSchedule;
    out.push(rec);
  }
  return out;
}

/**
 * Defensive schedule parser for inbound wire records. Returns the
 * validated schedule or undefined if the input is missing / malformed.
 * Used by both grants-sync (per-origin schedule on a grant) and
 * dependants-sync (defaultSchedule on a dep record); exported for
 * reuse but kept module-local.
 */
export function parseScheduleField(raw: unknown): GrantSchedule | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') return undefined;
  try {
    validateSchedule(raw as GrantSchedule);
    return raw as GrantSchedule;
  } catch {
    return undefined;
  }
}

/** Compound key for the grants store and the merge map. */
function grantKey(g: RememberedGrant): string {
  return `${g.dependantId}|${g.scope}|${g.origin}`;
}

/**
 * Effective timestamp for last-write-wins. A tombstone is "newer" than
 * an older allow/deny on the same key, so the per-side action time is
 * `max(decidedAt, tombstonedAt)`. Equivalent-timestamp ties fall to the
 * tombstone (revocation wins on tie — safer default).
 */
function effectiveTime(g: RememberedGrant): number {
  return Math.max(g.decidedAt, g.tombstonedAt ?? 0);
}

/**
 * Merge local + remote grants by last-write-wins on the compound key.
 * A record with a newer `effectiveTime` wins. Ties go to the side that
 * has a tombstone set (revocations are sticky on ties).
 *
 * The schedule field rides on its own LWW (independent of effectiveTime)
 * keyed on `schedule.issuedAt`. This means a parent's freshly-issued
 * schedule on phone propagates to the iPad even if the iPad has a
 * newer grant decision — and vice versa. The two timestamps are
 * conceptually distinct: `decidedAt` records when the parent decided
 * "allow this origin", `schedule.issuedAt` records when they tightened
 * its hours. Either can be more recent.
 *
 * Returns the merged list + a `toSave` subset the caller can hand to
 * the IDB writer — records where any field changed and we need to
 * persist the update locally.
 */
export function mergeGrantLists(
  local: RememberedGrant[],
  remote: RememberedGrant[],
): { merged: RememberedGrant[]; toSave: RememberedGrant[] } {
  const byKey = new Map<string, RememberedGrant>();
  for (const g of local) byKey.set(grantKey(g), g);

  const toSave: RememberedGrant[] = [];
  for (const r of remote) {
    const key = grantKey(r);
    const l = byKey.get(key);
    if (!l) {
      byKey.set(key, r);
      toSave.push(r);
      continue;
    }

    // Grant-fields LWW (existing): newer effectiveTime wins; ties to
    // tombstone if one side has it.
    const rt = effectiveTime(r);
    const lt = effectiveTime(l);
    const grantWins = rt > lt || (rt === lt && !!r.tombstonedAt && !l.tombstonedAt);

    // Schedule LWW (independent): newer issuedAt wins; remote on ties.
    const newSchedule = pickNewerSchedule(l.schedule, r.schedule);

    if (grantWins) {
      // Remote grant wins; combine with whichever schedule is fresher.
      const merged: RememberedGrant = { ...r };
      if (newSchedule !== undefined) merged.schedule = newSchedule;
      else delete merged.schedule;
      byKey.set(key, merged);
      toSave.push(merged);
    } else if (newSchedule !== l.schedule) {
      // Local grant wins, but remote contributed a newer schedule.
      // Update only the schedule field on the local record.
      const merged: RememberedGrant = { ...l };
      if (newSchedule !== undefined) merged.schedule = newSchedule;
      else delete merged.schedule;
      byKey.set(key, merged);
      toSave.push(merged);
    }
    // else: local has equal-or-newer grant + equal-or-newer schedule — no change
  }

  return { merged: Array.from(byKey.values()), toSave };
}

/**
 * Pick the freshest of two schedules by `issuedAt`. Either may be
 * undefined. Remote wins on tie (matches the rest of the merge's
 * remote-on-tie posture under `effectiveTime`).
 */
function pickNewerSchedule(
  local: GrantSchedule | undefined,
  remote: GrantSchedule | undefined,
): GrantSchedule | undefined {
  if (local === undefined && remote === undefined) return undefined;
  if (local === undefined) return remote;
  if (remote === undefined) return local;
  return remote.issuedAt >= local.issuedAt ? remote : local;
}
