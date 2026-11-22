/**
 * NIP-05 verification check for a persona card. Pure module — no React,
 * no DB. Looks up a NIP-05 identifier's `.well-known/nostr.json` and
 * compares the returned pubkey against the slot's own pubkey.
 *
 * Never auto-runs — every call here is the direct result of a user tapping
 * "Check" in `SlotProfileFields.tsx`.
 */

import { isPrivateOrInternalHost } from './safe-url';

export type Nip05CheckResult = 'match' | 'mismatch' | 'not-found' | 'unreachable';

export interface ParsedNip05 {
  readonly name: string;
  readonly domain: string;
}

// NIP-05 local-part charset (case-insensitive; `_` is the root-name special
// case and is already covered by this charset).
const NAME_RE = /^[a-z0-9._-]+$/;

// A conservative hostname shape: dot-separated labels, each 1-63 chars,
// alphanumeric with internal hyphens only (no leading/trailing hyphen).
const HOSTNAME_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

// The last label must be letters (2-63) or punycode, as kenspeckle's resolver
// insists, so an address the app accepts is one the resolver will take. This
// also rules out every spelling of an IPv4 literal (`127.1`, `0x7f.1`).
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

const HEX64_RE = /^[0-9a-f]{64}$/i;

// Practical caps (RFC 3696-style) — reject absurdly long identifiers before
// doing any parsing work on them.
const MAX_IDENTIFIER_LEN = 320;
const MAX_DOMAIN_LEN = 253;

const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Parse a NIP-05 identifier (`name@domain`, or a bare `domain`, which is the
 * root name `_@domain`). Returns null for anything that
 * isn't a well-formed, public, hostname-addressed identifier — empty input,
 * multiple `@`, whitespace, an IP literal (v4 dotted-quad or bracketed v6),
 * a domain carrying a scheme/path/port/userinfo, a single-label domain (no
 * dot — e.g. `alice@intranet`), a trailing-dot domain, an identifier over
 * 320 chars or a domain over 253 chars, or a private/internal host (via
 * `isPrivateOrInternalHost`). A local part with `+` (or any character outside
 * the NIP-05 set) is refused. Trims and lowercases first, so callers
 * never need to normalise the input themselves.
 */
export function parseNip05(identifier: string): ParsedNip05 | null {
  if (typeof identifier !== 'string') return null;
  const trimmed = identifier.trim().toLowerCase();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (trimmed.length > MAX_IDENTIFIER_LEN) return null;

  const atCount = (trimmed.match(/@/g) ?? []).length;
  if (atCount > 1) return null;

  // No `@`: a bare domain stands for the root name `_@domain`. The domain
  // checks below still apply (it must contain a dot, so a lone word fails).
  const atIndex = trimmed.indexOf('@');
  const name = atIndex === -1 ? '_' : trimmed.slice(0, atIndex);
  const domain = atIndex === -1 ? trimmed : trimmed.slice(atIndex + 1);
  if (!name || !domain) return null;
  if (!NAME_RE.test(name)) return null;
  if (domain.length > MAX_DOMAIN_LEN) return null;

  // Reject anything that isn't a bare hostname — a scheme, path, port,
  // userinfo, or IPv6 literal would all smuggle extra structure into what
  // must be exactly a domain for the `.well-known/nostr.json` lookup URL.
  if (domain.includes(':') || domain.includes('/') || domain.includes('[') || domain.includes(']')) {
    return null;
  }
  if (IPV4_RE.test(domain)) return null; // IP literals are never valid NIP-05 domains
  if (!domain.includes('.')) return null; // require at least one dot — no bare/single-label hosts
  if (!HOSTNAME_RE.test(domain)) return null;
  if (!TLD_RE.test(domain.slice(domain.lastIndexOf('.') + 1))) return null;
  if (isPrivateOrInternalHost(domain)) return null;

  return { name, domain };
}

