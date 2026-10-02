// NIP-46 request events this install has already answered, kept across
// page loads. On Android a page that unlocks looks back over the last few
// minutes, to answer what arrived while nothing was serving (locked, swiped
// away, rebooted — the "isn't signing" notification brought the user back);
// it must skip what an earlier page already answered.
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
