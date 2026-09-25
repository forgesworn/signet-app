/**
 * Contact-share avatar pointer — a replaceable kind-30078 (NIP-78) event so the
 * latest avatar always wins. Author = the persona's pubkey, d-tag =
 * "signet:contact-avatar", content = { hash, blossomUrl } (the decryption key is
 * NEVER here — only QR holders can decrypt). Unencrypted, unlike the NIP-44
 * contacts/ken sync rails. See 2026-06-04 contact-card-name-avatar design §B3.
 *
 * Threat note: a hostile relay could serve a forged pointer, but the encrypted
 * blob it points at can't be produced without the contact-share key, so
 * `fetchAvatar`'s SHA-256 + AES-GCM tag check fails closed (no avatar shown,
 * no key leak). Signature verification is therefore defence-in-depth only.
 */
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import { publishEvent, fetchEvents } from './relay-service';
import type { SigningBackend } from './signing-backend';
import { safeImageOrLinkUrl } from './public-profile-publish';
import { verifiedAuthoredEvents } from './event-verify';
import { isValidRelayUrl } from './relay-url';
import { isValidHexKey } from './signet';

/** Defensive cap on batch author count — one relay query, bounded fan-out. */
const BATCH_AUTHOR_CAP = 200;

export const CONTACT_AVATAR_KIND = 30078;
export const CONTACT_AVATAR_D_TAG = 'signet:contact-avatar';

/** Mirrors the timeout magnitudes used in public-profile-publish.ts. */
const RELAY_FETCH_TIMEOUT_MS = 2000;
const RELAY_PUBLISH_TIMEOUT_MS = 30_000;


export interface ContactAvatarPointer {
  hash: string;
  blossomUrl: string;
}

/** Build an unsigned kind-30078 pointer event. Pure — no I/O. */
export function buildContactAvatarPointer(content: ContactAvatarPointer, pubkeyHex: string): UnsignedEvent {
  return {
    kind: CONTACT_AVATAR_KIND,
    pubkey: pubkeyHex,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', CONTACT_AVATAR_D_TAG]],
    content: JSON.stringify({ hash: content.hash, blossomUrl: content.blossomUrl }),
  };
}

/**
 * Parse and validate a contact avatar pointer event.
 * Returns null on malformed JSON, bad hash, or non-https blossom URL.
 */
export function parseContactAvatarPointer(event: { content: string }): ContactAvatarPointer | null {
  let obj: unknown;
  try { obj = JSON.parse(event.content); } catch { return null; }
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.hash !== 'string' || !isValidHexKey(o.hash.toLowerCase())) return null;
  // Length cap before URL parsing — a hostile relay must not be able to push a
  // megabyte string into IndexedDB. A Blossom URL is short (origin + 64-hex hash
  // + path). Mirrors the picture-URL caps in public-profile-publish.
  if (typeof o.blossomUrl !== 'string' || o.blossomUrl.length > 512 || !safeImageOrLinkUrl(o.blossomUrl)) return null;
  return { hash: o.hash.toLowerCase(), blossomUrl: o.blossomUrl };
}

/**
 * From a list of relay events, keep only those authored by `authorHex`
 * (case-insensitive — the relay's `authors:` filter is untrusted), take the
 * newest by `created_at`, and parse it. Pure — no I/O, no signature check
 * (callers pass a signature-verified set via `verifiedAuthoredEvents`).
 *
 * Take-then-parse (not filter-parseable-then-take): a malformed newest event
 * returns null rather than silently falling back to an older one — same
 * contract as fetchPublicProfile / the existing single-fetch path.
 */
export function selectLatestPointerByAuthor(
  events: Array<{ pubkey: string; created_at: number; content: string }>,
  authorHex: string,
): ContactAvatarPointer | null {
  const lc = authorHex.toLowerCase();
  const mine = events.filter(e => e.pubkey.toLowerCase() === lc);
  if (mine.length === 0) return null;
  const latest = mine.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  return parseContactAvatarPointer(latest);
}

/**
 * Publish/refresh the pointer, signed by the persona's own key. Returns ok.
 * Modelled on publishKensSync in ken-sync.ts (RelayClient connect/publish/disconnect shape).
 */
export async function publishContactAvatarPointer(
  content: ContactAvatarPointer,
  backend: SigningBackend,
  relayUrl: string,
): Promise<boolean> {
  if (!isValidRelayUrl(relayUrl)) return false;

  const template = buildContactAvatarPointer(content, backend.activePublicKeyHex);
  const signed = await backend.signEvent(template);

  try {
    // C2: target only the caller's relayUrl, not the whole configured pool.
    const result = await publishEvent(signed as never, { timeoutMs: RELAY_PUBLISH_TIMEOUT_MS, relays: [relayUrl] });
    return result.ok;
  } catch {
    return false;
  }
}

/**
 * Retract the contact-avatar pointer (NIP-09). The pointer is a parameterized-
 * replaceable kind-30078, so we delete by addressable coordinate
 * `30078:<pubkey>:signet:contact-avatar` (no stored event id needed) AND publish
 * a tombstone replaceable (empty content) so the latest replaceable resolves to
 * nothing even on relays that ignore kind-5. Best-effort; returns ok.
 *
 * Mirrors retractPublicProfile in public-profile-publish.ts (kind-5 deletion +
 * tombstone replaceable), adapted for an ADDRESSABLE (parameterized-replaceable)
 * target: that path has a stored event id so it deletes by `['e', id]` + `['k',
 * '0']`; here the pointer is keyed by (pubkey, kind, d-tag), so we delete by
 * `['a', coord]` and the tombstone reuses the same d-tag with rejected content.
 *
 * Note: recipients who already cached the share key keep any blob they already
 * fetched (no clawback — by design); this stops future discovery + republish.
 */
