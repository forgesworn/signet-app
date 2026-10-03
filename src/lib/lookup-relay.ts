/**
 * One-shot relay read for the Nostr lookups (profile, follow list, names).
 *
 * Why not `RelayClient` from `signet-protocol`: its message handler silently
 * drops any event with more than 100 tags, and a real kind-3 follow list
 * routinely carries hundreds of `p` tags. The lookups would then report "no
 * follow list found" for a list the relay served perfectly well. This is a
 * small raw-WebSocket reader with its own, larger bounds.
 *
 * It does NOT verify signatures: callers pin the author and verify the winner
 * (`gatherAuthoredEvents` / `pickNewestVerified`), so a signature is only
 * checked on events that could actually win.
 */

import type { NostrEvent, NostrFilter } from 'signet-protocol';

/** Largest relay message (characters) we will even parse. */
const MAX_MESSAGE_CHARS = 1_048_576;
const MAX_CONTENT_CHARS = 65_536;
const MAX_TAG_VALUE_CHARS = 1024;
/** Same cap as `MAX_FOLLOW_TAGS` in nostr-follows.ts (kept local to avoid an import cycle). */
const MAX_TAGS = 5000;
const MAX_EVENTS = 10_000;

function randomSubId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Shape-check a relay-supplied event object within our size bounds. */
function toBoundedEvent(obj: unknown): NostrEvent | null {
  if (typeof obj !== 'object' || obj === null) return null;
  const e = obj as Record<string, unknown>;
  if (typeof e.id !== 'string' || typeof e.pubkey !== 'string' || typeof e.content !== 'string' || typeof e.sig !== 'string') return null;
  if (typeof e.kind !== 'number' || typeof e.created_at !== 'number') return null;
  if (e.content.length > MAX_CONTENT_CHARS) return null;
  const tags = e.tags;
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) return null;
  for (const tag of tags) {
    if (!Array.isArray(tag)) return null;
    for (const v of tag) {
      if (typeof v !== 'string' || v.length > MAX_TAG_VALUE_CHARS) return null;
    }
  }
  return e as unknown as NostrEvent;
}

/**
 * Read `filters` from one relay. Resolves with the collected events on EOSE or
 * CLOSED (possibly `[]`: the relay answered and had nothing). Resolves `null`
 * when the relay could not be reached: a connection error, or no EOSE/CLOSED
 * before `timeoutMs`. A timeout after the socket opened also gives `null`, not
 * the partial set, so a slow relay is never mistaken for an empty one.
 */
export function fetchFromRelay(url: string, filters: NostrFilter[], timeoutMs: number): Promise<NostrEvent[] | null> {
  return new Promise<NostrEvent[] | null>((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      resolve(null);
      return;
    }
    const subId = randomSubId();
    const events: NostrEvent[] = [];
    const seen = new Set<string>();
    let opened = false;
    let done = false;

    const finish = (result: NostrEvent[] | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (opened) {
        try { ws.send(JSON.stringify(['CLOSE', subId])); } catch { /* socket already gone */ }
      }
      try { ws.close(); } catch { /* already closed */ }
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    ws.onopen = () => {
      opened = true;
      try {
        ws.send(JSON.stringify(['REQ', subId, ...filters]));
      } catch {
        finish(null);
      }
    };
    ws.onerror = () => finish(null);
    ws.onclose = () => finish(null);
    ws.onmessage = (msg: MessageEvent) => {
      if (done || typeof msg.data !== 'string' || msg.data.length > MAX_MESSAGE_CHARS) return;
      let parsed: unknown;
      try { parsed = JSON.parse(msg.data); } catch { return; }
      if (!Array.isArray(parsed) || parsed[1] !== subId) return;
      if (parsed[0] === 'EOSE' || parsed[0] === 'CLOSED') {
        finish(events);
        return;
      }
      if (parsed[0] !== 'EVENT') return;
      const ev = toBoundedEvent(parsed[2]);
      if (!ev || seen.has(ev.id)) return;
      seen.add(ev.id);
      events.push(ev);
      if (events.length >= MAX_EVENTS) finish(events);
    };
  });
}
