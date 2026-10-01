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
 *   mergeKindZeroContent  — pure three-way merge: Signet's edits onto the relay's kind-0, losslessly
 *   toPublicProfileBase   — pure helper, the device-local "last known relay kind-0" record
 */

import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import { publishEvent, fetchEvents } from './relay-service';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SigningBackend } from './signing-backend';
import { verifiedAuthoredEvents } from './event-verify';
import { isValidRelayUrl } from './relay-url';
import { isPrivateOrInternalHost } from './safe-url';
import type { PersonaPublicProfile, PublicProfileBase, PublicProfileConfig } from '../types';
import { fetchExistingProfile } from './existing-profile';
import { CAP_ABOUT } from './about-cap';

// ─── Constants ─────────────────────────────────────────────────────────────

const KIND_PROFILE = 0;
const KIND_DELETION = 5;

const HEX64 = /^[0-9a-f]{64}$/i;
const NIP05_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/;

/** Per-field caps. See design doc Appendix A. */
const CAP_NAME = 50;
const CAP_DISPLAY_NAME = 100;
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
 * Strip control / bidi characters and cap length (in CODE POINTS, so the cap
 * never lands mid-surrogate-pair). Mirrors the sanitise helper in
 * persona-inventory-sync.ts so inbound kind-0 strings get the same treatment
 * as inventory-rail strings.
 *
 * U+200C (ZWNJ) and U+200D (ZWJ) are NOT stripped: emoji sequences and some
 * scripts need them to render at all. U+200B, the directional marks U+200E/F
 * and the bidi embedding / override / isolate ranges still go.
 *
 * `multiline` (the `about` field only) keeps `\n` and `\t` and normalises
 * `\r\n` / `\r` to `\n`, as `sanitizeNote` does; every other field is a single
 * line and loses all control characters.
 */
// eslint-disable-next-line no-control-regex
const STRIP_SINGLE_LINE = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;
// eslint-disable-next-line no-control-regex
const STRIP_MULTI_LINE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;

function sanitiseText(value: string, maxLen: number, multiline = false): string {
  const input = multiline ? value.replace(/\r\n?/g, '\n') : value;
  const stripped = input.replace(multiline ? STRIP_MULTI_LINE : STRIP_SINGLE_LINE, '');
  if (stripped.length <= maxLen) return stripped;
  return Array.from(stripped).slice(0, maxLen).join('');
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
    const ab = sanitiseText(config.about, CAP_ABOUT, true);
    if (ab.trim()) out.about = ab;
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
    const v = sanitiseText(r.about, CAP_ABOUT, true);
    if (v.trim()) out.about = v;
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

// ─── Stored base + three-way merge ─────────────────────────────────────────

/** A stored base is kept only while it is small enough to live on a slot. */
const MAX_BASE_CONTENT_CHARS = 65536;
const MAX_BASE_TAG_CHARS = 65536;

/**
 * Build the device-local `PublicProfileBase` for a kind-0 event, or
 * `undefined` when it is too big to store (content over 64 KiB, or tags over
 * 64 KiB in total). Without a base the next publish falls back to the plain
 * build from the card — see `mergeKindZeroContent`.
 */
export function toPublicProfileBase(
  event: { id: string; created_at: number; content: string; tags: string[][] },
  matched = false,
): PublicProfileBase | undefined {
  if (typeof event.content !== 'string' || event.content.length > MAX_BASE_CONTENT_CHARS) return undefined;
  if (!Array.isArray(event.tags)) return undefined;
  let tagChars = 0;
  const tags: string[][] = [];
  for (const t of event.tags) {
    if (!Array.isArray(t)) return undefined;
    const row = t.map(v => String(v));
    for (const v of row) tagChars += v.length;
    if (tagChars > MAX_BASE_TAG_CHARS) return undefined;
    tags.push(row);
  }
  return {
    eventId: event.id,
    createdAt: event.created_at,
    content: event.content,
    tags,
    ...(matched ? { matched: true as const } : {}),
  };
}

function parseObject(raw: string): Record<string, unknown> | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  return obj as Record<string, unknown>;
}

export interface KindZeroMergeResult {
  content: string;
  tags: string[][];
  /** True when the output was built from a relay kind-0 (three-way merge);
   *  false when the plain card build was used. */
  merged: boolean;
}

