/**
 * Cross-device credentials sync, Phase 3.
 *
 * Publishes the user's `StoredCredential[]` as a NIP-44-encrypted
 * replaceable Nostr event (kind 30078, `d` = `signet:credentials`).
 * On unlock, fetches the latest event and merges by LWW-per-credential
 * keyed by `verifiedAt`.
 *
 * What's in the payload:
 * - `id`, `documentId`, `keypairType`
 * - `event` (full signed kind-30470 credential JSON — public on relay
 *   anyway, included here so the receiver has the complete record)
 * - `merkleProofs` (public — companion proofs for selective disclosure)
 * - `merkleLeaves` (**private** — the user's own attribute values; this
 *   is why we NIP-44-encrypt the payload)
 * - `verifierPubkey`, `verifiedAt`, `verifierStatus`
 *
 * At-rest vs in-transit security: credentials are currently stored
 * **unencrypted** in local IndexedDB (a known architectural limitation;
 * see the known-limitations note). NIP-44 encryption in transit is still a net security
 * win — the relay operator can't read the payload — and doesn't make
 * the at-rest situation any worse.
 *
 * **Dangling documentId on receive:** `documentId` references a local
 * `IdentityDocument` record. If the receiver doesn't have that
 * document (documents aren't currently synced), the credential is
 * saved with a dangling reference. Existing UI already tolerates that
 * — credentials show verifier info independently.
 *
 * No-deletion policy (same as contacts/dependants): a credential
 * missing from the remote payload doesn't get removed locally. Users
 * delete on each device separately.
 */

import type { UnsignedEvent } from 'signet-protocol';
import type { StoredCredential } from '../types';
import type { DecryptingSigningBackend } from './signing-backend';
import { isValidRelayUrl } from './relay-url';
import { readSyncPlaintext, type SyncDecryptCache } from './sync-decrypt-cache';
import { publishToRelays, fetchNewestFromRelays } from './sync-relays';
import { sealVaultPayload, openVaultPayloadOrThrow } from './vault-envelope';

export const SYNC_D_TAG = 'signet:credentials';
const SYNC_KIND = 30078;
const SCHEMA_V = 1;

interface SyncedCredentialsPayload {
  v: number;
  credentials: StoredCredential[];
}


export async function publishCredentialsSync(
  credentials: StoredCredential[],
  backend: DecryptingSigningBackend,
  relayUrls: string | string[],
): Promise<boolean> {
  const targets = (typeof relayUrls === 'string' ? [relayUrls] : relayUrls).filter(isValidRelayUrl);
  if (targets.length === 0) return false;

  const payload: SyncedCredentialsPayload = { v: SCHEMA_V, credentials };
  // Never publish an information-free record (see personas-sync.ts) — an
  // empty record carries no information and can only destroy a real one.
  if (payload.credentials.length === 0) return false;
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

export async function fetchCredentialsSync(
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
): Promise<{ credentials: StoredCredential[]; createdAt: number; eventId: string; reachableRelays: number } | null | 'unreachable'> {
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
  if (sinceCreatedAt !== undefined && latest.created_at <= sinceCreatedAt) return null;

  try {
    const plaintext = await readSyncPlaintext(
      cache,
      latest,
      () => openVaultPayloadOrThrow(latest.content, backend, authorPubkey),
    );
    const credentials = parsePayload(plaintext);
    if (!credentials) return null;
    return { credentials, createdAt: latest.created_at, eventId: latest.id, reachableRelays };
  } catch {
    return null;
  }
}

// Bounds on the decrypted sync payload (security audit 2026-06-15). Events are
// NIP-44-encrypted to the user's own key (a third party can't forge them), but
// a malicious relay can replay and a compromised sibling device can author —
// and the result is persisted to IDB. Cap counts + free-text lengths so an
// oversized payload can't bloat storage / DoS the merge.
const MAX_SYNC_CREDENTIALS = 500;
const MAX_EVENT_LEN = 16384;
const MAX_ROUTING_FIELD_LEN = 1024;
const MAX_LEAVES = 256;
const MAX_LEAF_VALUE_LEN = 1024;

/** Exported for direct unit testing (M11 field round-trip). */
export function parsePayload(raw: string): StoredCredential[] | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (typeof obj !== 'object' || obj === null) return null;
  const p = obj as Record<string, unknown>;
  if (typeof p.v !== 'number' || p.v > SCHEMA_V) return null;
  if (!Array.isArray(p.credentials)) return null;
  if (p.credentials.length > MAX_SYNC_CREDENTIALS) return null;

  const out: StoredCredential[] = [];
  for (const item of p.credentials) {
    if (typeof item !== 'object' || item === null) continue;
    const c = item as Record<string, unknown>;
    if (typeof c.id !== 'string' || !/^[0-9a-f]{64}$/i.test(c.id)) continue;
    if (typeof c.documentId !== 'string' || c.documentId.length > MAX_ROUTING_FIELD_LEN) continue;
    if (c.keypairType !== 'natural-person' && c.keypairType !== 'persona' && c.keypairType !== 'professional') continue;
    if (typeof c.event !== 'string' || c.event.length > MAX_EVENT_LEN) continue;
    if (typeof c.verifierPubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(c.verifierPubkey)) continue;
    if (typeof c.verifiedAt !== 'number') continue;
    // M11 (2026-07-02 audit): 'expired-pending' is a valid StoredCredential
    // status (see types/credentials.ts) — rejecting it here dropped the
    // WHOLE credential from the sync payload once it lapsed.
    if (c.verifierStatus !== 'confirmed' && c.verifierStatus !== 'pending' && c.verifierStatus !== 'expired-pending') continue;

    const cred: StoredCredential = {
      id: c.id.toLowerCase(),
      documentId: c.documentId,
      keypairType: c.keypairType,
      event: c.event,
      verifierPubkey: c.verifierPubkey.toLowerCase(),
      verifiedAt: c.verifiedAt,
      verifierStatus: c.verifierStatus,
    };
    if (typeof c.merkleProofs === 'string' && c.merkleProofs.length <= MAX_EVENT_LEN) cred.merkleProofs = c.merkleProofs;
    if (c.merkleLeaves && typeof c.merkleLeaves === 'object') {
      const leaves: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.merkleLeaves)) {
        if (Object.keys(leaves).length >= MAX_LEAVES) break;
        if (typeof v === 'string' && v.length <= MAX_LEAF_VALUE_LEN && k.length <= MAX_ROUTING_FIELD_LEN) leaves[k] = v;
      }
      if (Object.keys(leaves).length > 0) cred.merkleLeaves = leaves;
    }
    // M11: these four timestamps drive lapse/revocation/expiry/confirmation
    // logic elsewhere (computeLapseStatus, revoke UI, expiry checks) — they
    // were previously dropped on receive, so a credential synced onto a
    // second device would silently lose e.g. its revoked/expired state.
    if (typeof c.pendingIssuedAt === 'number') cred.pendingIssuedAt = c.pendingIssuedAt;
    if (typeof c.confirmationAt === 'number') cred.confirmationAt = c.confirmationAt;
    if (typeof c.expiresAt === 'number') cred.expiresAt = c.expiresAt;
    if (typeof c.revokedAt === 'number') cred.revokedAt = c.revokedAt;
    out.push(cred);
  }
  return out;
}

