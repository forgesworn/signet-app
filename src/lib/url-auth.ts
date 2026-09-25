/**
 * URL-based authentication for "Sign in with Signet" redirect flow.
 *
 * Thin wrapper over signet-protocol's parser. The app adds three
 * consumer-hint params that live above the protocol boundary:
 *   accept=<csv>         — allowlist of keypair tokens
 *   prefer=<token>       — default-selection hint (single token)
 *   accept_reason=<text> — short human-readable justification
 *
 * These are a UX layer — signet-protocol does not (and should not)
 * know about them.
 */

import type { ConsumerHint, KeypairToken } from '../types';
import {
  parseUrlAuthParams as protocolParse,
  buildAuthCallbackUrl as protocolBuildCallback,
} from 'signet-protocol';
import type { UnsignedEvent } from 'signet-protocol';
import type { LoginRequest, AuthRequest } from './qr-router';
import { sanitizeDisplayName } from './text-sanitize';

export { parseUrlAuthParams, buildAuthDeniedUrl, getUrlAuthSiteName } from 'signet-protocol';

/** Canonical tokens the resolver understands. */
const KEYPAIR_TOKENS: readonly KeypairToken[] = ['natural-person', 'persona', 'extra-persona'];

/** Length cap applied to raw param values before parsing (prevents DoS via 1MB garbage). */
const MAX_ACCEPT_LENGTH = 64;
const MAX_PREFER_LENGTH = 32;
const MAX_REASON_LENGTH = 120;
const MAX_CONSUMER_DISPLAY_NAME_LENGTH = 64;
const MAX_POST_URL_LENGTH = 2048;

function isKeypairToken(token: string): token is KeypairToken {
  return (KEYPAIR_TOKENS as readonly string[]).includes(token);
}

/**
 * Sanitise a free-text `accept_reason`: strip control characters and
 * bidi markers (same rules as the site name), cap at 120 chars.
 */
function sanitiseReason(raw: string): string {
  return sanitizeDisplayName(raw, MAX_REASON_LENGTH);
}

/**
 * Sanitise `consumer_display_name`: same character class as the site name
 * (strip control + bidi), capped at 64 chars. Returns undefined when the
 * cleaned string is empty so callers can spread it conditionally.
 */
function sanitiseConsumerDisplayName(raw: string): string | undefined {
  const clean = sanitizeDisplayName(raw, MAX_CONSUMER_DISPLAY_NAME_LENGTH);
  return clean.length > 0 ? clean : undefined;
}

/**
 * Parse the consumer-hint params out of a URLSearchParams instance.
 * Returns `{ hint, warnings }`. `hint` is null if no filter was requested.
 *
 * Warnings are surfaced back to the consumer via the redirect-back URL
 * (not `console.warn`) per the "no console output" convention.
 */
