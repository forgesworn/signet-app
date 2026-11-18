/**
 * Pure helpers for the detail a pending Bunker request shows (card + modal).
 *
 * EVERY string reaching these helpers from an app (name, url, d tag, tags,
 * content, encrypt plaintext) is hostile: a NIP-46 client chooses all of it.
 * Everything here strips control and bidi characters through the shared
 * `sanitizeDisplayName`, keeps line breaks out of one-line fields, and cuts to
 * a fixed length. Callers render the results as React text only.
 */
import { sanitizeDisplayName } from './text-sanitize';
import { connectMetadataParam, parseConnectMetadata } from './app-bunker-routing';
import { looksLikeNip44V2 } from './vault-envelope';
import { describeEventTemplate } from './nip46-server';
import type { UnsignedEvent } from 'signet-protocol';

/** A request older than this has probably been given up on by the app. */
export const LATE_AFTER_MS = 5 * 60 * 1000;
/** Characters of app-supplied text shown as a preview. */
export const PREVIEW_MAX_CHARS = 280;
/** The `d` tag value is cut to this many characters. */
export const D_TAG_MAX_CHARS = 80;
/** A name an app gives itself is cut to about this many characters on a card. */
export const DECLARED_NAME_DISPLAY_CHARS = 40;
/** At most this many raw characters are examined for a preview, however large the payload. */
const PREVIEW_SCAN_CHARS = 1024;

/** Collapse every run of whitespace (line breaks, tabs) to one space. */
function flatten(raw: string): string {
  return raw.replace(/\s+/g, ' ');
}

/** The first `n` code points of `s`, without scanning the rest and never splitting a surrogate pair. */
function takeCodePoints(s: string, n: number): string {
  let out = '';
  let taken = 0;
  for (const ch of s) {
    if (taken++ >= n) break;
    out += ch;
  }
  return out;
}

/** One sanitised line, cut to `max` code points. Never contains a line break. */
export function oneLine(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return sanitizeDisplayName(flatten(takeCodePoints(raw, Math.max(max * 4, PREVIEW_SCAN_CHARS))), max);
}

/**
 * Characters that draw nothing: the Unicode Default_Ignorable set (soft
 * hyphen, word joiner, zero-width and bidi marks, variation selectors, Hangul
 * fillers, tag characters...). `sanitizeDisplayName` strips only part of this
 * class, so an app could otherwise put one inside a name and keep it from
 * matching a paired app's name while it still LOOKS identical.
 */
const INVISIBLE = new RegExp(
  '[\\p{Default_Ignorable_Code_Point}\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f'
  + '\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0'
  + '\\u{1bca0}-\\u{1bca3}\\u{e0000}-\\u{e0fff}]',
  'gu',
);

/** `s` without any invisible character. */
export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE, '');
}

/**
 * A name as compared against another: NFKC, invisible characters gone,
 * whitespace collapsed, trimmed, lowercase. Look-alike scripts (a Cyrillic
 * letter for a Latin one) are NOT folded: that needs a confusables table.
 */
