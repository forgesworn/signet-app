/**
 * Encrypted card-backdrop blobs on Blossom: the guardian uploads one for a
 * dependant's persona, the child's phone fetches it.
 *
 * Same shape as the per-persona avatar (`avatar.ts`): AES-256-GCM under a fresh
 * random key, the upload signed by a one-off HMAC uploader — but its own domain
 * (`BACKDROP_UPLOADER_DOMAIN`) and its own size caps. A backdrop is the card's
 * wallpaper, up to `BACKDROP_MAX_EDGE_PX` (1280) on its long edge, so it is far
 * bigger than a 512 px avatar.
 */

import { encryptPhoto } from './photo-crypto';
import { uploadToBlossom } from './blossom';
import { BACKDROP_UPLOADER_DOMAIN, hmacUploaderBackendForBlob } from './blossom-uploader';
import { fetchAvatar, type AvatarMetadata } from './avatar';

/**
 * Cap per uploaded backdrop (the downscaled JPEG, before encryption).
 * Measured in Chromium at the app's settings (long edge 1280, JPEG quality
 * 0.85): a photo-like 1280x960 is about 180 KB, and the worst case, full-colour
 * per-pixel noise at 1280x1280, is 1.17 MB. 1.5 MB clears that with headroom.
 */
export const BACKDROP_MAX_BYTES = 1.5 * 1024 * 1024;

/** Cap on the DOWNLOAD (the encrypted blob, a server we do not control): twice the upload cap. */
export const BACKDROP_MAX_DOWNLOAD_BYTES = BACKDROP_MAX_BYTES * 2;

export type BackdropMetadata = AvatarMetadata;

/**
 * Encrypt and upload a backdrop. Returns the pointer fields the caller stores on
 * the dependant's slot. The caller has already saved the picture locally and
 * downscaled it (`downscaleBackdrop`).
 */
export async function uploadBackdrop(
  blob: Blob,
  blossomUrl: string,
  /** Pass-through for the Blossom consent gate (enforced at uploadToBlossom). */
  blossomConsent: boolean,
  /** The unlock key: the uploader secret is stored encrypted under it. */
  encryptionKey: string,
): Promise<BackdropMetadata> {
  if (blob.size > BACKDROP_MAX_BYTES) {
    throw new Error(`That picture is too large to send (${Math.round(blob.size / 1024)} KB, the limit is ${Math.round(BACKDROP_MAX_BYTES / 1024)} KB).`);
  }
  const raw = new Uint8Array(await blob.arrayBuffer());
  const { encryptedBlob, keyHex } = await encryptPhoto(raw);
  raw.fill(0);
  const encBlob = new Blob([new Uint8Array(encryptedBlob)], { type: 'application/octet-stream' });
  const backend = await hmacUploaderBackendForBlob(BACKDROP_UPLOADER_DOMAIN, encBlob, encryptionKey);
  try {
    const hash = await uploadToBlossom(encBlob, blossomUrl, backend, blossomConsent);
    return { hash, blossomUrl, keyHex, updatedAt: Math.floor(Date.now() / 1000) };
  } finally {
    backend.destroy();
  }
}

/**
 * Fetch and decrypt a backdrop the inventory named. The server URL is
 * inventory-supplied, so this is `fetchAvatar` with the same scheme and
 * internal-host guard and hash check, and the backdrop's larger download cap.
 */
export function fetchBackdrop(meta: { hash: string; blossomUrl: string; keyHex: string }): Promise<Blob> {
  return fetchAvatar({ ...meta, maxBytes: BACKDROP_MAX_DOWNLOAD_BYTES });
}