/**
 * THREE-WAY merge of Signet's card onto the relay's kind-0, so publishing from
 * Signet never destroys what Signet does not manage (`bot`, `birthday`,
 * `lud06`, unknown keys, tags, a distinct `name` handle, bio line breaks).
 *
 * Two different inputs, deliberately not conflated:
 *   - `comparisonContent` — the slot's STORED base content (what Signet last
 *     knew of the relay version). A field counts as "edited in Signet" iff the
 *     card value differs from what `parseKindZeroContent` reads from it.
 *   - `contentBase` — the NEWER of the freshly fetched kind-0 and the stored
 *     base. The output starts from this object and its tags, verbatim. So an
 *     edit made elsewhere after the match is kept unless the same field was
 *     ALSO edited in Signet, in which case Signet wins for that field only.
 *
 * Falls back to today's plain build (`buildKindZeroContent`, `tags: []`) when
 * there is no comparison content, when either JSON is not a plain object, or
 * when the content base is an empty object (a tombstone — publishing from it
 * would silently drop every un-edited card field).
 *
 * Per Signet-managed field (about, picture, banner, nip05, lud16, website):
 * not edited -> the content base's raw value is left alone (present, absent,
 * or shaped however it is); edited and empty -> the key is deleted; edited and
 * non-empty -> the sanitised / validated Signet value is set (a value that
 * fails validation leaves the raw value alone rather than guess). Display
 * name: not edited -> `name` and `display_name` stay raw; edited -> set
 * `display_name`, and set `name` ONLY when the content base has no non-empty
 * `name` (a handle is never overwritten). Deprecated `displayName` /
 * `username` keys are never touched.
 *
 * When nothing is edited the content base string is returned VERBATIM, which
 * keeps key order / whitespace and lets the content-hash short-circuit hold.
 */
export function mergeKindZeroContent(args: {
  comparisonContent: string | undefined;
  contentBase: { content: string; tags: string[][] } | undefined;
  config: PublicProfileConfig;
  fallbackDisplayName: string;
}): KindZeroMergeResult {
  const { comparisonContent, contentBase, config, fallbackDisplayName } = args;
  const legacy = (): KindZeroMergeResult => ({
    content: buildKindZeroContent(config, fallbackDisplayName),
    tags: [],
    merged: false,
  });
  if (comparisonContent === undefined || !contentBase) return legacy();
  const compared = parseKindZeroContent(comparisonContent);
  if (!compared) return legacy();
  const obj = parseObject(contentBase.content);
  if (!obj || Object.keys(obj).length === 0) return legacy();

  // Both sides go through the same sanitiser before comparing, so a CRLF
  // paste, a cap or a trailing newline cannot make an untouched value read as
  // "edited" and overwrite it.
  const edited = {
    about: sanitiseText(config.about ?? '', CAP_ABOUT, true).trim() !== (compared.about ?? '').trim(),
    picture: (config.pictureUrl ?? '') !== (compared.pictureUrl ?? ''),
    banner: (config.bannerUrl ?? '') !== (compared.bannerUrl ?? ''),
    nip05: (config.nip05 ?? '') !== (compared.nip05 ?? ''),
    lud16: (config.lud16 ?? '') !== (compared.lud16 ?? ''),
    website: (config.website ?? '') !== (compared.website ?? ''),
  };
  const rawName = config.displayName || fallbackDisplayName || '';
  const nameEdited = sanitiseText(rawName, CAP_DISPLAY_NAME).trim() !== (compared.displayName ?? '');

  const tags = contentBase.tags.map(t => [...t]);
  const anyEdit = nameEdited || Object.values(edited).some(Boolean);
  if (!anyEdit) return { content: contentBase.content, tags, merged: true };

  const setOrDelete = (key: string, edit: boolean, value: string | undefined, valid: boolean) => {
    if (!edit) return;
    if (!value) { delete obj[key]; return; }
    if (valid) obj[key] = value;
  };

  if (edited.about) {
    const ab = sanitiseText(config.about ?? '', CAP_ABOUT, true);
    setOrDelete('about', true, ab.trim() ? ab : undefined, true);
  }
  const pic = config.pictureUrl ?? '';
  setOrDelete('picture', edited.picture, pic, pic.length <= CAP_PICTURE_URL && safeImageOrLinkUrl(pic) !== null);
  const ban = config.bannerUrl ?? '';
  setOrDelete('banner', edited.banner, ban, ban.length <= CAP_BANNER_URL && safeImageOrLinkUrl(ban) !== null);
  const n05 = config.nip05 ?? '';
  setOrDelete('nip05', edited.nip05, n05, n05.length <= CAP_NIP05 && NIP05_RE.test(n05));
  const l16 = config.lud16 ?? '';
  setOrDelete('lud16', edited.lud16, l16, l16.length <= CAP_LUD16 && NIP05_RE.test(l16));
  const web = config.website ?? '';
  setOrDelete('website', edited.website, web, web.length <= CAP_WEBSITE && safeImageOrLinkUrl(web) !== null);

  if (nameEdited) {
    const display = sanitiseText(rawName, CAP_DISPLAY_NAME).trim();
    if (display) {
      obj.display_name = display;
      const existingHandle = obj.name;
      if (typeof existingHandle !== 'string' || existingHandle.trim() === '') {
        const handle = sanitiseText(rawName, CAP_NAME).trim();
        if (handle) obj.name = handle;
      }
    }
  }

  return { content: JSON.stringify(obj), tags, merged: true };
}