/**
 * Ordinal precedence among verifierStatus values — used ONLY as a
 * verifiedAt-tie-break in `isNewer` (M11). `verifiedAt` is stamped once
 * at initial verification and does not change on a later status
 * transition (e.g. pending → confirmed), so two devices can genuinely
 * disagree on status while sharing the same verifiedAt. Higher rank
 * wins. `expired-pending` ranks with `pending` — a time-based lapse
 * isn't forward progress, just decay.
 */
const STATUS_RANK: Record<StoredCredential['verifierStatus'], number> = {
  pending: 0,
  'expired-pending': 0,
  confirmed: 1,
};

/**
 * Should `candidate` replace `existing` in the merge? Primary key is
 * `verifiedAt` (existing LWW). On a tie (M11 — see STATUS_RANK doc):
 *   1. A revocation is authoritative — never let a stale sync un-revoke
 *      a credential the user already revoked locally.
 *   2. Otherwise prefer the higher-ranked status (confirmed beats
 *      pending/expired-pending) — a genuinely newer confirmation must
 *      not lose to a stale pending record with the same verifiedAt.
 *   3. Otherwise prefer whichever side confirmed more recently.
 *   4. Otherwise keep `existing` (stable, matches prior no-op behaviour).
 */
function isNewer(candidate: StoredCredential, existing: StoredCredential): boolean {
  if (candidate.verifiedAt !== existing.verifiedAt) {
    return candidate.verifiedAt > existing.verifiedAt;
  }

  const candidateRevoked = candidate.revokedAt !== undefined;
  const existingRevoked = existing.revokedAt !== undefined;
  if (candidateRevoked !== existingRevoked) return candidateRevoked;
  if (candidateRevoked && existingRevoked) {
    return (candidate.revokedAt as number) > (existing.revokedAt as number);
  }

  const candidateRank = STATUS_RANK[candidate.verifierStatus];
  const existingRank = STATUS_RANK[existing.verifierStatus];
  if (candidateRank !== existingRank) return candidateRank > existingRank;

  if (candidate.confirmationAt !== undefined || existing.confirmationAt !== undefined) {
    return (candidate.confirmationAt ?? 0) > (existing.confirmationAt ?? 0);
  }

  return false;
}

/** LWW-per-credential merge by `verifiedAt`, with a status-transition
 *  tiebreak on ties (M11 — see `isNewer`). No-deletion. */
export function mergeCredentialLists(local: StoredCredential[], remote: StoredCredential[]): {
  merged: StoredCredential[];
  toSave: StoredCredential[];
} {
  const byId = new Map<string, StoredCredential>();
  for (const c of local) byId.set(c.id, c);

  const toSave: StoredCredential[] = [];
  for (const r of remote) {
    const l = byId.get(r.id);
    if (!l || isNewer(r, l)) {
      byId.set(r.id, r);
      toSave.push(r);
    }
  }
  return { merged: Array.from(byId.values()), toSave };
}