export function parseConsumerHint(search: string): { hint: ConsumerHint | null; warnings: string[] } {
  const warnings: string[] = [];
  const params = new URLSearchParams(search);

  // Detect multiple accept= values — URLSearchParams.get() returns the first,
  // but more than one is consumer confusion worth flagging.
  const acceptAll = params.getAll('accept');
  if (acceptAll.length > 1) {
    warnings.push('accept-duplicate');
  }

  const rawAccept = acceptAll[0];
  const rawPrefer = params.get('prefer');
  const rawReason = params.get('accept_reason');

  // No filter requested at all → no hint, no warnings.
  if (rawAccept === null && rawPrefer === null && rawReason === null) {
    return { hint: null, warnings };
  }

  // Length-cap before any per-token work.
  let acceptInput = rawAccept ?? '';
  if (acceptInput.length > MAX_ACCEPT_LENGTH) {
    warnings.push('accept-truncated');
    acceptInput = '';
  }

  let preferInput = rawPrefer ?? '';
  if (preferInput.length > MAX_PREFER_LENGTH) {
    warnings.push('prefer-truncated');
    preferInput = '';
  }

  // Tokenise, normalise, dedupe, drop unknowns.
  const rawTokens = acceptInput.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  const seen = new Set<KeypairToken>();
  const allow: KeypairToken[] = [];
  let sawAny = false;
  const unknown: string[] = [];
  for (const token of rawTokens) {
    if (token === 'any') { sawAny = true; continue; }
    if (!isKeypairToken(token)) { unknown.push(token); continue; }
    if (seen.has(token)) continue;
    seen.add(token);
    allow.push(token);
  }
  if (unknown.length > 0) warnings.push(`accept-unknown:${unknown.join(',')}`);

  // `any` as the sole token means 'explicit no filter' (equivalent to omitting
  // the param). Mixed with specific tokens, the specific tokens win — the
  // consumer was explicit, we honour them rather than silently opening the gate.
  const effectiveAllow = (sawAny && allow.length === 0) ? [] : allow;
  const hint: ConsumerHint = {
    allow: effectiveAllow,
  };

  // prefer must be a single recognised token.
  const preferNorm = preferInput.trim().toLowerCase();
  if (preferNorm) {
    if (isKeypairToken(preferNorm)) {
      // If an allow-list was supplied and prefer isn't in it, flag it but still set it.
      // The resolver will decide what to do (ignore prefer if not in allowlist).
      if (hint.allow.length > 0 && !hint.allow.includes(preferNorm)) {
        warnings.push('prefer-not-in-allow');
      }
      hint.prefer = preferNorm;
    } else {
      warnings.push(`prefer-unknown:${preferNorm}`);
    }
  }

  if (rawReason !== null) {
    const clean = sanitiseReason(rawReason);
    if (clean.length > 0) hint.reason = clean;
  }

  // Nothing meaningful in the hint? → return null so callers can skip filter work.
  if (hint.allow.length === 0 && hint.prefer === undefined && hint.reason === undefined) {
    return { hint: null, warnings };
  }

  return { hint, warnings };
}

/**
 * Validate the optional `post=` param against the request origin.
 *
 * `post=` is the post-approval redirect URL — after a successful cross-device
 * sign-in, signet-app renders an "Open <hostname>" button on the relay-ack
 * screen that navigates here when tapped. Same-origin with the auth request
 * is load-bearing: without it, `post=` would be an open-redirector primitive,
 * and the same-origin check turns it into "the site you just authenticated to
 * is allowed to direct your phone to a page within itself afterwards" —
 * which is the trust boundary the user already crossed at approval.
 *
 * Returns `{ postUrl, warnings }`. `postUrl` is the canonicalised URL string
 * when valid, or `undefined` otherwise; `warnings` carries one of the
 * `post-*` tokens describing the rejection reason (or empty for "absent" or
 * "valid"). Invalid `post=` never fails the parse — auth should never break
 * because the consumer's optional companion URL was malformed.
 *
 * See the internal couch-gaming-post-auth-handoff
 * spec for the design rationale.
 */
function validatePostUrl(rawPost: string | null, origin: string): {
  postUrl?: string;
  warnings: string[];
} {
  if (rawPost === null) return { warnings: [] };
  if (rawPost.length > MAX_POST_URL_LENGTH) {
    return { warnings: ['post-too-long'] };
  }
  let url: URL;
  try {
    url = new URL(rawPost);
  } catch {
    return { warnings: ['post-malformed'] };
  }
  if (!isValidOriginScheme(url)) {
    return { warnings: ['post-invalid-scheme'] };
  }
  if (url.origin !== origin) {
    return { warnings: ['post-cross-origin'] };
  }
  return { postUrl: url.toString(), warnings: [] };
}

/**
 * Parse a URL search string into a request + optional consumer hint.
 * Returns null if the protocol-level params don't validate.
 */
export function parseSignInRequest(search: string): {
  request: AuthRequest | LoginRequest;
  hint: ConsumerHint | null;
  warnings: string[];
  consumerDisplayName?: string;
  postUrl?: string;
} | null {
  const request = protocolParse(search);
  if (!request) return null;
  const { hint, warnings } = parseConsumerHint(search);
  const params = new URLSearchParams(search);
  const rawCdn = params.get('consumer_display_name');
  const consumerDisplayName = rawCdn !== null
    ? sanitiseConsumerDisplayName(rawCdn)
    : undefined;
  const { postUrl, warnings: postWarnings } = validatePostUrl(params.get('post'), request.origin);
  const combinedWarnings = postWarnings.length > 0 ? [...warnings, ...postWarnings] : warnings;
  return {
    request,
    hint,
    warnings: combinedWarnings,
    ...(consumerDisplayName ? { consumerDisplayName } : {}),
    ...(postUrl ? { postUrl } : {}),
  };
}

