/**
 * Cross-device contacts sync, Phase 1.
 *
 * Publishes the user's contacts (people they've verified via Signet Me
 * words) as a NIP-44-encrypted kind-30078 replaceable Nostr event,
 * addressed to the user's own pubkey. Retrieves on unlock, merges by
 * last-writer-wins per contact (keyed by verifiedAt), and persists to
 * the local IndexedDB contacts store.
 *
 * Design decisions:
 *
 * - **Event kind:** NIP-78 (kind 30078) with `d` tag `signet:contacts`.
 *   Interop with existing Nostr tooling that understands NIP-78.
 * - **Author:** the user's natural-person pubkey (the stable root). All
 *   contacts for any keypair on the identity roll up under NP.
 *   Persona-level sync isolation is a follow-up if users ask for it.
 * - **Encryption:** NIP-44 v2 to self. Relay sees author pubkey + event
 *   size + cadence but not contents. Acceptable for v1.
 * - **Conflict resolution:** LWW per contact, keyed by `verifiedAt`.
 *   Contacts are append-mostly; the LWW-per-record approach handles
 *   re-verifications (updated verifiedAt wins) without fighting over
 *   the sparse metadata fields.
 * - **Rollback/replay protection:** clients reject events with
 *   `created_at` ≤ the last one they applied. Prevents a malicious
 *   relay serving stale state.
 * - **What's NOT synced:** dependants (contain private keys),
 *   credentials (stored unencrypted at rest — separate work), UI
 *   preferences (per-device), authorized sites (per-device sessions),
 *   bunker pairings (don't survive copying).
 */

import type { UnsignedEvent } from 'signet-protocol';
import type { Contact, SignetIdentity } from '../types';
import type { DecryptingSigningBackend } from './signing-backend';
import { isValidRelayUrl } from './relay-url';
import { readSyncPlaintext, type SyncDecryptCache } from './sync-decrypt-cache';
import { publishToRelays, fetchNewestFromRelays } from './sync-relays';
import { openVaultPayloadOrThrow } from './vault-envelope';

export const SYNC_D_TAG = 'signet:contacts';
const SYNC_KIND = 30078;
const SCHEMA_V = 1;

/** Wire shape of the encrypted payload. */
interface SyncedContactsPayload {
  v: number;
  contacts: Contact[];
}

/**
 * Publish a set of contacts to the user's relay. The caller is
 * responsible for gathering contacts across all keypairs on the
 * identity (NP + Persona + Extras) and passing a plaintext
 * `sharedSecret` in each record — at-rest encryption is transparent
 * to this layer.
 *
 * `backend` must be the user's NP signing backend — it signs the
 * kind-30078 event AND NIP-44-encrypts the payload to itself.
 *
 * Returns `true` when the relay accepts the publish, `false` on any
 * error. A false return is not fatal — the next mutation triggers
 * another publish, and the local IDB copy remains authoritative.
 */
/**
 * NOTE: this rail deliberately still publishes a bare NIP-44 payload (v1).
 * `useContactsSync` gates it behind `publishEnabled`, so the app stops calling
 * it once the contacts v2 rail has proved a round trip; but if the §8.4 lossy
 * legacy-write compatibility window is ever revived, it exists precisely so
 * OLD clients can read it — which means v1. `fetchContactsSync` reads both
 * formats. Ruling R5.
 */
export async function publishContactsSync(
  contacts: Contact[],
  backend: DecryptingSigningBackend,
  relayUrls: string | string[],
): Promise<boolean> {
  const targets = (typeof relayUrls === 'string' ? [relayUrls] : relayUrls).filter(isValidRelayUrl);
  if (targets.length === 0) return false;

  const payload: SyncedContactsPayload = { v: SCHEMA_V, contacts };
  // Never publish an information-free record (see personas-sync.ts) — an
  // empty record carries no information and can only destroy a real one.
  if (payload.contacts.length === 0) return false;
  const encrypted = await backend.nip44Encrypt(
    backend.activePublicKeyHex,
    JSON.stringify(payload),
  );

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
 * Fetch the latest synced contacts event for `authorPubkey` and
 * decrypt it to a `Contact[]`.
 *
 * Returns `null` when:
 *   - No event has ever been published (new user on a new device).
 *   - The relay is unreachable.
 *   - The payload fails decryption or validation.
 *
 * `sinceCreatedAt`, when set, filters out events at or before that
 * timestamp (rollback/replay protection).
 */
export async function fetchContactsSync(
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
): Promise<{ contacts: Contact[]; createdAt: number; eventId: string; reachableRelays: number } | null | 'unreachable'> {
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
    const contacts = parsePayload(plaintext);
    if (!contacts) return null;
    return { contacts, createdAt: latest.created_at, eventId: latest.id, reachableRelays };
  } catch {
    return null;
  }
}

