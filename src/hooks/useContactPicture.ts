import { useEffect, useSyncExternalStore } from 'react';
import {
  cachedContactPicture, contactPicturesVersion, loadContactPictures, subscribeContactPictures,
} from '../lib/contact-pictures';
import { kind0PictureId, ownPictureId } from '../lib/contact-picture-crypto';
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
 * Reads only the local, already-downloaded thumbnails — this hook never
 * touches the network. The decrypted thumbnails are loaded once per unlock;
 * each mount makes its own object URL (never shared across mounts).
 */
export function useContactPicture({ encryptionKey, pubkey, directoryId, contactId, sharedUrl }: ContactPictureInput): {
  url: string | null;
  hasOwn: boolean;
} {
  useSyncExternalStore(subscribeContactPictures, contactPicturesVersion, contactPicturesVersion);
  useEffect(() => {
    if (encryptionKey) void loadContactPictures(encryptionKey);
  }, [encryptionKey]);

  const ownBlob = directoryId && contactId ? cachedContactPicture(encryptionKey, ownPictureId(directoryId, contactId)) : null;
  const pk = pubkey?.toLowerCase();
  const kind0Blob = pk && HEX64.test(pk) && !ownBlob && !sharedUrl ? cachedContactPicture(encryptionKey, kind0PictureId(pk)) : null;
  const ownUrl = useBlobUrl(ownBlob);
  const kind0Url = useBlobUrl(kind0Blob);
  return {
    url: (ownBlob ? ownUrl : null) ?? sharedUrl ?? (kind0Blob ? kind0Url : null),
    hasOwn: !!ownBlob,
  };
}