/**
 * Build the callback redirect URL after successful auth. Extends the
 * protocol-level builder with signet-app-specific extras:
 *
 *   - createdAt: unix-seconds `created_at` of the signed kind-21236 event.
 *     Forwarded to `protocolBuildCallback` so the consumer can reconstruct
 *     the auth event for verification without an extra round-trip. Keep
 *     this honest — the value MUST come from the actual signed event, not
 *     from a fresh Date.now(), or the consumer's signature check will fail.
 *   - warnings: list of machine-readable tokens describing parser
 *     complaints about the incoming URL. Surfaced in the response so
 *     the consumer's own dev tooling can see them (§7).
 *   - fromNP:  true when the user took the "sign in with my natural
 *     person instead" fallback despite a persona-only accept hint.
 *     Lets the consumer decide server-side whether to accept it.
 */
export function buildAuthCallbackUrl(
  callbackUrl: string,
  pubkey: string,
  npub: string,
  signature: string,
  eventId: string,
  extras?: {
    createdAt?: number;
    warnings?: string[];
    fromNP?: boolean;
    displayName?: string;
    /**
     * Optional NIP-46 `bunker://...` URI for the redirect-bunker auto-pair
     * flow. When present the consumer's signet-login SDK will use it to
     * stand up a `BunkerSigner`, so the resulting session can sign further
     * events without per-request prompts. Validated as `bunker://` by the
     * SDK before use; we just shuttle it through here.
     */
    bunker?: string;
    /**
     * Optional per-persona avatar metadata (phase 4 of the per-persona-
     * avatars feature). When the signing keypair has an avatar set, the
     * three values flow back via URL params so consumers can decrypt the
     * encrypted Blossom blob without needing to fetch the kind-21236
     * event from a relay. Same values that signAuthChallenge embedded as
     * tags on the signed event — the URL is the convenience channel.
     *
     * `keyHex` is the AES key that decrypts the blob. Profile-picture
     * sensitivity; user is consenting via the sign-in approval itself.
     */
    avatarHash?: string;
    avatarUrl?: string;
    avatarKey?: string;
  },
): string {
  const base = protocolBuildCallback(callbackUrl, pubkey, npub, signature, eventId, extras?.createdAt);
  if (!extras) return base;
  const url = new URL(base);
  if (extras.warnings && extras.warnings.length > 0) {
    url.searchParams.set('warnings', extras.warnings.join(','));
  }
  if (extras.fromNP) {
    url.searchParams.set('fromNP', 'true');
  }
  if (extras.displayName && extras.displayName.length > 0) {
    url.searchParams.set('display_name', extras.displayName);
  }
  if (extras.bunker && extras.bunker.length > 0 && extras.bunker.length <= 8192) {
    // Length cap matches the QR-router URI ceiling in pairing-uri.ts so a
    // pathological URI can't bloat the redirect URL beyond what consumers
    // are prepared to receive.
    url.searchParams.set('bunker', extras.bunker);
  }
  // Avatar fields move together — only set if all three present (we never
  // emit a half-formed avatar trio the consumer can't actually use). Hex
  // and URL caps inherit defensively from what signAuthChallenge would
  // have emitted on the kind-21236 event itself.
  if (extras.avatarHash && extras.avatarUrl && extras.avatarKey) {
    if (/^[0-9a-f]{64}$/i.test(extras.avatarHash)) {
      url.searchParams.set('avatar_hash', extras.avatarHash);
    }
    if (extras.avatarUrl.length <= 500 && /^https?:\/\//.test(extras.avatarUrl)) {
      url.searchParams.set('avatar_url', extras.avatarUrl);
    }
    if (/^[0-9a-f]{64}$/i.test(extras.avatarKey)) {
      url.searchParams.set('avatar_key', extras.avatarKey);
    }
  }
  return url.toString();
}

