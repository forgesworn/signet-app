// Companion data rail — sharer side. Derives the per-app rail key, builds and
// publishes secret-stripped snapshots. See the internal companion-data-rail design doc.
import { deriveExtraPersona } from './signet';
import type { UnsignedEvent, NostrEvent } from 'signet-protocol';
import { RelayClient } from 'signet-protocol';
import type { KindredEntry, GrantScope, GrantContactView } from '@forgesworn/kenspeckle';
import { toGrantView, buildGrantEnvelope, GRANT_CONTACTS_CAP } from '@forgesworn/kenspeckle';
import type { DecryptingSigningBackend } from './signing-backend';
import { isValidRelayUrl } from './relay-url';
import { sanitiseAddedAt } from './kindred-adapter';
import type { CompanionGrant } from '../types';
import * as db from './db';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { SNAPSHOT_D_TAG, SNAPSHOT_KIND } from '@forgesworn/kenspeckle/companion-rail';

/**
 * Derive the per-grant rail keypair — a pure function of (mnemonic, appPubkey),
 * so re-pairing the same app after a phone loss re-derives the SAME key and the
 * replaceable snapshot keeps continuity. Distinct nsec-tree branch from NP.
 */
export function deriveRailKeypair(
  mnemonic: string,
  appPubkey: string,
): { publicKey: string; privateKey: string } {
  return deriveExtraPersona(mnemonic, `signet-companion-rail:${appPubkey}`);
}

export { SNAPSHOT_D_TAG } from '@forgesworn/kenspeckle/companion-rail';

/** Plain code-point string comparison — NOT `localeCompare`, whose collation
 *  can vary by locale/runtime. Every device must compute the identical
 *  over-cap trim from the identical input, so every tiebreak below needs a
 *  comparator that is the same function everywhere this code runs. */
function cpCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Filter the full contact/ken set down to what a scope grant permits: tier
 * membership plus an optional persona allowlist ('all' = every owning
 * persona). This is the ONE place every envelope-building path (contacts
 * AND kens, both `useCompanionRail`'s publish-on-change loop and App.tsx's
 * post-pairing initial snapshot — both call `publishSnapshot`, which calls
 * this) routes through, so it also sanitises `addedAt` (via
 * `sanitiseAddedAt`) and drops any entry it can't be made valid for —
 * dropping upstream, at the contact/ken adapter or display layer, would
 * hide a record from the user over a bad timestamp for no reason; dropping
 * here is required, because `buildGrantEnvelope` (kenspeckle 0.2.0) throws
 * for the WHOLE envelope over a single invalid `addedAt`, contact OR ken.
 *
 * Also caps the result at kenspeckle's own `GRANT_CONTACTS_CAP` (5000) —
 * `buildGrantEnvelope` throws past that many contacts too, killing the
 * whole snapshot rather than trimming it. The trim is deterministic (most
 * recently added first, then ownerPubkey/tier/pubkey as code-point-compared
 * tiebreaks) so two devices computing the same over-cap scope pick the same
 * entries in the same order.
 */
export function filterByScope(entries: KindredEntry[], scope: GrantScope): KindredEntry[] {
  const inScope: KindredEntry[] = [];
  for (const e of entries) {
    if (!scope.tiers.includes(e.tier)) continue;
    if (scope.personas !== 'all' && !scope.personas.includes(e.ownerPubkey)) continue;
    const addedAt = sanitiseAddedAt(e.addedAt);
    if (addedAt === null) continue;
    inScope.push(addedAt === e.addedAt ? e : ({ ...e, addedAt } as KindredEntry));
  }
  if (inScope.length <= GRANT_CONTACTS_CAP) return inScope;
  return [...inScope]
    .sort((a, b) =>
      b.addedAt - a.addedAt ||
      cpCompare(a.ownerPubkey, b.ownerPubkey) ||
      cpCompare(a.tier, b.tier) ||
      cpCompare(a.pubkey, b.pubkey),
    )
    .slice(0, GRANT_CONTACTS_CAP);
}

/** Stable dedupe hash of a snapshot — sort by pubkey so order can't churn it,
 *  then sha-256 the canonical JSON of the sorted view set + the scope
 *  (hex-encoded). `useCompanionRail` persists the result as `lastPayloadHash`
 *  in IDB, so this must be a real one-way digest, never the plaintext
 *  contact rolodex — see repo precedent `contentHashFor` in
 *  public-profile-publish.ts. Not a signing/security primitive beyond that:
 *  it only needs to be order-stable and content-sensitive for dedupe. */
export function hashSnapshot(scope: GrantScope, views: GrantContactView[]): string {
  const sorted = [...views].sort((a, b) => a.pubkey.localeCompare(b.pubkey));
  const canonical = JSON.stringify({ scope, sorted });
  return bytesToHex(sha256(new TextEncoder().encode(canonical)));
}

/**
 * Build and sign a snapshot event with the derived rail key: kind 30078,
 * `d` tag only (no `#p` — the recipient stays off the wire), content is
 * the NIP-44-encrypted grant envelope addressed to the companion app's
 * pubkey. Pass `{ revoked: true }` to build a tombstone (empty contacts).
 */
