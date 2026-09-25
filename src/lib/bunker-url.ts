/**
 * Build a standard NIP-46 `bunker://` URL the user shares from their
 * phone (acting as a bunker server) so a desktop NIP-46 client can pair
 * to it. Format:
 *
 *   bunker://<pubkey-hex>?relay=<url-encoded-relay>
 *
 * No `secret` is included on this surface. The phone's guardian route
 * ACKs `connect` unconditionally (see `useBunkerServer.handleInboundEvent`
 * — guardian branch) — adding a secret here would be UX noise without a
 * security gain. The real gate is the user manually approving each
 * `sign_event` request via the on-device approval prompt.
 *
 * Returns `null` when inputs are missing or the relay URL fails the
 * standard wss/ws-localhost validation. Callers render an inline hint
 * rather than surfacing an error.
 */

import { isValidRelayUrl } from './relay-url';

const HEX64 = /^[0-9a-f]{64}$/i;

export function buildPhoneBunkerUrl(pubkeyHex: string | null | undefined, relayUrl: string | null | undefined): string | null {
  if (!pubkeyHex || !relayUrl) return null;
  const pk = pubkeyHex.trim().toLowerCase();
  if (!HEX64.test(pk)) return null;
  const relay = relayUrl.trim();
  if (!isValidRelayUrl(relay)) return null;
  return `bunker://${pk}?relay=${encodeURIComponent(relay)}`;
}

/**
 * Build a NIP-46 `bunker://` URI carrying a one-time pairing secret. Used by
 * the redirect-flow auto-pair (#redirect-bunker) so a consumer that just
 * completed "Sign in with Signet" gets a URI it can hand to its NIP-46
 * client; the guardian-route `connect` handler validates the secret and
 * marks the connecting client as `allowAlways`.
 *
 * Secrets must be at least 8 chars (matches `buildPairingURI`'s lower
 * bound) so a degenerate empty secret can't slip through. Returns `null`
 * for any input that fails validation; callers should fall back to the
 * plain auth-only redirect callback in that case.
 */
export function buildAuthFlowBunkerUrl(
  pubkeyHex: string | null | undefined,
  relayUrl: string | readonly string[] | null | undefined,
  secret: string | null | undefined,
): string | null {
  if (!pubkeyHex || !relayUrl || !secret) return null;
  const pk = pubkeyHex.trim().toLowerCase();
  if (!HEX64.test(pk)) return null;
  const relays = (Array.isArray(relayUrl) ? relayUrl : [relayUrl])
    .map(r => r.trim())
    .filter((r, idx, arr) => r.length > 0 && arr.indexOf(r) === idx && isValidRelayUrl(r));
  if (relays.length === 0) return null;
  const s = secret.trim();
  if (s.length < 8 || s.length > 256) return null;
  const params = new URLSearchParams();
  for (const relay of relays) params.append('relay', relay);
  params.set('secret', s);
  return `bunker://${pk}?${params.toString()}`;
}
