/**
 * Relay-URL scheme validation — the single source of truth for the relay-URL
 * security invariant.
 *
 * Production relays MUST be `wss://` (TLS). Plaintext `ws://` is permitted only
 * for `localhost` / `127.0.0.1` (local development / loopback bunkers). This
 * mirrors the rule enforced at every relay boundary: relay-service setter,
 * relay-publish, nip46 connect parser, qr-router, presentation parser,
 * badge-fetch, and the Settings relay editor.
 *
 * Every module that needs this check imports from here — do not re-define a
 * local copy. Tightening or loosening this regex is a security-relevant change.
 */
export function isValidRelayUrl(url: string): boolean {
  return /^wss:\/\//i.test(url) || /^ws:\/\/(localhost|127\.0\.0\.1)([:\/]|$)/i.test(url);
}
