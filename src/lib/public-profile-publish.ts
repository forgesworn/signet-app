/**
 * Per-persona public Nostr profile (kind-0) publish / retract / fetch.
 *
 * The per-persona-public-profile design doc §5 (2026-05-16) covers the
 * full spec. Brief recap:
 *
 *   - kind-0 events publish to `preferences.relayUrl`, signed by the
 *     persona's own keypair (LocalSigningBackend / BunkerSigningBackend /
 *     Nip07SigningBackend — any backend that exposes signEvent works).
 *   - `created_at` follows the §5.1.1 monotonicity formula to dodge
 *     clock-skew rejections from relays that enforce strict ordering
 *     on (pubkey, kind) replaceable events.
 *   - kind-5 retraction issues a NIP-09 deletion request referencing the
 *     last kind-0 event ID, plus a tombstone kind-0 (content: "{}") so
 *     any relay that doesn't honour kind-5 at least sees an empty
 *     replacement.
 *   - Inbound kind-0 content goes through strict validation
 *     (`parseKindZeroContent`) before being applied — URL scheme allowlist,
 *     length caps, regex on NIP-05/LUD-16.
 *
 * Module surface:
 *   publishPublicProfile  — sign + publish a kind-0 from a PublicProfileConfig + state pair
 *   retractPublicProfile  — sign + publish a kind-5 + tombstone kind-0
 *   fetchPublicProfile    — query a relay for the latest kind-0 for a pubkey
 *   buildKindZeroContent  — pure helper, returns canonical JSON string for kind-0 content
 *   parseKindZeroContent  — pure helper, validates + sanitises an inbound kind-0 content blob
 *   safeImageOrLinkUrl    — URL scheme allowlist (https: / http: only)
 *   contentHashFor        — pure helper, returns a stable content hash for §5.3.3 idempotency
 */

import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import { publishEvent, fetchEvents } from './relay-service';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SigningBackend } from './signing-backend';
import { verifiedAuthoredEvents } from './event-verify';
import { isValidRelayUrl } from './relay-url';
import { isPrivateOrInternalHost } from './safe-url';
import type { PersonaPublicProfile, PublicProfileConfig } from '../types';

// ─── Constants ─────────────────────────────────────────────────────────────

const KIND_PROFILE = 0;
const KIND_DELETION = 5;

const HEX64 = /^[0-9a-f]{64}$/i;
const NIP05_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/;

/** Per-field caps. See design doc Appendix A. */
const CAP_NAME = 50;
const CAP_DISPLAY_NAME = 100;
const CAP_ABOUT = 500;
const CAP_PICTURE_URL = 500;
const CAP_BANNER_URL = 500;
const CAP_NIP05 = 100;
const CAP_LUD16 = 100;
const CAP_WEBSITE = 300;

const RELAY_FETCH_TIMEOUT_MS = 2000;
const RELAY_PUBLISH_TIMEOUT_MS = 30000;

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * URL scheme allowlist for any field that ends up as a `<img src>` or `<a href>`
 * downstream. Rejects javascript:/data:/file:/blob:/ftp:/custom schemes.
 *
 * Tightened (security audit 2026-05-18) to mirror `blossom.ts` — only
 * `https:` survives, except for `http://localhost` and `http://127.0.0.1`
 * for local development. Plain `http://` on the public internet would
 * downgrade the user's TLS posture and is rejected.
 */
export function safeImageOrLinkUrl(raw: string): URL | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  // Local-dev exception: explicit http loopback for the user's OWN dev server.
  // Returned before the SSRF guard below since loopback is intentional here.
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return url;
  }
  if (url.protocol !== 'https:') return null;
  // SSRF / IP-leak guard (security audit 2026-06-15). A contact- or
  // profile-controlled https URL pointing at a private/loopback/link-local/
  // metadata host would let a passive render probe the victim's internal
  // network. Public avatar/profile hosts are never internal IPs, so this is
  // pure hardening for legitimate use.
  if (isPrivateOrInternalHost(url.hostname)) return null;
  return url;
}

/**
 * Strip control / bidi characters from a string and cap length. Mirrors the
 * sanitise helper in persona-inventory-sync.ts so inbound kind-0 strings get
 * the same treatment as inventory-rail strings.
 */
function sanitiseText(value: string, maxLen: number): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]", "g"), "").slice(0, maxLen);
}