/**
 * The stored/published form of a NIP-05 identifier: `name@domain`, lowercased,
 * with a bare domain written as `_@domain`. Null when it doesn't parse. Every
 * writer (profile Save, the Ken form, the New contact lookup) stores this, so
 * a bare domain never reaches a kind-0 or a resolver.
 */
export function canonicalNip05(text: string): string | null {
  const parsed = parseNip05(text);
  return parsed ? `${parsed.name}@${parsed.domain}` : null;
}

/**
 * How to SHOW an identifier as text: a local part of exactly `_` (any case)
 * shows as the domain alone; anything else is unchanged. Display only: never
 * put this in an input's value, and stored values stay `_@domain`.
 */
export function displayNip05(id: string): string {
  if (typeof id !== 'string') return id;
  const at = id.indexOf('@');
  if (at === 1 && id[0] === '_' && id.indexOf('@', 2) === -1 && id.length > 2) return id.slice(2);
  return id;
}

/** Build the `.well-known/nostr.json` lookup URL. Always https. */
export function buildNip05LookupUrl(parsed: ParsedNip05): string {
  return `https://${parsed.domain}/.well-known/nostr.json?name=${encodeURIComponent(parsed.name)}`;
}

/**
 * Evaluate an already-parsed JSON response body against the expected name
 * and pubkey. Never throws — any shape mismatch resolves to 'not-found'.
 */
export function evaluateNip05Response(
  body: unknown,
  name: string,
  pubkeyHex: string,
): Exclude<Nip05CheckResult, 'unreachable'> {
  if (typeof body !== 'object' || body === null) return 'not-found';
  const names = (body as Record<string, unknown>).names;
  if (typeof names !== 'object' || names === null || Array.isArray(names)) return 'not-found';

  const value = (names as Record<string, unknown>)[name];
  if (typeof value !== 'string') return 'not-found';
  const trimmedValue = value.trim();
  if (!HEX64_RE.test(trimmedValue)) return 'not-found';

  return trimmedValue.toLowerCase() === pubkeyHex.toLowerCase() ? 'match' : 'mismatch';
}

/**
 * Read a Response body as text, capped at `maxBytes`. Returns null (never
 * throws) when the body exceeds the cap or can't be read.
 */
async function readCappedText(response: Response, maxBytes: number): Promise<string | null> {
  try {
    const text = await response.text();
    // Byte length, not UTF-16 code-unit length — a non-ASCII body near the
    // cap could otherwise slip through.
    if (new TextEncoder().encode(text).length > maxBytes) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Look up a NIP-05 identifier and report whether it lists `pubkeyHex`.
 * Never throws — every failure (parse, network, timeout, shape, size)
 * resolves to 'unreachable'. Only ever called from the explicit "Check"
 * button tap — no effect anywhere calls this automatically.
 */
export async function checkNip05(
  identifier: string,
  pubkeyHex: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Nip05CheckResult> {
  const parsed = parseNip05(identifier);
  // parseNip05 already rejects private/internal hosts and malformed
  // domains. This guard exists so a private/internal host can NEVER reach
  // fetch() from this function, even if some future caller skips the
  // field's own format validation before calling checkNip05 directly.
  if (!parsed) return 'unreachable';

  const url = buildNip05LookupUrl(parsed);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      // A NIP-05 lookup must not follow redirects — that's a classic way
      // to bounce a client to an internal address after the initial host
      // has already passed the private/internal-host guard above.
      redirect: 'error',
      credentials: 'omit',
      mode: 'cors',
      // The user taps Check right after editing their nostr.json. Sites
      // commonly serve it with a long max-age (days), and a cached copy
      // would keep reporting the old answer until it expired.
      cache: 'no-store',
    });
    if (!response.ok) return 'unreachable';

    const text = await readCappedText(response, MAX_BODY_BYTES);
    if (text === null) return 'unreachable';

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return 'unreachable';
    }

    return evaluateNip05Response(body, parsed.name, pubkeyHex);
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}