/**
 * After a three-way merge the published kind-0 can carry values the card never
 * had. This brings the card in line, ADDITIVELY: a field is adopted only when
 * the published content has the key, non-empty, it passes the same parser as
 * any inbound kind-0, and it differs from the card. Anything else (key absent,
 * empty, unparseable, equal) leaves the card exactly as it was — the relay
 * content lacking a key must never clear a card field.
 *
 * The display name is returned separately as `name` (never folded into
 * `config`) and only when `adoptName` is set; the natural-person slot passes
 * false, because a legal name must never be written from relay content.
 */
export function adoptPublishedIntoCard(
  config: PublicProfileConfig,
  publishedContent: string,
  opts: { adoptName: boolean },
): { config: PublicProfileConfig; name?: string } {
  const published = parseKindZeroContent(publishedContent);
  if (!published) return { config };
  const next: PublicProfileConfig = { ...config };
  if (published.about && published.about !== config.about) next.about = published.about;
  if (published.pictureUrl && published.pictureUrl !== config.pictureUrl) {
    next.pictureUrl = published.pictureUrl;
    next.pictureBlossomHash = undefined;
  }
  if (published.bannerUrl && published.bannerUrl !== config.bannerUrl) {
    next.bannerUrl = published.bannerUrl;
    next.bannerBlossomHash = undefined;
  }
  if (published.nip05 && published.nip05 !== config.nip05) next.nip05 = published.nip05;
  if (published.lud16 && published.lud16 !== config.lud16) next.lud16 = published.lud16;
  if (published.website && published.website !== config.website) next.website = published.website;
  const name = opts.adoptName && published.displayName && published.displayName !== config.displayName
    ? published.displayName
    : undefined;
  return name ? { config: next, name } : { config: next };
}

/**
 * Name-only rename of a kind-0: for a profile Signet does NOT manage (never
 * enabled), a rename must not publish any card field. With a usable base (a
 * non-empty plain object) it sets `display_name`, sets `name` only when the
 * base has no non-empty `name` (a handle is never overwritten), and keeps
 * every other key and the tags verbatim. With no usable base (absent, not an
 * object, or an empty tombstone) it is just `{ name, display_name }` with no
 * tags. Returns `null` when the name sanitises to nothing.
 */
export function renameOnlyKindZero(
  base: { content: string; tags: string[][] } | undefined,
  newName: string,
): { content: string; tags: string[][] } | null {
  const display = sanitiseText(newName, CAP_DISPLAY_NAME).trim();
  if (!display) return null;
  const handle = sanitiseText(newName, CAP_NAME).trim();
  const obj = base ? parseObject(base.content) : null;
  if (!base || !obj || Object.keys(obj).length === 0) {
    return { content: JSON.stringify({ name: handle, display_name: display }), tags: [] };
  }
  obj.display_name = display;
  if (typeof obj.name !== 'string' || obj.name.trim() === '') obj.name = handle;
  return { content: JSON.stringify(obj), tags: base.tags.map(t => [...t]) };
}

// ─── Publish / Retract / Fetch ─────────────────────────────────────────────