/**
 * Build the JSON string used for kind-0 `content`. Per §3.4 of the design,
 * keys are emitted in a stable order so reads are diff-friendly. Empty-string
 * field values are converted to omitted fields (never `""`).
 *
 * `config.displayName` is the single source of truth for the human-readable
 * name — it populates BOTH the NIP-01 `name` and `display_name` JSON keys.
 * Falls back to `fallbackDisplayName` when the slot has no `displayName` set.
 *
 * Storage-only fields on PublicProfileConfig (`pictureBlossomHash`,
 * `bannerBlossomHash`) are ignored — kind-0 content carries the rendered URL
 * only.
 */
export function buildKindZeroContent(
  config: PublicProfileConfig,
  fallbackDisplayName: string,
): string {
  const out: Record<string, string> = {};

  // Single source of truth: config.displayName populates BOTH `name` and
  // `display_name`. Different caps apply (CAP_NAME=50 for the short handle
  // most clients render as @handle; CAP_DISPLAY_NAME=100 for the longer
  // human-friendly variant) — the same raw input is truncated independently
  // for each slot.
  const rawName = config.displayName || fallbackDisplayName || '';
  const name = sanitiseText(rawName, CAP_NAME).trim();
  if (name) out.name = name;
  const displayName = sanitiseText(rawName, CAP_DISPLAY_NAME).trim();
  if (displayName) out.display_name = displayName;

  if (config.about && config.about.length > 0) {
    const ab = sanitiseText(config.about, CAP_ABOUT);
    if (ab) out.about = ab;
  }

  if (config.pictureUrl && config.pictureUrl.length > 0 && config.pictureUrl.length <= CAP_PICTURE_URL) {
    if (safeImageOrLinkUrl(config.pictureUrl)) out.picture = config.pictureUrl;
  }

  if (config.bannerUrl && config.bannerUrl.length > 0 && config.bannerUrl.length <= CAP_BANNER_URL) {
    if (safeImageOrLinkUrl(config.bannerUrl)) out.banner = config.bannerUrl;
  }

  if (config.nip05 && config.nip05.length > 0 && config.nip05.length <= CAP_NIP05 && NIP05_RE.test(config.nip05)) {
    out.nip05 = config.nip05;
  }

  if (config.lud16 && config.lud16.length > 0 && config.lud16.length <= CAP_LUD16 && NIP05_RE.test(config.lud16)) {
    out.lud16 = config.lud16;
  }

  if (config.website && config.website.length > 0 && config.website.length <= CAP_WEBSITE) {
    if (safeImageOrLinkUrl(config.website)) out.website = config.website;
  }

  return JSON.stringify(out);
}

/**
 * Parse + validate an inbound kind-0 content blob. Returns a partial
 * PublicProfileConfig populated with whatever fields survived validation,
 * or null if the JSON itself doesn't parse. Individual invalid fields are
 * silently dropped — we'd rather surface a partial config than discard the
 * whole event because of e.g. a malformed nip05.
 *
 * `displayName` resolution: prefer the inbound `display_name`, fall back to
 * the short `name` field. There is no separate `name` field on
 * PublicProfileConfig — the slot's `displayName` is the single source of
 * truth.
 */
export function parseKindZeroContent(
  raw: string,
): Partial<PublicProfileConfig> | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const r = obj as Record<string, unknown>;
  const out: Partial<PublicProfileConfig> = {};

  // displayName resolution: prefer display_name (longer cap), fall back to name.
  if (typeof r.display_name === 'string') {
    const v = sanitiseText(r.display_name, CAP_DISPLAY_NAME).trim();
    if (v) out.displayName = v;
  }
  if (!out.displayName && typeof r.name === 'string') {
    const v = sanitiseText(r.name, CAP_NAME).trim();
    if (v) out.displayName = v;
  }
  if (typeof r.about === 'string') {
    const v = sanitiseText(r.about, CAP_ABOUT);
    if (v) out.about = v;
  }
  if (typeof r.picture === 'string' && r.picture.length <= CAP_PICTURE_URL && safeImageOrLinkUrl(r.picture)) {
    out.pictureUrl = r.picture;
  }
  if (typeof r.banner === 'string' && r.banner.length <= CAP_BANNER_URL && safeImageOrLinkUrl(r.banner)) {
    out.bannerUrl = r.banner;
  }
  if (typeof r.nip05 === 'string' && r.nip05.length <= CAP_NIP05 && NIP05_RE.test(r.nip05)) {
    out.nip05 = r.nip05;
  }
  if (typeof r.lud16 === 'string' && r.lud16.length <= CAP_LUD16 && NIP05_RE.test(r.lud16)) {
    out.lud16 = r.lud16;
  }
  if (typeof r.website === 'string' && r.website.length <= CAP_WEBSITE && safeImageOrLinkUrl(r.website)) {
    out.website = r.website;
  }

  return out;
}

