// NIP-46 request events this install has already answered, shared between
// pages. On Android a page parked after the app was swiped away keeps
// serving (MainActivity); when a newer page unlocks it takes over and looks
// back over the last few minutes, so it must skip what the parked page
// already answered — and still pick up what that page could only queue
// (an approval nobody could see). Same origin ⇒ same localStorage.
//
// Only event ids and times are kept: routing metadata, no request content.

const STORAGE_KEY = 'signet:bunker-answered:v1';
const TTL_MS = 10 * 60_000;
const CAP = 1000;

type Entry = [eventId: string, answeredAt: number];

function read(storage: Storage, now: number): Entry[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is Entry =>
      Array.isArray(e) && typeof e[0] === 'string' && /^[0-9a-f]{64}$/.test(e[0])
      && typeof e[1] === 'number' && now - e[1] < TTL_MS);
  } catch {
    return [];
  }
}

export function markAnswered(eventId: string, storage: Storage = localStorage, now = Date.now()): void {
  if (!/^[0-9a-f]{64}$/.test(eventId)) return;
  try {
    const entries = read(storage, now).filter(e => e[0] !== eventId);
    entries.push([eventId, now]);
    storage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-CAP)));
  } catch {
    // storage unavailable: worst case a request is answered twice
  }
}

export function wasAnswered(eventId: string, storage: Storage = localStorage, now = Date.now()): boolean {
  return read(storage, now).some(e => e[0] === eventId);
}