// ─── ?action=add-dependant URL flow ─────────────────────────────────────────
//
// Third-party-initiated dependant creation. Parser stays signet-app-local —
// the URL contract (`?action=add-dependant&...`) is the public surface that
// matters to consumers, and adding a parser to `signet-protocol` would lock
// the URL shape into a versioned dependency.

const HEX64 = /^[0-9a-f]{64}$/i;
const ADD_DEPENDANT_FRESHNESS_SECONDS = 5 * 60;
const MAX_CHILD_NAME_LENGTH = 100;

export interface AddDependantRequest {
  /** Canonical https origin (or http://localhost for dev). */
  origin: string;
  /** Consumer app display name; sanitised, max 64 chars, non-empty. */
  name: string;
  /** Callback URL — same origin as `origin`. */
  callback: string;
  /** Optional suggested child name — sanitised, max 100 chars, undefined if empty after sanitisation. */
  childName?: string;
  /** Unix seconds; only present (and validated) when caller wants the freshness check. */
  t: number;
  /** 64-char lowercase hex challenge supplied by consumer for replay protection. */
  challenge: string;
}

/** Origin must be `https://...` or `http://localhost`/`http://127.0.0.1` for dev. */
function isValidOriginScheme(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return true;
  return false;
}

/**
 * Parse an `?action=add-dependant&...` request. Returns null for any validation
 * failure; the dispatcher inspects the raw URL params separately when it needs
 * to redirect-back with an error code (e.g. stale_request vs invalid_request).
 */
export function parseAddDependantRequest(search: string): AddDependantRequest | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }

  if (params.get('action') !== 'add-dependant') return null;

  // origin
  const rawOrigin = params.get('origin');
  if (!rawOrigin) return null;
  let originUrl: URL;
  try {
    originUrl = new URL(rawOrigin);
  } catch {
    return null;
  }
  if (!isValidOriginScheme(originUrl)) return null;
  const origin = originUrl.origin;

  // callback — must be https (or localhost) AND same origin as `origin`
  const rawCallback = params.get('callback');
  if (!rawCallback) return null;
  let callbackUrl: URL;
  try {
    callbackUrl = new URL(rawCallback);
  } catch {
    return null;
  }
  if (!isValidOriginScheme(callbackUrl)) return null;
  if (callbackUrl.origin !== origin) return null;
  const callback = callbackUrl.toString();

  // t — required, must be an integer within the freshness window
  const rawT = params.get('t');
  if (!rawT) return null;
  const t = Number(rawT);
  if (!Number.isInteger(t)) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - t) > ADD_DEPENDANT_FRESHNESS_SECONDS) return null;

  // challenge — exactly 64 hex chars, normalised to lowercase
  const rawChallenge = params.get('challenge');
  if (!rawChallenge) return null;
  if (!HEX64.test(rawChallenge)) return null;
  const challenge = rawChallenge.toLowerCase();

  // name — required, sanitised, capped at 64
  const rawName = params.get('name');
  if (rawName === null) return null;
  const name = sanitiseConsumerDisplayName(rawName);
  if (!name) return null;

  // childName — optional. Empty after sanitisation drops to undefined (don't reject).
  const rawChildName = params.get('child_name');
  let childName: string | undefined;
  if (rawChildName !== null) {
    const cleaned = sanitizeDisplayName(rawChildName, MAX_CHILD_NAME_LENGTH);
    if (cleaned.length > 0) childName = cleaned;
  }

  return {
    origin,
    name,
    callback,
    ...(childName ? { childName } : {}),
    t,
    challenge,
  };
}

