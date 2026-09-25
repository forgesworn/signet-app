/**
 * Profile-based restore helper (Stage 1).
 *
 * When the user enters a mnemonic on a new device, probe the relay for
 * kind-0 profile events under the derived pubkeys (natural-person,
 * persona, and persona-1..persona-N). Each kind-0 gives us a display
 * name (and a hint that the pubkey is "real"), so restore can skip the
 * name-choice / name-entry steps that currently make the flow look
 * indistinguishable from fresh setup.
 *
 * Stage 2 (cross-device sync of dependants, connected sites, etc.) is
 * tracked separately.
 */

import { fetchEvents } from './relay-service';
import { derivePubkeysFromMnemonic, deriveExtraPersonaPubkey } from './signet';
import { sanitizeDisplayName } from './text-sanitize';
import { verifyEvent } from 'nostr-tools/pure';
import type { Event as NTEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'signet-protocol';

/** How many extra-persona derivations to probe. */
const MAX_EXTRA_PERSONAS = 10;

/** Timeout for the relay fetch in ms. Kept tight so users don't wait. */
const FETCH_TIMEOUT_MS = 6000;

/** Shape of what we keep from a kind-0 event's content JSON. */
interface Kind0Content {
  name?: string;
  display_name?: string;
  picture?: string;
}

export interface RestoredPersonaProfile {
  publicKey: string;
  displayName: string;
}

export interface RestoredExtraPersonaProfile {
  derivationName: string;
  publicKey: string;
  displayName: string;
}

export interface RestoredProfile {
  /** Natural-person keypair profile, if a kind-0 was found for its pubkey. */
  naturalPerson: RestoredPersonaProfile | null;
  /** Built-in persona keypair profile, if a kind-0 was found for its pubkey. */
  persona: RestoredPersonaProfile | null;
  /** Extra personas discovered via persona-1..persona-N probing. */
  extras: RestoredExtraPersonaProfile[];
  /** Best-guess primary keypair based on which pubkeys had profiles. */
  primaryKeypair: 'natural-person' | 'persona';
  /**
   * Phase C.2: per-pubkey kind-0 publication-state markers, surfaced so
   * `restoreWithProfile` can seed `publicProfile` on the restored identity.
   * Keyed by lowercase pubkey hex. `event.id` is the kind-0 event ID, used
   * as `publicProfile.lastEventId`; `event.created_at` becomes
   * `publicProfile.lastPublishedAt`; `event.content` is the raw JSON
   * `restoreWithProfile` parses via `parseKindZeroContent` to extract
   * the full NIP-01 fields (picture, banner, about, nip05, lud16,
   * website) rather than just `displayName`.
   */
  kind0Events?: Map<string, { id: string; created_at: number; content: string }>;
}

/** Sanitise a display name from untrusted kind-0 content. */
function sanitiseName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = sanitizeDisplayName(raw, 100);
  return cleaned.length > 0 ? cleaned : null;
}

/** Parse a kind-0 event's content. Returns null for malformed input. */
function parseKind0(event: NostrEvent): Kind0Content | null {
  if (event.kind !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  return {
    name: sanitiseName(obj.name) ?? undefined,
    display_name: sanitiseName(obj.display_name) ?? undefined,
    picture: typeof obj.picture === 'string' ? obj.picture.slice(0, 1024) : undefined,
  };
}

/** Prefer display_name → name → null. */
function pickDisplayName(content: Kind0Content): string | null {
  return content.display_name ?? content.name ?? null;
}

/** Fetch-with-timeout wrapper to keep the restore UX tight. */
async function fetchWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  return await Promise.race<T | null>([
    fn().catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

/**
 * Probe the relay for kind-0 profiles belonging to the mnemonic's derived
 * pubkeys. Returns null if the relay is unreachable or no kind-0 is found
 * for any of the derived pubkeys (in which case the caller should fall
 * back to the manual name prompt).
 */
export async function fetchRestoreProfile(mnemonic: string): Promise<RestoredProfile | null> {
  const { naturalPerson: npPub, persona: personaPub } = derivePubkeysFromMnemonic(mnemonic);

  const extraPubkeys: Array<{ derivationName: string; publicKey: string }> = [];
  for (let i = 1; i <= MAX_EXTRA_PERSONAS; i++) {
    const derivationName = `persona-${i}`;
    extraPubkeys.push({ derivationName, publicKey: deriveExtraPersonaPubkey(mnemonic, derivationName) });
  }

  const allPubkeys = [npPub, personaPub, ...extraPubkeys.map(e => e.publicKey)];

  const events = await fetchWithTimeout(
    () => fetchEvents([{ kinds: [0], authors: allPubkeys } as never]),
    FETCH_TIMEOUT_MS,
  );
  if (events === null || events.length === 0) return null;

  // Keep only the newest kind-0 per pubkey (kind-0 is replaceable).
  // Verify signature first — a malicious relay can forge events with arbitrary
  // `pubkey` and bad `sig`; without this check the forged kind-0 would seed
  // displayName/picture/lastEventId on the restored identity.
  const latestByAuthor = new Map<string, NostrEvent>();
  for (const ev of events) {
    if (!verifyEvent(ev as unknown as NTEvent)) continue;
    const prev = latestByAuthor.get(ev.pubkey);
    if (!prev || ev.created_at > prev.created_at) latestByAuthor.set(ev.pubkey, ev);
  }

  function profileFor(pubkey: string): RestoredPersonaProfile | null {
    const ev = latestByAuthor.get(pubkey);
    if (!ev) return null;
    const parsed = parseKind0(ev);
    if (!parsed) return null;
    const name = pickDisplayName(parsed);
    if (!name) return null;
    return { publicKey: pubkey, displayName: name };
  }

  const naturalPerson = profileFor(npPub);
  const persona = profileFor(personaPub);

  const extras: RestoredExtraPersonaProfile[] = [];
  for (const { derivationName, publicKey } of extraPubkeys) {
    const p = profileFor(publicKey);
    if (p) extras.push({ derivationName, publicKey, displayName: p.displayName });
  }

  if (!naturalPerson && !persona && extras.length === 0) return null;

  // Primary: whichever of NP / persona has a profile. If both, prefer NP
  // (it's the more common primary). If neither, default to NP so the
  // identity record still builds consistently.
  const primaryKeypair: 'natural-person' | 'persona' =
    naturalPerson ? 'natural-person' : persona ? 'persona' : 'natural-person';

  // Carry the raw kind-0 event metadata (id + created_at + content) for
  // every pubkey we found a kind-0 for. restoreWithProfile uses this to
  // seed `publicProfile` on the persona slot (default enabled=true) and
  // to surface "we found a kind-0 on your NP" as informational only
  // (NP toggle stays off; user enables deliberately via the §6.5
  // double-confirm later).
  const kind0Events = new Map<string, { id: string; created_at: number; content: string }>();
  for (const [pubkey, ev] of latestByAuthor) {
    kind0Events.set(pubkey.toLowerCase(), { id: ev.id, created_at: ev.created_at, content: ev.content });
  }

  return { naturalPerson, persona, extras, primaryKeypair, kind0Events };
}