export function normaliseName(raw: string): string {
  return stripInvisible(stripInvisible(raw).normalize('NFKC')).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Quotation marks, which would let a declared name end its own quoted span. */
const QUOTES = /["\u201c\u201d\u201e\u201f\u2033\u3003\uff02]/g;

/** True once a request has waited longer than `LATE_AFTER_MS`. */
export function isLate(askedAt: number | undefined, now: number): boolean {
  return typeof askedAt === 'number' && now - askedAt > LATE_AFTER_MS;
}

/** "just now", "2 min ago", "1 h ago", "3 d ago". */
export function ageText(askedAt: number | undefined, now: number): string {
  if (typeof askedAt !== 'number') return '';
  const s = Math.max(0, Math.floor((now - askedAt) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** The note a late request carries. */
export function lateNote(askedAt: number, now: number): string {
  return `Asked ${ageText(askedAt, now)}. The app has probably stopped waiting.`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => String(n).padStart(2, '0');

/** Local absolute time: "Today 14:02:31", or "18 Nov, 14:02:31" when it isn't today. */
export function absoluteTimeText(askedAt: number, now: number): string {
  const d = new Date(askedAt);
  const n = new Date(now);
  const clock = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? `Today ${clock}` : `${d.getDate()} ${MONTHS[d.getMonth()]}, ${clock}`;
}

/** Local date a pairing was made: "18 Nov 2026". */
export function pairedDateText(connectedAtSeconds: number): string {
  const d = new Date(connectedAtSeconds * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** The `d` tag value of a template, sanitised and cut to 80 characters, or undefined. */
export function dTagOf(tags: unknown): string | undefined {
  if (!Array.isArray(tags)) return undefined;
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === 'd' && typeof tag[1] === 'string') {
      const value = oneLine(tag[1], D_TAG_MAX_CHARS);
      return value || undefined;
    }
  }
  return undefined;
}

/** "3: d, p ×2" — the count and the names (each name once, with a count when repeated). */
export function tagSummary(tags: unknown): string {
  if (!Array.isArray(tags) || tags.length === 0) return 'None';
  const counts = new Map<string, number>();
  for (const tag of tags) {
    const name = Array.isArray(tag) && typeof tag[0] === 'string' ? oneLine(tag[0], 16) || '?' : '?';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const MAX_NAMES = 8;
  const names = [...counts.entries()].slice(0, MAX_NAMES).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
  const more = counts.size > MAX_NAMES ? ', …' : '';
  return `${tags.length}: ${names.join(', ')}${more}`;
}

const NIP04_SHAPE = /^[A-Za-z0-9+/]+={0,2}\?iv=[A-Za-z0-9+/]+={0,2}$/;

/** Does this look like ciphertext (NIP-44 v2, or NIP-04's `?iv=` form)? A guess for display only. */
export function looksEncrypted(content: string): boolean {
  if (typeof content !== 'string') return false;
  return looksLikeNip44V2(content) || (content.length < 200_000 && NIP04_SHAPE.test(content));
}

export interface TextPreview {
  /** Sanitised, one line, at most `max` characters. */
  text: string;
  /** Length of the original, in characters. */
  total: number;
  /** True when the original is longer than what `text` shows. */
  cut: boolean;
}

/** The first `max` characters of app-supplied text, sanitised. */
export function previewOf(raw: string, max = PREVIEW_MAX_CHARS): TextPreview {
  const total = typeof raw === 'string' ? raw.length : 0;
  return { text: oneLine(raw, max), total, cut: total > max };
}

export type ContentSummary =
  | { kind: 'empty' }
  | { kind: 'encrypted'; length: number }
  | { kind: 'text'; preview: TextPreview };

/** What a sign request's `content` is, for the detail rows. */
export function summariseContent(content: string): ContentSummary {
  if (typeof content !== 'string' || content.length === 0) return { kind: 'empty' };
  if (looksEncrypted(content)) return { kind: 'encrypted', length: content.length };
  return { kind: 'text', preview: previewOf(content) };
}

/** "Sign · kind 1 (note)" / "Sign · kind 31337". */
export function signRequestLabel(template: UnsignedEvent): string {
  const described = describeEventTemplate(template);
  const label = /^(.+) \(kind \d+\)$/.exec(described)?.[1];
  return label ? `Sign · kind ${template.kind} (${label})` : `Sign · kind ${template.kind}`;
}

/** "Encrypt" / "Decrypt", plus "(older format)" for NIP-04. */
export function cryptoRequestLabel(method: string): string {
  const base = method.endsWith('decrypt') ? 'Decrypt' : 'Encrypt';
  return method.startsWith('nip04') ? `${base} (older format)` : base;
}

/** The site's hostname from an app's URL, as plain text (never a link), or undefined. */
export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const host = oneLine(new URL(url).hostname, 100);
    return host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A name an app gives itself, cut for the one-line card: invisible characters
 * gone, and any double quote turned into an apostrophe so the name can never
 * close the quotes the card puts around it.
 */
export function declaredNameForDisplay(name: string): string {
  const flat = oneLine(stripInvisible(name), 100).replace(QUOTES, "'");
  const points = Array.from(flat);
  return points.length > DECLARED_NAME_DISPLAY_CHARS ? `${points.slice(0, DECLARED_NAME_DISPLAY_CHARS).join('')}…` : flat;
}

/** The sentence a card or modal adds when a declared name matches an app paired under another key. */
export function lookalikeNote(pairedName: string): string {
  return `Not the ${declaredNameForDisplay(pairedName)} paired on this phone: different app key.`;
}

/** The origin of a URL, lowercase, or undefined when it does not parse. */
function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).origin.toLowerCase(); } catch { return undefined; }
}

/**
 * The name of a paired app (a ConnectedClient row under a DIFFERENT client
 * key) that an unpaired client looks like: the name it calls itself equals the
 * row's name once both are normalised (see `normaliseName`), or the site it
 * names has the same origin as the row's. Display only: both are
 * unauthenticated, so a match is a warning about a look-alike, never a link to
 * the paired app.
 */
export function pairedLookalike(
  declared: { name?: string; url?: string },
  clientPubkey: string,
  clients: readonly { clientPubkey: string; appName: string; appUrl?: string }[] | undefined,
): string | undefined {
  if (!clients) return undefined;
  const wantedName = declared.name ? normaliseName(declared.name) : '';
  const wantedOrigin = originOf(declared.url);
  if (!wantedName && !wantedOrigin) return undefined;
  const me = clientPubkey.toLowerCase();
  const hit = clients.find(c => c.clientPubkey.toLowerCase() !== me
    && ((wantedName !== '' && normaliseName(c.appName) === wantedName)
      || (wantedOrigin !== undefined && originOf(c.appUrl) === wantedOrigin)));
  return hit?.appName;
}

/** What an app said about itself in a `connect`. Unauthenticated. */
export interface DeclaredApp {
  name?: string;
  url?: string;
}

/**
 * What a `connect` says about the app, read with the same parser and limits as
 * a saved ConnectedClient (name sanitised, at most 100 characters; url an
 * https origin, or localhost http, of at most 200) but with no default name,
 * and with invisible characters taken out of the name.
 */
export function declaredAppOf(params: readonly unknown[]): DeclaredApp {
  const { label, origin } = parseConnectMetadata(connectMetadataParam(params), '');
  const name = stripInvisible(label).trim();
  return { ...(name ? { name } : {}), ...(origin ? { url: origin } : {}) };
}
