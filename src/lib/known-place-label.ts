import type { KnownPlace } from '../types/known-places';
import { colourFromPubkey } from './avatar';

/** `example.com` for `https://www.example.com/x`, or the raw text when it is not a URL. */
export function hostnameOf(raw: string | undefined): string {
  if (!raw) return '';
  try { return new URL(raw).hostname.replace(/^www\./, ''); } catch { return raw; }
}

/** What a place is called: the person's alias, else the name it gave, else its host. */
export function placeLabel(place: KnownPlace): string {
  return place.alias || place.name || hostnameOf(place.origin) || place.nativePackage || 'Unknown';
}

/** Pinned first, then most recently used. */
export function sortPlaces(places: readonly KnownPlace[]): KnownPlace[] {
  return [...places].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.lastAt - a.lastAt);
}

/** A stable tint per place, so letter tiles tell places apart the way avatars do. */
export function placeTint(place: KnownPlace): string {
  const text = place.placeKey;
  let h = 7;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return colourFromPubkey(h.toString(16).padStart(8, '0'));
}

/** "just now", "3 hours ago", "2 days ago", "4 months ago". `now` and `at` in unix seconds. */
export function relativeTime(at: number, now: number): string {
  const ago = Math.max(0, now - at);
  if (ago < 60) return 'just now';
  if (ago < 3600) { const m = Math.floor(ago / 60); return `${m} minute${m === 1 ? '' : 's'} ago`; }
  if (ago < 86400) { const h = Math.floor(ago / 3600); return `${h} hour${h === 1 ? '' : 's'} ago`; }
  if (ago < 60 * 86400) { const d = Math.floor(ago / 86400); return `${d} day${d === 1 ? '' : 's'} ago`; }
  if (ago < 365 * 86400) { const mo = Math.floor(ago / (30 * 86400)); return `${mo} month${mo === 1 ? '' : 's'} ago`; }
  const y = Math.floor(ago / (365 * 86400));
  return `${y} year${y === 1 ? '' : 's'} ago`;
}