/**
 * Build the kind-21236 proof-event template for a completed add-dependant
 * approval, ready to hand to a `SigningBackend.signEvent`. Pure — App.tsx
 * signs whatever this returns rather than constructing the template inline,
 * so the `["dependant", dependantPubkey]` tag binding is a testable surface
 * rather than something only exercised end-to-end in the component.
 *
 * Tag order (`challenge`, `origin`, `dependant`) ties the consumer's
 * challenge + origin to the *new* dependant pubkey so the consumer can
 * verify all three with a single Schnorr check against `guardianPubkey`
 * on the resulting event — see `buildAddDependantCallbackUrl`'s doc-comment
 * below for how the callback params relate to this event's fields.
 *
 * `createdAt` defaults to "now" (seconds) but is overridable so callers
 * (tests included) can pin it.
 */
export function buildAddDependantProofTemplate(
  req: Pick<AddDependantRequest, 'challenge' | 'origin'>,
  dependantPubkey: string,
  guardianPubkey: string,
  createdAt: number = Math.floor(Date.now() / 1000),
): UnsignedEvent {
  return {
    pubkey: guardianPubkey,
    kind: 21236,
    created_at: createdAt,
    tags: [
      ['challenge', req.challenge],
      ['origin', req.origin],
      ['dependant', dependantPubkey],
    ],
    content: '',
  };
}

/**
 * Build the callback URL after successful add-dependant approval.
 *
 * Param layout — chosen so a consumer can both identify the new subject AND
 * verify the proof signature without ambiguity:
 *
 *   - `dependantPubkey` (hex) — the new dependant's signing pubkey. This is
 *     the SUBJECT of the operation; the consumer addresses NIP-44 / sign
 *     requests to this pubkey.
 *   - `npub` (bech32) — bech32 form of `dependantPubkey`, paired with it
 *     for ergonomics (matches the `?auth=1` `pubkey`/`npub` pairing
 *     convention where both encode the same identity).
 *   - `guardianPubkey` (hex) — the SIGNER of the proof event. The consumer
 *     verifies the kind-21236 event signature against this key, then
 *     asserts the embedded `["dependant", dependantPubkey]` tag matches.
 *   - `signature` / `eventId` — the proof's Schnorr signature and id.
 *   - `bunker` (optional, url-encoded) — one-shot pairing URI for the new
 *     dependant's `appBunkerEndpoint`, only when the guardian opted in.
 *
 * Returns `null` for any callback whose scheme is not `https://` (or
 * `http://localhost`/`http://127.0.0.1` for dev). Callers MUST treat
 * `null` as "do not redirect" rather than coercing to a string and
 * passing to `window.location.href` — otherwise a malicious consumer
 * supplying e.g. `javascript:alert(1)` as `callback` could route the
 * post-approval redirect into script execution. The dispatcher path
 * already pre-validates the callback before this is called, but
 * enforcing the invariant here too keeps any future caller honest.
 */
export function buildAddDependantCallbackUrl(
  callbackUrl: string,
  dependantPubkey: string,
  npub: string,
  guardianPubkey: string,
  signature: string,
  eventId: string,
  extras?: { bunker?: string },
): string | null {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return null;
  }
  if (!isValidOriginScheme(url)) return null;
  url.searchParams.set('dependantPubkey', dependantPubkey);
  url.searchParams.set('npub', npub);
  url.searchParams.set('guardianPubkey', guardianPubkey);
  url.searchParams.set('signature', signature);
  url.searchParams.set('eventId', eventId);
  if (extras?.bunker && extras.bunker.length > 0) {
    url.searchParams.set('bunker', extras.bunker);
  }
  return url.toString();
}

/**
 * Build an error redirect for the add-dependant flow. Mirrors
 * `buildAuthDeniedUrl` but with a configurable `error=<token>`.
 *
 * Tokens used by the dispatcher: `denied` | `invalid_request` |
 * `create_failed` | `stale_request`.
 *
 * Returns `null` for any callback whose scheme is not `https://` (or
 * `http://localhost`/`http://127.0.0.1` for dev). Same invariant as
 * `buildAddDependantCallbackUrl` — see that function's comment.
 */
export function buildAddDependantErrorUrl(callbackUrl: string, error: string): string | null {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return null;
  }
  if (!isValidOriginScheme(url)) return null;
  url.searchParams.set('error', error);
  return url.toString();
}
