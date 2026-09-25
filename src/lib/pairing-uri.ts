/**
 * Phone-as-family-bunker pairing URI — build + parse.
 *
 * Format (superset of the standard NIP-46 `bunker://` URI):
 *
 *   bunker://<endpoint-pubkey>
 *     ?relay=<relay-url>           (repeatable)
 *     &secret=<one-time-secret>
 *     &dependant=<dependant-pubkey>
 *     &name=<dependant-name>
 *     &guardian=<guardian-pubkey>  (optional — see C1 note below)
 *
 * `guardian` carries the guardian's real signing pubkey — distinct from
 * `endpoint-pubkey`, which is a per-dependant NIP-46 transport keypair,
 * not the guardian's actual identity key. The child device pins this at
 * pair time so the audit-log consumer (`useAuditLog` / `audit-fetch.ts`)
 * can verify that audit gift-wraps are genuinely sealed by the guardian
 * rather than a forged throwaway key (2026-07-02 audit finding C1).
 * Optional for backward compatibility with pre-C1 QR codes — a pairing
 * without it simply can't show a verified activity log until the child
 * re-pairs against a fresh QR.
 *

 * Multiple `relay=` params are permitted (NIP-46 standard). The child
 * device tries them in order on connect; first successful handshake wins.
 * `dependant` and `name` are app-local hints so the child can label the
 * identity without asking the bunker (spec: 2026-04-22 dependant-accounts
 * §"Device Pairing").
 */

export interface PairingURIParams {
  /** NIP-46 transport pubkey of this dependant's endpoint on the guardian phone. 64-char hex. */
  endpointPubkey: string;
  /**
   * Relay list (primary first, then fallbacks). At least one entry.
   * Child device tries each in order until connect succeeds.
   */
  relays: string[];
  /** One-time secret the guardian-phone expects in the `connect` handshake. */
  secret: string;
  /** Dependant's primary signing pubkey (app-local hint, not part of NIP-46). 64-char hex. */
  dependantPubkey: string;
  /** Dependant's display name (app-local hint; will be URL-encoded). Capped at 64 chars. */
  dependantName: string;
  /**
   * Guardian's real signing pubkey (app-local hint, not part of NIP-46).
   * Optional so older callers/QRs keep working; see the C1 note above.
   * 64-char hex when present.
   */
  guardianPubkey?: string;
}

const HEX64 = /^[0-9a-f]{64}$/i;
const MAX_NAME_LEN = 64;
/** Upper bound on the whole URI we'll accept. Matches the QR-router cap. */
const MAX_URI_LEN = 8192;
const MAX_RELAY_LEN = 1024;
const MAX_SECRET_LEN = 256;
/** Hard cap on fallback-list size so a malicious sender can't blow the URI up. */
const MAX_RELAYS = 5;

function isValidRelay(url: string): boolean {
  return /^wss:\/\//i.test(url) || /^ws:\/\/(localhost|127\.0\.0\.1)([:\/]|$)/i.test(url);
}

function stripDangerous(name: string): string {
  // Strip control + bidi / invisible chars; same policy as other user-facing
  // string inputs in the app (the project's security conventions).
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '').slice(0, MAX_NAME_LEN).trim();
}

/**
 * Build a pairing URI. Throws on invalid inputs — generator code should
 * always satisfy these invariants, so a throw indicates a programmer bug
 * rather than a user-input problem.
 */
export function buildPairingURI(params: PairingURIParams): string {
  const { endpointPubkey, relays, secret, dependantPubkey, dependantName, guardianPubkey } = params;
  if (!HEX64.test(endpointPubkey)) throw new Error('endpointPubkey must be 64-char hex');
  if (!HEX64.test(dependantPubkey)) throw new Error('dependantPubkey must be 64-char hex');
  if (guardianPubkey !== undefined && !HEX64.test(guardianPubkey)) {
    throw new Error('guardianPubkey must be 64-char hex when provided');
  }
  if (!Array.isArray(relays) || relays.length === 0) throw new Error('relays must be a non-empty array');
  if (relays.length > MAX_RELAYS) throw new Error(`relays cannot exceed ${MAX_RELAYS} entries`);
  for (const r of relays) {
    if (typeof r !== 'string' || r.length > MAX_RELAY_LEN) throw new Error('relay must be a string under the length cap');
    if (!isValidRelay(r)) throw new Error('relay must be wss:// or ws://localhost');
  }
  // Deduplicate exact matches — a URI carrying `?relay=X&relay=X` is
  // meaningless and would just be noise on the child side.
  const uniqueRelays = Array.from(new Set(relays));
  if (!secret || secret.length < 8) throw new Error('secret must be at least 8 chars');
  const cleanName = stripDangerous(dependantName);
  if (!cleanName) throw new Error('dependantName must contain at least one printable character');

  // Build params manually so repeated `relay=` entries stay in the order
  // the guardian supplied (URLSearchParams.set would collapse them; append
  // preserves order).
  const qp = new URLSearchParams();
  for (const r of uniqueRelays) qp.append('relay', r);
  qp.set('secret', secret);
  qp.set('dependant', dependantPubkey.toLowerCase());
  qp.set('name', cleanName);
  if (guardianPubkey) qp.set('guardian', guardianPubkey.toLowerCase());
  // Re-encode spaces as `%20` instead of URLSearchParams' default `+`.
  // nostr-tools' `BUNKER_REGEX` (lib/esm/nip46.js) uses the char class
  // `[?\/\w:.=&%-]` for the query string which doesn't include `+`, so a
  // URI carrying any `+` (e.g. a multi-word dependant `name=Dep+Person`)
  // fails to parse on the kid side and `BunkerSigner.fromBunker` throws
  // "Bunker URI must include at least one relay" — even though the URI
  // has a perfectly valid `relay=` param. `%20` decodes to space exactly
  // the same as `+` does in URLSearchParams, so consumers see no behaviour
  // difference. See internal tracker (persona-inventory hang).
  return `bunker://${endpointPubkey.toLowerCase()}?${qp.toString().replace(/\+/g, '%20')}`;
}

