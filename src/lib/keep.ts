/**
 * Pure parsing and verification for the My Keep screen: no relay, no React.
 *
 * Trust rules (see the Bothy claim-hijack finding): a claim counts only if
 * its event is authored by a key this user owns. Anyone can publish a claim
 * that names you in a `p` tag, so claims are never found through `#p` and a
 * stranger-authored claim is dropped even if a relay hands one over. A
 * status counts only if the node it names signed it, and only if it points
 * back at the exact claim event we accepted.
 */
import { verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'signet-protocol';
import { sanitizeDisplayName } from './text-sanitize';
import { KEEP_CLAIM_KIND, KEEP_FUTURE_SKEW_S, KEEP_ONLINE_WINDOW_S, KEEP_STATUS_KIND } from './keep-wire';

export type KeepRole = 'box' | 'phone';

export interface KeepClaim {
  /** Node key (the claim's `d`), 64 lowercase hex. */
  node: string;
  /** The claim event id, which a status must name in its `claim` tag. */
  eventId: string;
  /** Which of the user's own keys signed it. */
  author: string;
  createdAt: number;
  role: KeepRole;
  region?: string;
  name?: string;
}

export interface KeepStatus {
  createdAt: number;
  /** Free space in bytes, when the card carries a valid `free` tag. */
  freeBytes?: number;
  /** `<name>/<version>` as published, when present. */
  software?: string;
}

export interface Keep {
  claim: KeepClaim;
  /** The newest status that passed every check, or null. */
  status: KeepStatus | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const NAME_MAX_BYTES = 32;
const REGION_MAX_BYTES = 64;
const SOFTWARE_MAX_BYTES = 64;

/** Strip control/bidi characters, then cut to at most `maxBytes` UTF-8 bytes (whole characters only). */
function cleanText(raw: string | undefined, maxBytes: number): string | undefined {
  if (raw === undefined) return undefined;
  let out = '';
  let bytes = 0;
  for (const ch of sanitizeDisplayName(raw, maxBytes)) {
    const n = new TextEncoder().encode(ch).length;
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out || undefined;
}

function tagValues(event: NostrEvent, name: string): string[][] {
  return event.tags.filter(t => Array.isArray(t) && t[0] === name);
}

function singleValue(event: NostrEvent, name: string): string | undefined {
  const tags = tagValues(event, name);
  return tags.length === 1 && typeof tags[0][1] === 'string' ? tags[0][1] : undefined;
}

function validSignature(event: NostrEvent): boolean {
  try {
    return verifyEvent({
      id: event.id, pubkey: event.pubkey, kind: event.kind,
      created_at: event.created_at, tags: event.tags, content: event.content, sig: event.sig,
    });
  } catch {
    return false;
  }
}

function newer(a: { created_at: number; id: string }, b: { created_at: number; id: string }): boolean {
  // NIP-01 tie-break: the lowest id wins at equal timestamps.
  return a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);
}

/** Parse one claim event; null when it fails the checks. Does not check ownership. */
function parseClaim(event: NostrEvent): (KeepClaim & { active: boolean }) | null {
  if (event.kind !== KEEP_CLAIM_KIND) return null;
  if (!HEX64.test(event.pubkey)) return null;
  const node = singleValue(event, 'd');
  if (!node || !HEX64.test(node)) return null;
  const ps = tagValues(event, 'p');
  const withRole = (role: string) => ps.filter(t => t[3] === role);
  const nodeKeys = withRole('node');
  const masterKeys = withRole('master');
  // The same shape rules Bothy applies: one node key equal to `d`, one master key equal to the signer.
  if (nodeKeys.length !== 1 || nodeKeys[0][1] !== node) return null;
  if (masterKeys.length !== 1 || masterKeys[0][1] !== event.pubkey) return null;
  const role = singleValue(event, 'role');
  if (role !== 'box' && role !== 'phone') return null;
  const status = singleValue(event, 'status');
  if (status !== 'active' && status !== 'retired') return null;
  const name = cleanText(singleValue(event, 'name'), NAME_MAX_BYTES);
  const region = cleanText(singleValue(event, 'region'), REGION_MAX_BYTES);
  return {
    node, eventId: event.id, author: event.pubkey, createdAt: event.created_at, role,
    region, name, active: status === 'active',
  };
}

/**
 * Active Keep claims among `events`, newest per node. A newer retired claim
 * hides an older active one, so retirement is decided before filtering.
 * Events that are forged, authored by anyone but `owned`, or malformed are
 * ignored.
 */
export function pickActiveClaims(events: NostrEvent[], owned: readonly string[]): KeepClaim[] {
  const ownedSet = new Set(owned.map(k => k.toLowerCase()));
  const latest = new Map<string, { event: NostrEvent; claim: KeepClaim & { active: boolean } }>();
  for (const event of events) {
    if (!ownedSet.has(event.pubkey)) continue;
    const claim = parseClaim(event);
    if (!claim || !validSignature(event)) continue;
    const held = latest.get(claim.node);
    if (!held || newer(event, held.event)) latest.set(claim.node, { event, claim });
  }
  return [...latest.values()]
    .filter(h => h.claim.active)
    .map(({ claim: { active: _active, ...claim } }) => claim)
    .sort((a, b) => b.createdAt - a.createdAt || (a.node < b.node ? -1 : 1));
}

/**
 * The newest status for `claim` that verifies, is signed by the node, and names
 * this claim. A status dated more than five minutes after `nowSeconds` is
 * dropped (Bothy V2 rule 10): otherwise a skewed clock would pin "Online".
 */
export function pickStatus(events: NostrEvent[], claim: KeepClaim, nowSeconds: number): KeepStatus | null {
  let best: NostrEvent | null = null;
  for (const event of events) {
    if (event.kind !== KEEP_STATUS_KIND) continue;
    if (event.pubkey !== claim.node) continue;
    if (event.created_at > nowSeconds + KEEP_FUTURE_SKEW_S) continue;
    if (singleValue(event, 'claim') !== claim.eventId) continue;
    if (best && !newer(event, best)) continue;
    if (!validSignature(event)) continue;
    best = event;
  }
  if (!best) return null;
  const free = singleValue(best, 'free');
  const software = tagValues(best, 'software');
  const softwareName = software.length === 1 && typeof software[0][1] === 'string'
    ? cleanText(software[0][1], SOFTWARE_MAX_BYTES) : undefined;
  return {
    createdAt: best.created_at,
    freeBytes: free !== undefined && /^\d{1,15}$/.test(free) ? Number(free) : undefined,
    software: softwareName,
  };
}

export type KeepPresence =
  | { state: 'online' }
  | { state: 'last-seen'; ageSeconds: number }
  | { state: 'unseen' };

/** Online under ten minutes old; otherwise last seen; "unseen" with no valid status. */
export function presenceOf(status: KeepStatus | null, nowSeconds: number): KeepPresence {
  if (!status) return { state: 'unseen' };
  const age = Math.max(0, nowSeconds - status.createdAt);
  return age < KEEP_ONLINE_WINDOW_S ? { state: 'online' } : { state: 'last-seen', ageSeconds: age };
}

export function relativeAge(ageSeconds: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (ageSeconds < 3600) return plural(Math.max(1, Math.floor(ageSeconds / 60)), 'minute');
  if (ageSeconds < 86400) return plural(Math.floor(ageSeconds / 3600), 'hour');
  return plural(Math.floor(ageSeconds / 86400), 'day');
}

export function presenceLabel(p: KeepPresence): string {
  if (p.state === 'online') return 'Online';
  if (p.state === 'unseen') return 'Not seen yet';
  return `Last seen ${relativeAge(p.ageSeconds)}`;
}

export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  const text = i === 0 || value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
  return `${text} ${units[i]}`;
}

export function roleLabel(role: KeepRole): string {
  return role === 'box' ? 'Home device' : 'Phone';
}

/** Name shown for a Keep: local nickname, else the claim's public name, else a default. */
export function displayName(claim: KeepClaim, nickname?: string): string {
  return nickname?.trim() || claim.name || 'Your Keep';
}
