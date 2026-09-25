import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SigningBackend } from './signing-backend';

/**
 * Default Blossom server URL — used when the user has never explicitly set
 * one. Currently points at `blossom.primal.net` as a stopgap; will switch
 * to `blossom.signet.you` once Signet-team-operated infra is live.
 *
 * Mirrors the `DEFAULT_RELAY_URL` pattern: every read site resolves via
 * `preferences.defaultBlossomUrl ?? DEFAULT_BLOSSOM_URL`. Users who've
 * never opened Advanced Settings get this transparently on next load;
 * if we later rotate the default, they auto-track it. Users who've
 * explicitly Saved a custom server keep their choice as a literal IDB
 * string until they hit "Restore to default."
 *
 * A literal empty string ('') counts as Custom — it's the user's
 * deliberate-clear escape hatch (disables uploads).
 */
export const DEFAULT_BLOSSOM_URL = 'https://blossom.primal.net';

/**
 * Generous ceiling for Blossom PUT uploads. A real upload of a 500 KB blob to
 * a public server should never exceed 30 s; a hung connection will be cut here
 * instead of spinning the caller's UI forever.
 */
const UPLOAD_TIMEOUT_MS = 30_000;

export async function uploadToBlossom(
  blob: Blob,
  blossomUrl: string,
  backend: SigningBackend,
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
    throw new Error(`Blossom upload failed: ${response.status}${body ? ' — ' + body.slice(0, 100) : ''}`);
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
