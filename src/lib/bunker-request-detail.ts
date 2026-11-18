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
import { connectMetadataParam, extractAppOrigin, sanitiseAppLabel } from './app-bunker-routing';
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
/** Cap on the raw metadata blob read from a `connect` (same as ConnectedClient parsing). */
const MAX_METADATA_JSON_LEN = 4096;
/** At most this many raw characters are examined for a preview, however large the payload. */
const PREVIEW_SCAN_CHARS = 1024;

/** Collapse every run of whitespace (line breaks, tabs) to one space. */
function flatten(raw: string): string {
  return raw.replace(/\s+/g, ' ');
}

/** One sanitised line, cut to `max` code points. Never contains a line break. */
export function oneLine(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return sanitizeDisplayName(flatten(raw.slice(0, Math.max(max * 4, PREVIEW_SCAN_CHARS))), max);
}

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

/** A name an app gives itself, cut for the one-line card. */
export function declaredNameForDisplay(name: string): string {
  const flat = oneLine(name, 100);
  return flat.length > DECLARED_NAME_DISPLAY_CHARS ? `${flat.slice(0, DECLARED_NAME_DISPLAY_CHARS)}…` : flat;
}

/** The sentence a card or modal adds when a declared name matches an app paired under another key. */
export function lookalikeNote(pairedName: string): string {
  return `Not the ${declaredNameForDisplay(pairedName)} paired on this phone: different app key.`;
}

/**
 * The name of a paired app (a ConnectedClient row under a DIFFERENT client
 * key) that equals the name an unpaired client calls itself, trimmed and
 * case-insensitive. Display only: the declared name is unauthenticated, so a
 * match is a warning about a look-alike, never a link to the paired app.
 */
export function pairedLookalike(
  declaredName: string | undefined,
  clientPubkey: string,
  clients: readonly { clientPubkey: string; appName: string }[] | undefined,
): string | undefined {
  const wanted = declaredName?.trim().toLowerCase();
  if (!wanted || !clients) return undefined;
  const me = clientPubkey.toLowerCase();
  const hit = clients.find(c => c.clientPubkey.toLowerCase() !== me && c.appName.trim().toLowerCase() === wanted);
  return hit?.appName;
}

/** What an app said about itself in a `connect`. Unauthenticated. */
export interface DeclaredApp {
  name?: string;
  url?: string;
}

/**
 * Read the name and url from a `connect`'s metadata blob with the same parser
 * and limits as a saved ConnectedClient: name sanitised and at most 100
 * characters, url an https origin (or localhost http) of at most 200.
 */
export function parseDeclaredApp(params: readonly unknown[]): DeclaredApp {
  const blob = connectMetadataParam(params);
  if (!blob || blob.length > MAX_METADATA_JSON_LEN) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(blob); } catch { return {}; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const m = parsed as Record<string, unknown>;
  const name = sanitiseAppLabel(m.name, '');
  const url = extractAppOrigin(m.url);
  return { ...(name ? { name } : {}), ...(url ? { url } : {}) };
}
