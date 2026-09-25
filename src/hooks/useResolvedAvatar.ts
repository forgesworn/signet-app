/**
 * Fetch + decrypt a persona's avatar blob, produce an object URL the
 * `<img>` tag can render. Re-runs whenever the persona's avatar
 * metadata changes (`avatarHash` change is the load-bearing identity —
 * if the hash matches, the blob bytes are byte-identical, so the
 * existing object URL stays valid).
 *
 * Returns `null` while loading or when no avatar is set / fetch failed —
 * callers fall back to the initial+gradient placeholder in IdentityCard.
 *
 * Lifecycle:
 *   - mount with metadata          → fetch, decrypt, set object URL
 *   - metadata changes             → revoke old URL, fetch new
 *   - unmount or metadata cleared  → revoke URL
 *
 * Failures are silent on purpose — a missing avatar should never break the
 * carousel render. The user can re-upload from the Personas page if needed.
 */

import { fetchAvatar } from '../lib/avatar';
import { useObjectUrl } from './useObjectUrl';

interface AvatarMetadata {
  avatarHash?: string;
  avatarBlossomUrl?: string;
  avatarKey?: string;
}

export function useResolvedAvatar(meta: AvatarMetadata | null | undefined): string | null {
  // Pull primitives out of `meta` so the effect's dep array tracks values,
  // not the (re-created-every-render) object identity. Otherwise the effect
  // would re-fetch on every parent render even when the avatar hadn't
  // actually changed. The object-URL lifecycle (revoke on cleanup, strict-mode
  // double-invoke race) lives in useObjectUrl.
  const hash = meta?.avatarHash;
  const blossomUrl = meta?.avatarBlossomUrl;
  const keyHex = meta?.avatarKey;

  return useObjectUrl(
    hash && blossomUrl && keyHex ? () => fetchAvatar({ hash, blossomUrl, keyHex }) : null,
    [hash, blossomUrl, keyHex],
  );
}
