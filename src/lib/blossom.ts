import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { UploaderBackend } from './blossom-uploader';
import { sanitizeDisplayName } from './text-sanitize';

/**
 * Default Blossom server URL — used when the user has never explicitly set
 * one. `nostr.download` takes encrypted blobs as well as plain images, honours
 * DELETE, and allows CORS from any origin. The previous default,
 * `blossom.primal.net`, inspects content and answers 415 to any non-image
 * bytes, so every ENCRYPTED upload (the contact-share avatar, the private
 * persona avatar, the contact-picture backup) failed there (verified
 * 2026-10-07). Will switch to `blossom.signet.you` once Signet-team-operated
 * infra is live.
 *
 * Mirrors the `DEFAULT_RELAY_URL` pattern: every read site resolves via
 * `preferences.defaultBlossomUrl ?? DEFAULT_BLOSSOM_URL`. Users who've
 * never opened Advanced Settings get this transparently on next load;
 * if we later rotate the default, they auto-track it. Users who've
 * explicitly Saved a custom server keep their choice as a literal IDB
 * string until they hit "Restore to default." A stored literal is never
 * migrated.
 *
 * A literal empty string ('') counts as Custom — it's the user's
 * deliberate-clear escape hatch (disables uploads).
 */
export const DEFAULT_BLOSSOM_URL = 'https://nostr.download';

/**
 * Generous ceiling for Blossom PUT uploads. A real upload of a 500 KB blob to
 * a public server should never exceed 30 s; a hung connection will be cut here
 * instead of spinning the caller's UI forever.
 */
const UPLOAD_TIMEOUT_MS = 30_000;

/** Shown when a server answers 415: it only stores ordinary pictures, and ours are encrypted. */
export const BLOSSOM_UNSUPPORTED_MEDIA_COPY =
  "That Blossom server only takes ordinary pictures, so it can't store encrypted ones. Choose a different server in Advanced settings.";
/** Shown when a server answers 401 or 403: it wants uploads from approved keys. */
export const BLOSSOM_REFUSED_COPY =
  'That Blossom server refused the upload. It may only accept uploads from approved keys. Choose a different server in Advanced settings.';

/** Shown when a server answers 415 to a plain (unencrypted) picture. */
export const BLOSSOM_PICTURE_NOT_ACCEPTED_COPY =
  "That Blossom server didn't accept this picture. Choose a different server in Advanced settings.";

/**
 * The message for a refused upload: the plain-English copy for the statuses a
 * user can act on. A 415 blames encryption only when the uploaded blob is
 * encrypted (`application/octet-stream`). Any server text shown is stripped of
 * control and bidi characters and capped.
 */
function uploadFailureMessage(status: number, body: string, encrypted: boolean): string {
  if (status === 415) return encrypted ? BLOSSOM_UNSUPPORTED_MEDIA_COPY : BLOSSOM_PICTURE_NOT_ACCEPTED_COPY;
  if (status === 401 || status === 403) return BLOSSOM_REFUSED_COPY;
  const detail = sanitizeDisplayName(body, 100);
  return `Blossom upload failed: ${status}${detail ? ' — ' + detail : ''}`;
}

/** The server answered a delete with a non-2xx status. */
export class BlossomDeleteError extends Error {
  constructor(readonly status: number) { super(`Blossom delete failed: ${status}`); }
}

/** The server answered an upload with a non-2xx status. */
export class BlossomUploadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function uploadToBlossom(
  blob: Blob,
  blossomUrl: string,
  backend: UploaderBackend,
  /**
   * User-granted consent for Blossom uploads. Mirrors `preferences.blossomConsent`.
   * Callers pass `true` only after the user has accepted the Blossom-upload
   * implications (per the per-persona public-profile design §12.7 — fixes the
   * inherited gap where the flag existed but wasn't enforced). Throws when
   * false to make the gate impossible to bypass at the call site.
   */
  blossomConsent: boolean,
): Promise<string> {
  if (!blossomConsent) {
    throw new Error('Enable Blossom uploads in Advanced Settings first.');
  }
  if (!/^https:\/\//i.test(blossomUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)([:\/]|$)/i.test(blossomUrl)) {
    throw new Error('Blossom URL must use https:// (or http://localhost for dev)');
  }

  const arrayBuf = await blob.arrayBuffer();
  const hashBytes = sha256(new Uint8Array(arrayBuf));
  const localHash = bytesToHex(hashBytes);

  const now = Math.floor(Date.now() / 1000);
  const authEvent = await backend.signEvent({
    pubkey: backend.activePublicKeyHex,
    kind: 24242,
    created_at: now,
    tags: [
      ['t', 'upload'],
      ['x', localHash],
      ['expiration', String(now + 300)],
    ],
    content: 'Upload photo',
  });

  const authBase64 = btoa(JSON.stringify(authEvent));
  const baseUrl = blossomUrl.replace(/\/+$/, '');

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/upload`, {
      method: 'PUT',
      headers: {
        'Authorization': `Nostr ${authBase64}`,
        'Content-Type': blob.type || 'application/octet-stream',
      },
      body: blob,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch {
    // "Failed to fetch" usually means the server rejected with no CORS headers
    // on the error response, masking the real reason (e.g. auth event invalid)
    throw new Error('Upload failed — the Blossom server rejected the request. Try a different server.');
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new BlossomUploadError(response.status, uploadFailureMessage(response.status, body, (blob.type || 'application/octet-stream') === 'application/octet-stream'));
  }

  const result: unknown = await response.json();
  if (typeof result !== 'object' || result === null) {
    throw new Error('Blossom upload returned invalid response');
  }
  const serverHash = (result as Record<string, unknown>).sha256;
  if (typeof serverHash !== 'string') {
    throw new Error('Blossom upload response missing sha256 hash');
  }

  if (serverHash.toLowerCase() !== localHash.toLowerCase()) {
    throw new Error('Blossom server hash does not match local hash');
  }

  return localHash;
}

/**
 * Delete a blob from a Blossom server (`DELETE {server}/{hash}`), authorised by
 * a kind-24242 event with `t=delete`, `x=<hash>` and a 5-minute expiration,
 * signed by `backend` (the key that uploaded it). Resolves on a 2xx response;
 * throws otherwise. Callers that want best-effort behaviour catch.
 */
export async function deleteFromBlossom(
  hash: string,
  blossomUrl: string,
  backend: UploaderBackend,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Blossom delete needs a lowercase sha256 hex hash');
  if (!/^https:\/\//i.test(blossomUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)([:\/]|$)/i.test(blossomUrl)) {
    throw new Error('Blossom URL must use https:// (or http://localhost for dev)');
  }
  const now = Math.floor(Date.now() / 1000);
  const authEvent = await backend.signEvent({
    pubkey: backend.activePublicKeyHex,
    kind: 24242,
    created_at: now,
    tags: [
      ['t', 'delete'],
      ['x', hash],
      ['expiration', String(now + 300)],
    ],
    content: 'Delete photo',
  });
  const baseUrl = blossomUrl.replace(/\/+$/, '');
  const response = await fetchImpl(`${baseUrl}/${hash}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Nostr ${btoa(JSON.stringify(authEvent))}` },
    // A redirect would forward the Authorization header to a host the server chose.
    redirect: 'error',
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new BlossomDeleteError(response.status);
}
