/**
 * The gate a picked persona picture passes BEFORE its crop screen opens: not
 * empty, within the app's 20 MB cap, readable, and a JPEG/PNG/WebP whose header
 * is within the limits (8192 px a side, 40 MP). The contact-picture twin is
 * `checkOwnPictureFile`; this one stays free of the IndexedDB layer so the
 * profile editors can import it.
 */

import { checkImageHeader } from './image-header';

/** The largest raw photo the persona upload handlers take. */
export const PERSONA_PICTURE_MAX_FILE_BYTES = 20 * 1024 * 1024;

export type PickedPictureVerdict = 'ok' | 'refused' | 'unreadable' | 'too-large';

export async function checkPickedPicture(file: Blob): Promise<PickedPictureVerdict> {
  if (file.size === 0) return 'refused';
  if (file.size > PERSONA_PICTURE_MAX_FILE_BYTES) return 'too-large';
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return 'unreadable';
  }
  const verdict = checkImageHeader(bytes);
  bytes.fill(0);
  return verdict.ok ? 'ok' : 'refused';
}
