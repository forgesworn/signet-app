/**
 * Cross-device ken sync. Recognised public keys (kindred KenEntry) published
 * as a NIP-44-encrypted kind-30078 replaceable event under d-tag
 * `signet:kens` — separate from the `signet:contacts` event so the v1
 * contacts payload is untouched. LWW per ken by `lastResolvedAt ?? addedAt`;
 * no deletions synced (same policy as contacts). Wire entries go through
 * kindred's `toWire` (annotations stripped) and `parseEntry` (validated).
 */
import type { UnsignedEvent } from 'signet-protocol';
import { RelayClient } from 'signet-protocol';
import type { KenEntry } from '@forgesworn/kenspeckle';
import { toWire, parseEntry } from '@forgesworn/kenspeckle';
import type { DecryptingSigningBackend } from './signing-backend';
import { isValidRelayUrl } from './relay-url';
import { readSyncPlaintext, type SyncDecryptCache } from './sync-decrypt-cache';
import { openVaultPayloadOrThrow } from './vault-envelope';

export const SYNC_D_TAG = 'signet:kens';
const SYNC_KIND = 30078;
const SCHEMA_V = 1;


/**
 * Merge a remote ken list with a local one, LWW by `lastResolvedAt ?? addedAt`.
 * Returns the merged list + the set of records the caller should persist to
 * IndexedDB. No deletions synced — same policy as contacts-sync v1.
 */
export function mergeKenLists(local: KenEntry[], remote: KenEntry[]): {
  merged: KenEntry[];
  toSave: KenEntry[];
} {
  const stamp = (k: KenEntry) => k.lastResolvedAt ?? k.addedAt;
  const byPubkey = new Map<string, KenEntry>();
  for (const k of local) byPubkey.set(k.pubkey, k);

  const toSave: KenEntry[] = [];
  for (const r of remote) {
    const l = byPubkey.get(r.pubkey);
    if (!l || stamp(r) > stamp(l)) {
      byPubkey.set(r.pubkey, r);
      toSave.push(r);
    }
  }

  return { merged: Array.from(byPubkey.values()), toSave };
}

/**
 * Publish a set of ken entries to the user's relay. The payload is
 * NIP-44-encrypted to the user's own pubkey (same pattern as contacts-sync).
 *
 * Returns `true` when the relay accepts the publish, `false` on any error.
 */
/**
 * NOTE: this rail deliberately still publishes a bare NIP-44 payload (v1),
 * for the same reason as `publishContactsSync` — a revived §8.4 legacy-write
 * window would have to be readable by old clients. `fetchKensSync` reads both
 * formats. Ruling R5.
 *
 * Nothing else about this rail changes (ruling R12): it is still single-relay,
 * still constructs its own `RelayClient` rather than using
 * `fetchNewestFromRelays`, still does not pin the author, and still records no
 * `syncSeen`. It is on its way out; bringing it onto the pool would be work
 * spent on a rail scheduled for deletion.
 */
export async function publishKensSync(
  kens: KenEntry[],
  backend: DecryptingSigningBackend,
  relayUrl: string,
): Promise<boolean> {
  if (!isValidRelayUrl(relayUrl)) return false;

  const payload = { v: SCHEMA_V, kens: kens.map(toWire) };
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

  const relay = new RelayClient(relayUrl);
  try {
    await relay.connect();
    const result = await relay.publish(signed);
    return result.ok;
  } catch {
    return false;
  } finally {
    relay.disconnect();
  }
}

/**
 * Fetch the latest synced kens event for `authorPubkey` and decrypt it.
 *
 * Returns `null` when no event exists, relay is unreachable, or payload
 * fails validation. `sinceCreatedAt` guards against replay of stale state.
 */
export async function fetchKensSync(
  authorPubkey: string,
  backend: DecryptingSigningBackend,
  relayUrl: string,
  sinceCreatedAt?: number,
  /**
   * Optional decrypt cache (family-bunker §11.1.10). On a hit, an
   * unchanged relay event needs no `nip44_decrypt` round-trip to the
   * signing device — which post-migration is a 0.4–2 s NIP-46 call.
   */
  cache?: SyncDecryptCache,
): Promise<{ kens: KenEntry[]; createdAt: number } | null> {
  if (!isValidRelayUrl(relayUrl)) return null;
  if (!/^[0-9a-f]{64}$/i.test(authorPubkey)) return null;

  const relay = new RelayClient(relayUrl);
  try {
    await relay.connect();
    const events = await relay.fetch([{
      kinds: [SYNC_KIND],
      authors: [authorPubkey],
      '#d': [SYNC_D_TAG],
      limit: 1,
    } as never]);
    if (events.length === 0) return null;

    // kind 30078 is replaceable — relay should only send the latest.
    // Defensive: sort and take newest anyway.
    const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
    if (sinceCreatedAt !== undefined && latest.created_at <= sinceCreatedAt) {
      return null;
    }

    const plaintext = await readSyncPlaintext(
      cache,
      latest,
      () => openVaultPayloadOrThrow(latest.content, backend, authorPubkey),
    );
    const kens = parseKenPayload(plaintext);
    if (!kens) return null;
    return { kens, createdAt: latest.created_at };
  } catch {
    return null;
  } finally {
    relay.disconnect();
  }
}

/** Shape-check and validate a decrypted ken payload. Returns null on any malformation. */
function parseKenPayload(raw: string): KenEntry[] | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (typeof obj !== 'object' || obj === null) return null;
  const p = obj as Record<string, unknown>;
  if (typeof p.v !== 'number' || p.v > SCHEMA_V) {
    // Unknown future schema — be conservative and skip.
    return null;
  }
  if (!Array.isArray(p.kens)) return null;

  const out: KenEntry[] = [];
  for (const item of p.kens) {
    try {
      const entry = parseEntry(JSON.stringify(item));
      // Only accept ken-tier entries; kindred validates full shape
      if (entry.tier === 'ken') out.push(entry as KenEntry);
    } catch { /* skip malformed entry */ }
  }
  return out;
}