export interface PublishResult {
  ok: boolean;
  eventId: string;
  relayUrl: string;
  createdAt: number;
  message?: string;
  /**
   * Exactly what was published (set on a real publish only — absent on the
   * §5.3.3 "no changes" short-circuit, where the caller's stored base and hash
   * are still the truth). The caller stores a `PublicProfileBase` from these
   * and `contentHash`, because after a three-way merge the published content
   * is NOT `buildKindZeroContent(config)` and the hash must be of what was sent.
   */
  content?: string;
  tags?: string[][];
  /** SHA-256 hex of `content`. */
  contentHash?: string;
  /** True when the content came from the three-way merge (a relay kind-0 was carried forward). */
  merged?: boolean;
}

/** What the optional lossless-publish inputs of `publishPublicProfile` carry. */
export interface PublishMergeInput {
  /** The slot's stored `publicProfileBase`. Absent => the fetched kind-0 (if usable) stands in for it. */
  storedBase?: PublicProfileBase;
  /** Extra relays to look the current kind-0 up on (the user's read relays). */
  lookupRelays?: string[];
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
  /**
   * Lossless-publish inputs. The function looks up the relay's current kind-0
   * itself (multi-relay, author-pinned, signature-verified) and three-way
   * merges onto the newer of that and the stored base — see
   * `mergeKindZeroContent`. With no stored base the fetched kind-0 serves as
   * both comparison and content base; with no usable fetched kind-0 either, it
   * is the plain card build.
   */
  merge?: PublishMergeInput,
): Promise<PublishResult> {
  if (!isValidRelayUrl(relayUrl)) {
    return { ok: false, eventId: '', relayUrl, createdAt: 0, message: 'no relay configured' };
  }
  const now = Math.floor(Date.now() / 1000);
  let created_at = Math.max(now, (state?.lastPublishedAt ?? 0) + 1);

  let content: string;
  let tags: string[][] = [];
  let merged = false;
  const storedBase = merge?.storedBase;
  // Look the relay's CURRENT kind-0 up (best-effort; unreachable or nothing
  // found both read as "no fetched profile").
  let fetchedEvent: { content: string; tags: string[][]; created_at: number } | null = null;
  try {
    const fetched = await fetchExistingProfile(
      backend.activePublicKeyHex,
      [relayUrl, ...(merge?.lookupRelays ?? [])],
    );
    if (fetched && fetched !== 'unreachable') fetchedEvent = fetched.event;
  } catch { /* publish from what we have */ }

  // Comparison base = the stored base; with none, the fetched kind-0 stands in
  // (so fields where the card equals the relay keep their raw value, and the
  // card wins only where it differs). Content base = the NEWER (by created_at,
  // tie: stored) of the fetched kind-0 and the stored base. With neither usable
  // the result is today's plain build.
  let comparison: string | undefined;
  let contentBase: { content: string; tags: string[][] } | undefined;
  let baseCreatedAt = 0;
  if (storedBase) {
    comparison = storedBase.content;
    contentBase = { content: storedBase.content, tags: storedBase.tags };
    baseCreatedAt = storedBase.createdAt;
    if (fetchedEvent && fetchedEvent.created_at > storedBase.createdAt) {
      contentBase = { content: fetchedEvent.content, tags: fetchedEvent.tags };
      baseCreatedAt = fetchedEvent.created_at;
    }
  } else if (fetchedEvent) {
    comparison = fetchedEvent.content;
    contentBase = { content: fetchedEvent.content, tags: fetchedEvent.tags };
    baseCreatedAt = fetchedEvent.created_at;
  }
  const result = mergeKindZeroContent({ comparisonContent: comparison, contentBase, config, fallbackDisplayName });
  content = result.content;
  tags = result.tags;
  merged = result.merged;
  // A replaceable event only replaces an OLDER one: stay strictly newer than
  // whatever we merged onto, even if its author's clock ran ahead of ours.
  if (contentBase) created_at = Math.max(created_at, baseCreatedAt + 1);
  const contentHash = bytesToHex(sha256(new TextEncoder().encode(content)));

  // §5.3.3 short-circuit. Hash the canonical content string; if it matches
  // the caller's last-published hash, skip the relay round-trip. We still
  // return ok=true so the caller doesn't re-prompt the user to retry, but
  // we don't overwrite eventId/lastPublishedAt (those carry the prior
  // published state). The message is the surfaced "no changes" copy.
  if (lastPublishedContentHash && state?.lastEventId && state?.lastPublishedAt) {
    if (contentHash === lastPublishedContentHash) {
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
    tags,
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
    return { ok: true, eventId: signed.id, relayUrl, createdAt: created_at, content, tags, contentHash, merged };
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
