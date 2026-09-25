import { verifyEvent as nostrVerifyEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'signet-protocol';

/**
 * Filter an array of relay-returned events to those with valid signatures
 * AND (optionally) matching the expected author pubkey. The `authors:`
 * filter on relays is server-applied and untrusted — a hostile relay can
 * return events with arbitrary `event.pubkey`, so callers that fetched
 * by author must double-check after `verifyEvent`.
 *
 * Use this at every site that consumes relay events as authentic — the
 * default in the codebase WAS to skip verification, which exposed multiple
 * trust-display surfaces (badges, verifier profiles, roster membership)
 * to relay-forged events. See 2026-05-18 security audit pass 3.
 */
export function verifiedAuthoredEvents<T extends { pubkey: string; sig: string; id: string }>(
  events: T[],
  expectedAuthor?: string,
): T[] {
  const out: T[] = [];
  const lcAuthor = expectedAuthor?.toLowerCase();
  for (const ev of events) {
    if (lcAuthor && ev.pubkey.toLowerCase() !== lcAuthor) continue;
    if (!nostrVerifyEvent(ev as unknown as NostrEvent)) continue;
    out.push(ev);
  }
  return out;
}

/** Single-event variant for paths that fetch one event. Returns null if
 *  signature invalid or pubkey doesn't match. */
export function verifiedAuthoredEvent<T extends { pubkey: string; sig: string; id: string }>(
  event: T | null | undefined,
  expectedAuthor?: string,
): T | null {
  if (!event) return null;
  const filtered = verifiedAuthoredEvents([event], expectedAuthor);
  return filtered[0] ?? null;
}