export async function retractContactAvatarPointer(backend: SigningBackend, relayUrl: string): Promise<boolean> {
  if (!isValidRelayUrl(relayUrl)) return false;
  const pubkey = backend.activePublicKeyHex;
  const coord = `${CONTACT_AVATAR_KIND}:${pubkey}:${CONTACT_AVATAR_D_TAG}`;
  const deletion: UnsignedEvent = {
    kind: 5, pubkey, created_at: Math.floor(Date.now() / 1000),
    tags: [['a', coord]], content: 'contact-avatar retracted',
  };
  // Tombstone: a replaceable kind-30078 with content that parseContactAvatarPointer rejects → resolves to null.
  const tombstone: UnsignedEvent = {
    kind: CONTACT_AVATAR_KIND, pubkey, created_at: Math.floor(Date.now() / 1000) + 1,
    tags: [['d', CONTACT_AVATAR_D_TAG]], content: '{}',
  };
  try {
    const signedDel = await backend.signEvent(deletion);
    const signedTomb = await backend.signEvent(tombstone);
    // C2: retraction must reach the relay the pointer was actually
    // published to — targeting the pool could leave the original pointer
    // live on a relay no longer in the caller's configured set.
    const r1 = await publishEvent(signedDel as never, { timeoutMs: RELAY_PUBLISH_TIMEOUT_MS, relays: [relayUrl] });
    const r2 = await publishEvent(signedTomb as never, { timeoutMs: RELAY_PUBLISH_TIMEOUT_MS, relays: [relayUrl] });
    return r1.ok || r2.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch the latest pointer authored by `pubkeyHex`. Null on any failure.
 * Modelled on fetchKensSync in ken-sync.ts (RelayClient connect/fetch/disconnect shape).
 *
 * The relay's `authors:` filter is untrusted — a hostile relay can return an
 * event with an arbitrary `event.pubkey` to point us at an attacker-chosen
 * blob (L1). We verify signature + author match via `verifiedAuthoredEvents`
 * BEFORE parsing, so the pointer we honour was genuinely signed by `pubkeyHex`.
 */
export async function fetchContactAvatarPointer(
  pubkeyHex: string,
  relayUrl: string,
): Promise<ContactAvatarPointer | null> {
  if (!isValidRelayUrl(relayUrl)) return null;
  if (!isValidHexKey(pubkeyHex.toLowerCase())) return null;

  try {
    const events = await fetchEvents([{
      kinds: [CONTACT_AVATAR_KIND],
      authors: [pubkeyHex.toLowerCase()],
      '#d': [CONTACT_AVATAR_D_TAG],
      limit: 1,
    }] as never, { timeoutMs: RELAY_FETCH_TIMEOUT_MS, relays: [relayUrl] });
    if (!events || events.length === 0) return null;

    // Signature + author verification (L1) — drop relay-forged events before
    // any parse. kind 30078 is replaceable, so the relay should send only the
    // latest; selectLatestPointerByAuthor sorts defensively regardless.
    const verified = verifiedAuthoredEvents(events as NostrEvent[], pubkeyHex);
    return selectLatestPointerByAuthor(verified, pubkeyHex);
  } catch {
    return null;
  }
}

/**
 * Batch variant of fetchContactAvatarPointer (M4) — ONE relay query for many
 * authors, returning `Map<pubkey-lowercase, pointer>`. Mirrors fetchBadges in
 * badge-fetch.ts (multi-author filter + verify + per-pubkey selection). Authors
 * are capped at BATCH_AUTHOR_CAP and validated to hex; invalid relay URL or any
 * error yields an empty Map. Used by ContactsRolodex to seed the per-row pointer
 * cache so each row's useContactAvatar hits the cache instead of opening its own
 * relay connection.
 */
export async function fetchContactAvatarPointers(
  pubkeys: string[],
  relayUrl: string,
): Promise<Map<string, ContactAvatarPointer>> {
  const results = new Map<string, ContactAvatarPointer>();
  if (!isValidRelayUrl(relayUrl)) return results;

  const validAuthors = pubkeys
    .map(p => p.toLowerCase())
    .filter(p => isValidHexKey(p))
    .slice(0, BATCH_AUTHOR_CAP);
  if (validAuthors.length === 0) return results;

  try {
    const events = await fetchEvents([{
      kinds: [CONTACT_AVATAR_KIND],
      authors: validAuthors,
      '#d': [CONTACT_AVATAR_D_TAG],
    }] as never, { timeoutMs: RELAY_FETCH_TIMEOUT_MS, relays: [relayUrl] });
    if (!events || events.length === 0) return results;

    // Verify signatures once for the whole set; author match is re-checked
    // per-pubkey inside selectLatestPointerByAuthor.
    const verified = verifiedAuthoredEvents(events as NostrEvent[]);
    for (const author of validAuthors) {
      const pointer = selectLatestPointerByAuthor(verified, author);
      if (pointer) results.set(author, pointer);
    }
  } catch {
    // Relay unreachable / fetch error — return whatever we have (empty on
    // first-call failure).
  }
  return results;
}