/**
 * Stable content hash for §5.3.3 idempotency — "no changes to publish."
 * Hashes the canonical kind-0 content string so two semantically-identical
 * profiles produce identical hashes regardless of whether the user re-typed
 * the same text. Distinct from the kind-0 event ID (which incorporates
 * created_at and tags).
 */
export function contentHashFor(
  config: PublicProfileConfig,
  fallbackDisplayName: string,
): string {
  const content = buildKindZeroContent(config, fallbackDisplayName);
  return bytesToHex(sha256(new TextEncoder().encode(content)));
}

// ─── Publish / Retract / Fetch ─────────────────────────────────────────────

export interface PublishResult {
  ok: boolean;
  eventId: string;
  relayUrl: string;
  createdAt: number;
  message?: string;
}

/**
 * Sign + publish a kind-0 event for this persona. `created_at` follows the
 * §5.1.1 monotonicity formula to clear relay timestamp checks even when the
 * device clock is behind. Returns an all-or-nothing result the caller writes
 * onto `publicProfile.lastEventId/lastPublishedAt/lastPublishedRelay` only
 * when `ok: true` (§5.1.3 atomicity contract).
 */
export async function publishPublicProfile(
  config: PublicProfileConfig,
  state: PersonaPublicProfile | undefined,
  fallbackDisplayName: string,
  backend: SigningBackend,
  relayUrl: string,
  /**
   * §5.3.3 content-hash short-circuit. When provided AND the candidate's
   * content hash matches, the function returns ok=true WITHOUT touching
   * the relay (the kind-0 we'd produce is byte-for-byte identical to the
   * last published one). The returned `eventId`/`createdAt` are the prior
   * values so the caller's atomicity contract still holds. Optional —
   * absence falls through to a real publish.
   */
  lastPublishedContentHash?: string,
): Promise<PublishResult> {
  if (!isValidRelayUrl(relayUrl)) {
    return { ok: false, eventId: '', relayUrl, createdAt: 0, message: 'no relay configured' };
  }
  const now = Math.floor(Date.now() / 1000);
  const created_at = Math.max(now, (state?.lastPublishedAt ?? 0) + 1);

  const content = buildKindZeroContent(config, fallbackDisplayName);

  // §5.3.3 short-circuit. Hash the canonical content string; if it matches
  // the caller's last-published hash, skip the relay round-trip. We still
  // return ok=true so the caller doesn't re-prompt the user to retry, but
  // we don't overwrite eventId/lastPublishedAt (those carry the prior
  // published state). The message is the surfaced "no changes" copy.
  if (lastPublishedContentHash && state?.lastEventId && state?.lastPublishedAt) {
    const candidateHash = bytesToHex(sha256(new TextEncoder().encode(content)));
    if (candidateHash === lastPublishedContentHash) {
      return {
        ok: true,
        eventId: state.lastEventId,
        relayUrl: state.lastPublishedRelay || relayUrl,
        createdAt: state.lastPublishedAt,
        message: 'no changes to publish',
      };
    }
  }

  const unsigned: UnsignedEvent = {
    pubkey: backend.activePublicKeyHex,
    kind: KIND_PROFILE,
    created_at,
    tags: [],
    content,
  };

  let signed: NostrEvent;
  try {
    signed = await backend.signEvent(unsigned);
  } catch (err) {
    return {
      ok: false, eventId: '', relayUrl, createdAt: created_at,
      message: err instanceof Error ? err.message : 'sign failed',
    };
  }

  try {
    // C2: target ONLY the caller's relayUrl — this is a per-persona publish
    // to `preferences.relayUrl` (the single "configured relay" per the
    // three-rail model), not a broadcast to the whole relay pool. Fanning
    // out to the pool silently disconnected `lastPublishedRelay` from
    // where the event actually landed.
    const result = await publishEvent(signed, { timeoutMs: RELAY_PUBLISH_TIMEOUT_MS, relays: [relayUrl] });
    if (!result.ok) {
      return {
        ok: false, eventId: signed.id, relayUrl, createdAt: created_at,
        message: result.message || 'relay rejected',
      };
    }
    return { ok: true, eventId: signed.id, relayUrl, createdAt: created_at };
  } catch (err) {
    return {
      ok: false, eventId: signed.id, relayUrl, createdAt: created_at,
      message: err instanceof Error ? err.message : 'publish failed',
    };
  }
}

