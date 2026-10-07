import { useEffect, useSyncExternalStore } from 'react';
import {
  cachedContactPicture, cachedOwnPictureState, contactPicturesVersion, loadContactPictures, subscribeContactPictures,
} from '../lib/contact-pictures';
import { kind0PictureId, ownPictureId, type OwnPictureBackupState } from '../lib/contact-picture-crypto';
import { useObjectUrl } from './useObjectUrl';

const HEX64 = /^[0-9a-f]{64}$/;

function useBlobUrl(blob: Blob | null): string | null {
  return useObjectUrl(blob ? async () => blob : null, [blob]);
}

export interface ContactPictureInput {
  encryptionKey: string | null;
  /** The contact's primary identity key (null for a keyless contact). */
  pubkey?: string | null;
  /** Set to look up the user's own picture for this contact record. */
  directoryId?: string;
  contactId?: string;
  /** The #242 shared encrypted avatar URL from `useContactAvatar`, if any. */
  sharedUrl?: string | null;
}

/**
 * The picture to show for a contact, by precedence:
 * own picture > #242 shared encrypted avatar > downloaded kind-0 thumbnail >
 * null (the caller's initials).
 *
 * `badgeUrl` is THEIR picture (shared avatar, else kind-0 thumbnail) and is set
 * only when the main picture is the user's own and they have one — so there is
 * never a badge with a single picture, and never the same picture twice.
 *
 * Reads only the local, already-downloaded thumbnails — this hook never
 * touches the network. The decrypted thumbnails are loaded once per unlock;
 * each mount makes its own object URL (never shared across mounts).
 */
export function useContactPicture({ encryptionKey, pubkey, directoryId, contactId, sharedUrl }: ContactPictureInput): {
  url: string | null;
  /** Their picture, shown as a badge on the user's own; null unless both exist. */
  badgeUrl: string | null;
  hasOwn: boolean;
  /** Backup state of the user's own picture (null when there is none). Re-renders as it changes. */
  backup: OwnPictureBackupState | null;
} {
  useSyncExternalStore(subscribeContactPictures, contactPicturesVersion, contactPicturesVersion);
  useEffect(() => {
    if (encryptionKey) void loadContactPictures(encryptionKey);
  }, [encryptionKey]);

  const ownBlob = directoryId && contactId ? cachedContactPicture(encryptionKey, ownPictureId(directoryId, contactId)) : null;
  const backup = ownBlob && directoryId && contactId ? (cachedOwnPictureState(encryptionKey, directoryId, contactId)?.backup ?? null) : null;
  const pk = pubkey?.toLowerCase();
  // Loaded even under an own picture: it is the badge. Skipped only when a shared avatar already is "theirs".
  const kind0Blob = pk && HEX64.test(pk) && !sharedUrl ? cachedContactPicture(encryptionKey, kind0PictureId(pk)) : null;
  const ownUrl = useBlobUrl(ownBlob);
  const kind0Url = useBlobUrl(kind0Blob);
  const theirs = sharedUrl ?? (kind0Blob ? kind0Url : null);
  return {
    url: (ownBlob ? ownUrl : null) ?? theirs,
    badgeUrl: ownBlob && ownUrl ? theirs : null,
    hasOwn: !!ownBlob,
    backup,
  };
}
