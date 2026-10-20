/**
 * Local nicknames for Keeps, keyed by node key. Stored in localStorage on
 * this device only; never published and never synced. A failing storage
 * (private window, blocked site data) just means no nicknames.
 */
const KEY = 'signet-keep-nicknames';
export const NICKNAME_MAX = 32;

export function loadNicknames(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string' && v.trim()) out[k] = v;
    return out;
  } catch { return {}; }
}

/** Save (or, with an empty name, clear) a nickname; returns the updated map. */
export function setNickname(node: string, nickname: string): Record<string, string> {
  const all = loadNicknames();
  const clean = nickname.trim().slice(0, NICKNAME_MAX);
  if (clean) all[node] = clean; else delete all[node];
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage unavailable: nickname lasts this session only */ }
  return all;
}