/**
 * Sign + publish a kind-5 deletion request referencing the last kind-0
 * event ID, plus a tombstone kind-0 (`content: "{}"`) so any relay that
 * doesn't honour kind-5 at least sees an empty replacement.
 *
 * Returns separate ok flags for the two events. Caller flips
 * `publicProfile.enabled = false` regardless of outcome (per §6.7) —
 * the local state can always be reduced.
 */
export async function retractPublicProfile(
  lastEventId: string,
  backend: SigningBackend,
  relayUrl: string,
  /** Monotonicity baseline for kind-5 created_at (same formula as publish). */
  previousPublishedAt: number | undefined,
): Promise<{ deletionOk: boolean; tombstoneOk: boolean }> {
  if (!isValidRelayUrl(relayUrl)) return { deletionOk: false, tombstoneOk: false };

  const now = Math.floor(Date.now() / 1000);
  const created_at = Math.max(now, (previousPublishedAt ?? 0) + 1);

  let deletionOk = false;
  let tombstoneOk = false;

  if (HEX64.test(lastEventId)) {
    const deletionUnsigned: UnsignedEvent = {
      pubkey: backend.activePublicKeyHex,
      kind: KIND_DELETION,
      created_at,
      tags: [
        ['e', lastEventId.toLowerCase()],
        ['k', String(KIND_PROFILE)],
      ],
      content: '',
    };
    try {
      const signed = await backend.signEvent(deletionUnsigned);
      // C2: retraction MUST reach the relay the original event actually
      // lives on. Callers pass `lastPublishedRelay` here (not
      // `preferences.relayUrl`, which may since have changed) — targeting
      // the pool instead would leave the original event live forever.
      const r = await publishEvent(signed, { timeoutMs: RELAY_PUBLISH_TIMEOUT_MS, relays: [relayUrl] });
      deletionOk = r.ok;
    } catch { deletionOk = false; }
  }

  // Tombstone kind-0 — empty content, monotonically newer.
  const tombstoneUnsigned: UnsignedEvent = {
    pubkey: backend.activePublicKeyHex,
    kind: KIND_PROFILE,
    created_at: created_at + 1,
    tags: [],
    content: '{}',
  };
  try {
    const signed = await backend.signEvent(tombstoneUnsigned);
    const r = await publishEvent(signed, { timeoutMs: RELAY_PUBLISH_TIMEOUT_MS, relays: [relayUrl] });
    tombstoneOk = r.ok;
  } catch { tombstoneOk = false; }

  return { deletionOk, tombstoneOk };
}

/**
 * Fetch the latest kind-0 event for a pubkey from a relay, with a hard
 * timeout (default 2 seconds — onboarding flows expect a snappy response).
 * Returns null on timeout, relay error, no event found, or parse failure.
 */
export async function fetchPublicProfile(
  pubkey: string,
  relayUrl: string,
  timeoutMs: number = RELAY_FETCH_TIMEOUT_MS,
): Promise<{ event: NostrEvent; profile: Partial<PublicProfileConfig> } | null> {
  if (!isValidRelayUrl(relayUrl)) return null;
  if (!HEX64.test(pubkey)) return null;

  try {
    const events = await fetchEvents(
      [{ kinds: [KIND_PROFILE], authors: [pubkey.toLowerCase()], limit: 1 } as never],
      { timeoutMs, relays: [relayUrl] },
    );
    if (events.length === 0) return null;
    // Hostile relays may return events with a wrong `event.pubkey` despite
    // the `authors:` filter — verify signature + author match before trust.
    const valid = verifiedAuthoredEvents(events as unknown as Array<{ pubkey: string; sig: string; id: string }>, pubkey);
    if (valid.length === 0) return null;
    const latest = (valid as unknown as NostrEvent[]).sort((a, b) => b.created_at - a.created_at)[0];
    const profile = parseKindZeroContent(latest.content);
    if (!profile) return null;
    return { event: latest, profile };
  } catch {
    return null;
  }
}