/** Shape-check a decrypted payload. Returns null on any malformation. */
function parsePayload(raw: string): Contact[] | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (typeof obj !== 'object' || obj === null) return null;
  const p = obj as Record<string, unknown>;
  if (typeof p.v !== 'number' || p.v > SCHEMA_V) {
    // Unknown future schema — be conservative and skip.
    return null;
  }
  if (!Array.isArray(p.contacts)) return null;

  const out: Contact[] = [];
  for (const item of p.contacts) {
    if (typeof item !== 'object' || item === null) continue;
    const c = item as Record<string, unknown>;
    if (typeof c.pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(c.pubkey)) continue;
    // `ownerPubkey` must be 64-char hex — defence in depth against a
    // malformed sync payload that decrypted to this shape but whose
    // pubkey fields are garbage (e.g. via a compromised relay replay
    // with a partially-forged ciphertext somehow).
    if (typeof c.ownerPubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(c.ownerPubkey)) continue;
    if (typeof c.displayName !== 'string') continue;
    if (typeof c.sharedSecret !== 'string') continue;
    // A plain `typeof === 'number'` let NaN/Infinity/negative values from a
    // malformed or another-device's sync payload through — kindred-adapter's
    // `sanitiseAddedAt` is the last line of defence before this reaches
    // kenspeckle's `buildGrantEnvelope` (0.2.0, throws on such a value), but
    // reject the obviously-bad ones here too rather than let them sit in
    // local storage as a "verifiedAt" that isn't a real timestamp.
    if (typeof c.verifiedAt !== 'number' || !Number.isFinite(c.verifiedAt) || c.verifiedAt < 0) continue;
    const contact: Contact = {
      pubkey: c.pubkey.toLowerCase(),
      ownerPubkey: c.ownerPubkey,
      displayName: c.displayName.slice(0, 200),
      sharedSecret: c.sharedSecret,
      verifiedAt: c.verifiedAt,
    };
    if (typeof c.relationship === 'string' &&
        ['parent', 'child', 'sibling', 'grandparent', 'partner', 'other'].includes(c.relationship)) {
      contact.relationship = c.relationship as Contact['relationship'];
    }
    if (typeof c.isChild === 'boolean') contact.isChild = c.isChild;
    if (typeof c.groupId === 'string') contact.groupId = c.groupId;
    if (typeof c.label === 'string') contact.label = c.label.slice(0, 200);
    if (typeof c.isDefaultForGroup === 'boolean') {
      contact.isDefaultForGroup = c.isDefaultForGroup;
    }
    out.push(contact);
  }
  return out;
}

/**
 * Merge a remote contact list with a local one, LWW by `verifiedAt`.
 * Returns the merged list + two diff sets the caller can use to drive
 * IndexedDB writes (saves for new-or-updated records; no deletions —
 * see the rationale below).
 *
 * **Deletions are intentionally not synced in v1.** A remote contact
 * missing from the remote list could mean "deleted on another device"
 * OR "published before that contact existed." Distinguishing requires
 * tombstones or a monotonic version vector — out of scope. Users who
 * delete a contact on one device currently need to delete it on their
 * other devices too. Document this in the user-facing copy if/when
 * it matters.
 */
export function mergeContactLists(local: Contact[], remote: Contact[]): {
  merged: Contact[];
  toSave: Contact[];
} {
  const byPubkey = new Map<string, Contact>();
  for (const c of local) byPubkey.set(c.pubkey, c);

  const toSave: Contact[] = [];
  for (const r of remote) {
    const l = byPubkey.get(r.pubkey);
    if (!l || r.verifiedAt > l.verifiedAt) {
      byPubkey.set(r.pubkey, r);
      toSave.push(r);
    }
  }

  return { merged: Array.from(byPubkey.values()), toSave };
}

/**
 * Collect the pubkeys that belong to a given identity — used to
 * gather the full contacts set before publishing.
 */
export function identityKeypairs(identity: SignetIdentity): string[] {
  const keys: string[] = [];
  if (identity.naturalPerson.publicKey) keys.push(identity.naturalPerson.publicKey);
  if (identity.persona.publicKey) keys.push(identity.persona.publicKey);
  for (const ep of identity.extraPersonas ?? []) {
    if (ep.publicKey) keys.push(ep.publicKey);
  }
  return keys;
}
