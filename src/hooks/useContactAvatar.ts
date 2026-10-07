import { getContactAvatar } from '../lib/db';
import { fetchContactAvatarPointer, type ContactAvatarPointer } from '../lib/contact-avatar';
import { fetchAvatar } from '../lib/avatar';
import { useObjectUrl } from './useObjectUrl';

/**
 * Module-level POINTER cache (kind-30078 pointer JSON, NOT object URLs — object
 * URLs carry revoke hazards and must stay owned by the hook's lifecycle). Lets
 * ContactsRolodex batch-fetch pointers once for the visible page and seed them,
 * so each per-row useContactAvatar resolves its pointer from cache instead of
 * opening its own relay connection. `null` is a cached "no pointer" answer.
 */
const POINTER_TTL_MS = 60_000;
const pointerCache = new Map<string, { pointer: ContactAvatarPointer | null; ts: number }>();

/** Seed the pointer cache from a batch fetch (ContactsRolodex). */
export function seedContactAvatarPointer(pubkey: string, pointer: ContactAvatarPointer | null): void {
  pointerCache.set(pubkey.toLowerCase(), { pointer, ts: Date.now() });
}

/** Internal getter — returns the cached pointer only while fresh, else undefined. */
function getCachedPointer(pubkey: string): ContactAvatarPointer | null | undefined {
  const hit = pointerCache.get(pubkey.toLowerCase());
  if (!hit) return undefined;
  if (Date.now() - hit.ts > POINTER_TTL_MS) { pointerCache.delete(pubkey.toLowerCase()); return undefined; }
  return hit.pointer;
}

/**
 * Resolve a contact's avatar, always-current. PRIVATE PATH ONLY: stored
 * contact-share key → latest kind-30078 pointer (author-verified) → encrypted
 * Blossom blob → object URL. Returns the object URL or null.
 *
 * There is deliberately NO public kind-0 `pictureUrl` fallback here (H1): that
 * URL is attacker-controlled and auto-fetching it leaks the viewer's IP + view
 * timing to a relay-supplied origin. Kind-0 pictures are downloaded only by an
 * explicit, consented user action (`contact-pictures.ts`) and stored as local
 * thumbnails; `useContactPicture` layers those under this shared avatar.
 *
 * `overrideShareKey` lets the scan-confirm screen preview before the key is
 * persisted to IDB. Object-URL lifecycle (revoke / strict-mode race) lives in
 * useObjectUrl.
 */
export function useContactAvatar(
  pubkey: string | undefined,
  relayUrl: string,
  encryptionKey: string | null,
  overrideShareKey?: string,
): string | null {
  return useObjectUrl(
    pubkey
      ? async () => {
          // 1) Private path — contact-share key (override or from IDB). The
          // stored record may also carry the `{ server, hash }` the sharer's
          // contact card named; it is only used when no pointer can be found.
          let shareKey = overrideShareKey;
          let fallback: { server: string; hash: string } | undefined;
          if (encryptionKey) {
            const rec = await getContactAvatar(pubkey, encryptionKey);
            if (!shareKey) shareKey = rec?.shareKey;
            fallback = rec?.fallback;
          }
          if (!shareKey) return null; // no key → no avatar (no public fallback).

          // 2) Pointer — cache hit (fresh) or one author-verified relay fetch.
          let pointer = getCachedPointer(pubkey);
          if (pointer === undefined) {
            pointer = await fetchContactAvatarPointer(pubkey, relayUrl);
            seedContactAvatarPointer(pubkey, pointer);
          }
          // 2b) No pointer on our relays: the card's own server and hash. https
          // only; fetchAvatar still runs the host guard (isSafeBlossomBase).
          if (!pointer && fallback && fallback.server.startsWith('https://')) {
            pointer = { hash: fallback.hash, blossomUrl: fallback.server };
          }
          if (!pointer) return null;

          // 3) Encrypted blob → Blob; useObjectUrl turns it into the object URL.
          return fetchAvatar({ hash: pointer.hash, blossomUrl: pointer.blossomUrl, keyHex: shareKey });
        }
      : null,
    [pubkey, relayUrl, encryptionKey, overrideShareKey],
  );
}
