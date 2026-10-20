/**
 * Local nicknames for Keeps, one localStorage entry per identity and node.
 * Device-local only: never published, never synced. They are removed with the
 * account (`clearKeepNicknames`, called from `purgeAllUserData`). A failing
 * storage (private window, blocked site data) just means no nicknames.
 */
export const KEEP_NICKNAME_PREFIX = 'signet:keep-nickname:';
export const NICKNAME_MAX = 32;

const headFor = (scope: string) => `${KEEP_NICKNAME_PREFIX}${encodeURIComponent(scope)}:`;
const keyFor = (scope: string, node: string) => `${headFor(scope)}${node}`;

/** Nicknames saved under `scope` (the identity id), keyed by node key. */
export function loadNicknames(scope: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const head = headFor(scope);
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(head)) continue;
      const v = localStorage.getItem(k);
      if (v && v.trim()) out[k.slice(head.length)] = v;
    }
  } catch { /* storage unavailable: no nicknames */ }
  return out;
}

/** Save (or, with an empty name, clear) a nickname; returns the updated map for `scope`. */
export function setNickname(scope: string, node: string, nickname: string): Record<string, string> {
  const clean = nickname.trim().slice(0, NICKNAME_MAX);
  const all = loadNicknames(scope);
  try {
    if (clean) localStorage.setItem(keyFor(scope, node), clean); else localStorage.removeItem(keyFor(scope, node));
  } catch { /* storage unavailable: the nickname lasts this session only */ }
  if (clean) all[node] = clean; else delete all[node];
  return all;
}

/** Remove every saved Keep nickname, for every identity. Never throws. */
export function clearKeepNicknames(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(KEEP_NICKNAME_PREFIX)) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch { /* storage unavailable: nothing to clear */ }
}