export async function buildSnapshotEvent(
  scope: GrantScope,
  views: GrantContactView[],
  publishedAt: number,
  railBackend: DecryptingSigningBackend,
  appPubkey: string,
  opts?: { revoked?: true },
): Promise<NostrEvent> {
  const plaintext = buildGrantEnvelope(scope, views, publishedAt, opts);
  const content = await railBackend.nip44Encrypt(appPubkey, plaintext);
  const event: UnsignedEvent = {
    kind: SNAPSHOT_KIND,
    pubkey: railBackend.activePublicKeyHex,
    created_at: publishedAt,
    tags: [['d', SNAPSHOT_D_TAG]],
    content,
  };
  return railBackend.signEvent(event);
}

/**
 * Gather → filter → hash → build → publish a companion snapshot.
 * Best-effort: any relay/network failure returns `ok: false` rather than
 * throwing, since a failed snapshot publish shouldn't break the caller's
 * flow (the next scope/contact change retries the publish). `filterByScope`
 * already sanitises the cap; the `buildSnapshotEvent` call is still guarded
 * here (rather than left to escape into the caller) so a kenspeckle
 * validation throw over some field this module hasn't anticipated degrades
 * to `ok: false` too, honouring this function's own contract.
 */
export async function publishSnapshot(
  scope: GrantScope,
  entries: KindredEntry[],
  publishedAt: number,
  railBackend: DecryptingSigningBackend,
  appPubkey: string,
  relayUrl: string,
): Promise<{ ok: boolean; eventId?: string; hash: string }> {
  const views = filterByScope(entries, scope).map(toGrantView);
  const hash = hashSnapshot(scope, views);
  if (!isValidRelayUrl(relayUrl)) return { ok: false, hash };
  let signed: NostrEvent;
  try {
    signed = await buildSnapshotEvent(scope, views, publishedAt, railBackend, appPubkey);
  } catch {
    return { ok: false, hash };
  }
  const relay = new RelayClient(relayUrl);
  try {
    await relay.connect();
    const res = await relay.publish(signed);
    return { ok: res.ok, eventId: signed.id, hash };
  } catch {
    return { ok: false, hash };
  } finally {
    relay.disconnect();
  }
}

/**
 * Publish a tombstone snapshot (same replaceable `d` tag, `revoked: true`,
 * empty contacts) so the companion app's next fetch sees the grant is
 * gone rather than silently keeping the last snapshot. Best-effort, same
 * as `publishSnapshot` — never throws.
 */
export async function publishTombstone(
  scope: GrantScope,
  railBackend: DecryptingSigningBackend,
  appPubkey: string,
  relayUrl: string,
  publishedAt: number,
): Promise<boolean> {
  if (!isValidRelayUrl(relayUrl)) return false;
  const signed = await buildSnapshotEvent(scope, [], publishedAt, railBackend, appPubkey, { revoked: true });
  const relay = new RelayClient(relayUrl);
  try {
    await relay.connect();
    const res = await relay.publish(signed);
    return res.ok;
  } catch {
    return false;
  } finally {
    relay.disconnect();
  }
}

/**
 * Revoke a grant: overwrite the replaceable snapshot with a revoked, empty
 * tombstone (so the relay's latest state holds no contacts), best-effort
 * kind-5 delete of the last snapshot, then delete the local grant record.
 * Copy semantics: cannot recall what the app already downloaded.
 *
 * If the tombstone publish itself fails (relay unreachable/invalid), do NOT
 * delete the local record — that would leave the relay's last-known
 * snapshot as the real, un-revoked contact set with nothing local left to
 * retry the tombstone. Instead soft-tombstone: save the grant with
 * `revokedAt` set and keep it around. The existing `revokedAt` readers
 * (useCompanionRail's publish loop, the unlock-time rail-backend rebuild in
 * App.tsx) already skip these, and App.tsx's unlock-time retry effect
 * re-attempts the tombstone publish (and this same delete-vs-soft-tombstone
 * decision) on every subsequent unlock until it succeeds.
 */
export async function revokeCompanionGrant(
  grant: CompanionGrant,
  railBackend: DecryptingSigningBackend,
  relayUrl: string,
): Promise<void> {
  const nowS = Math.floor(Date.now() / 1000);
  const tombstoned = await publishTombstone(grant.scope, railBackend, grant.appPubkey, grant.snapshotRelay || relayUrl, nowS);
  if (!tombstoned) {
    await db.saveCompanionGrant({ ...grant, revokedAt: nowS });
    return;
  }
  if (grant.lastEventId && isValidRelayUrl(grant.snapshotRelay || relayUrl)) {
    try {
      const del: UnsignedEvent = {
        kind: 5,
        pubkey: railBackend.activePublicKeyHex,
        created_at: nowS,
        tags: [['e', grant.lastEventId]],
        content: 'grant revoked',
      };
      const signed = await railBackend.signEvent(del);
      const relay = new RelayClient(grant.snapshotRelay || relayUrl);
      try {
        await relay.connect();
        await relay.publish(signed);
      } catch {
        /* best-effort */
      } finally {
        relay.disconnect();
      }
    } catch {
      /* best-effort */
    }
  }
  await db.deleteCompanionGrant(grant.appPubkey);
}