/**
 * Parse a pairing URI back into its components. Returns null for any malformed
 * or invalid URI — callers render a user-friendly "pairing code not recognised"
 * message rather than exposing parser internals.
 */
export function parsePairingURI(uri: string): PairingURIParams | null {
  if (typeof uri !== 'string') return null;
  if (uri.length > MAX_URI_LEN) return null;
  // Scheme match case-insensitively — `BUNKER://…` from a permissive QR
  // generator shouldn't silently be rejected.
  if (uri.slice(0, 9).toLowerCase() !== 'bunker://') return null;

  // URL constructor is strict about the scheme and host shape. bunker:// isn't
  // recognised by every WHATWG URL parser; avoid it by doing manual extraction.
  const afterScheme = uri.slice('bunker://'.length);
  const qIdx = afterScheme.indexOf('?');
  if (qIdx < 0) return null;
  const endpointPubkey = afterScheme.slice(0, qIdx).toLowerCase();
  if (!HEX64.test(endpointPubkey)) return null;

  let qp: URLSearchParams;
  try {
    qp = new URLSearchParams(afterScheme.slice(qIdx + 1));
  } catch {
    return null;
  }

  // Reject URIs with duplicate single-valued params. An attacker pre-pending
  // an extra `secret=…` to a scanned URI would otherwise be picked up first
  // by `get()` and silently substitute their value. `relay` is exempted
  // because multi-relay is the whole point — it's still validated
  // per-entry below.
  for (const key of ['secret', 'dependant', 'name', 'guardian']) {
    if (qp.getAll(key).length > 1) return null;
  }

  const rawRelays = qp.getAll('relay');
  const secret = qp.get('secret');
  const dependant = qp.get('dependant')?.toLowerCase() ?? null;
  const rawName = qp.get('name');
  const rawGuardian = qp.get('guardian');

  if (rawRelays.length === 0 || rawRelays.length > MAX_RELAYS) return null;
  const relays: string[] = [];
  for (const r of rawRelays) {
    if (r.length > MAX_RELAY_LEN || !isValidRelay(r)) return null;
    // Duplicates inside a single URI are benign but noisy; collapse.
    if (!relays.includes(r)) relays.push(r);
  }
  if (!secret || secret.length < 8 || secret.length > MAX_SECRET_LEN) return null;
  if (!dependant || !HEX64.test(dependant)) return null;
  if (!rawName) return null;
  const name = stripDangerous(rawName);
  if (!name) return null;
  // `guardian` is optional (backward compat with pre-C1 QRs), but if
  // present it must be well-formed — a malformed value is treated as a
  // malformed URI rather than silently downgraded to "absent" (which
  // would let an attacker strip the field from a legitimate QR).
  let guardianPubkey: string | undefined;
  if (rawGuardian !== null) {
    const lowered = rawGuardian.toLowerCase();
    if (!HEX64.test(lowered)) return null;
    guardianPubkey = lowered;
  }

  return {
    endpointPubkey,
    relays,
    secret,
    dependantPubkey: dependant,
    dependantName: name,
    ...(guardianPubkey ? { guardianPubkey } : {}),
  };
}

/**
 * Generate a fresh one-time pairing secret. 16-byte CSPRNG hex = 32 chars,
 * well above the 8-char minimum. The guardian phone remembers this secret
 * in memory and rejects pair attempts that don't match it; the spec's
 * 5-minute TTL is enforced separately by the pair screen's
 * lifetime.
 */
export function generatePairingSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
