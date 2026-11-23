/**
 * The games a Keep invite link can open, in one place.
 *
 * This allowlist is the only source of schemes that become a link, reach the phone's app opener or are shown.
 * A scheme that arrives from elsewhere (a pairing link, an ack from a Keep, an incoming URL) is used only if it
 * is in this list, so a Keep can never make this app build or open a link to something else
 * (`https`, `javascript`, `intent` and the like).
 */

export interface KeepGame {
  /** The URL scheme the game's own app opens for `<scheme>://keep/<keep>/<secret>`. */
  scheme: string;
  /** What the owner sees. */
  name: string;
}

export const KEEP_GAMES: readonly KeepGame[] = [
  { scheme: 'stampede', name: 'Stampede' },
  { scheme: 'twangthang', name: 'Twang Thang' },
  { scheme: 'axenstax', name: 'AxeNStax' },
  { scheme: 'gameflock', name: 'Cluster Flock' },
];

/** Used only where a caller has no game to give, so behaviour is unchanged when nothing is chosen. */
export const DEFAULT_KEEP_GAME = 'stampede';

/** The most games a stored Keep holds. */
export const KEEP_GAMES_MAX = 16;

const SCHEME_SHAPE = /^[a-z][a-z0-9]{0,31}$/;

/** True only for a scheme in the allowlist. */
export function isKeepGame(scheme: unknown): scheme is string {
  return typeof scheme === 'string' && SCHEME_SHAPE.test(scheme) && KEEP_GAMES.some(g => g.scheme === scheme);
}

/** The display name of an allowlisted scheme; undefined for anything else. */
export function keepGameName(scheme: string): string | undefined {
  return isKeepGame(scheme) ? KEEP_GAMES.find(g => g.scheme === scheme)?.name : undefined;
}

/** Keep the allowlisted entries of an untrusted list, in order, without repeats, at most `KEEP_GAMES_MAX`. Drops the rest silently. */
export function cleanGames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (!isKeepGame(item) || out.includes(item)) continue;
    out.push(item);
    if (out.length >= KEEP_GAMES_MAX) break;
  }
  return out;
}

/** `a,b,c` from a pairing link's `g` parameter. */
export function parseGamesParam(text: string): string[] {
  return cleanGames(text.split(',').map(s => s.trim()));
}

/** The games to offer for a Keep: its stored list if it has one, else every allowlisted game. */
export function gamesOffered(keep: { games?: readonly string[] }): string[] {
  const stored = cleanGames(keep.games);
  return stored.length > 0 ? stored : KEEP_GAMES.map(g => g.scheme);
}

/** The scheme of a `<scheme>://keep/...` link when it is allowlisted; null for any other link. */
export function keepGameOfLink(link: unknown): string | null {
  if (typeof link !== 'string') return null;
  const m = /^([a-z][a-z0-9]{0,31}):\/\/keep\//.exec(link);
  return m && isKeepGame(m[1]) ? m[1] : null;
}

/** Hand a link to the phone's app opener only if it is an allowlisted game's Keep link. Returns whether it was opened. */
export function openKeepGameLink(link: unknown, open: (link: string) => void): boolean {
  if (typeof link !== 'string' || !keepGameOfLink(link)) return false;
  open(link);
  return true;
}

// ---- the last game chosen for a Keep, on this device ----------------------------------------------------------

export const KEEP_GAME_CHOICE_PREFIX = 'signet:keep-game:';

/** One entry per identity and Keep, like the Keep nicknames, so another account on the device neither sees nor shares it. */
const choiceKey = (scope: string, keep: string) => `${KEEP_GAME_CHOICE_PREFIX}${encodeURIComponent(scope)}:${keep}`;

/** The game last picked for this Keep by this identity on this device, if it is still an allowlisted one. A failing storage means none. */
export function loadGameChoice(scope: string, keep: string): string | null {
  try {
    const v = localStorage.getItem(choiceKey(scope, keep));
    return isKeepGame(v) ? v : null;
  } catch { return null; }
}

/** Only called when the owner picks a game from more than one. */
export function saveGameChoice(scope: string, keep: string, scheme: string): void {
  if (!isKeepGame(scheme)) return;
  try { localStorage.setItem(choiceKey(scope, keep), scheme); } catch { /* storage unavailable: the choice lasts this visit only */ }
}

/** Forget the saved choice for one Keep (when the Keep is forgotten). Never throws. */
export function forgetGameChoice(scope: string, keep: string): void {
  try { localStorage.removeItem(choiceKey(scope, keep)); } catch { /* storage unavailable: nothing to forget */ }
}

/** Remove every saved game choice. Never throws. */
export function clearGameChoices(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(KEEP_GAME_CHOICE_PREFIX)) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch { /* storage unavailable: nothing to clear */ }
}

/** Which game is selected: the one asked for, else the last used, else the first offered; each only if offered. */
export function pickGame(offered: readonly string[], requested: string | null | undefined, last: string | null): string {
  if (requested && offered.includes(requested)) return requested;
  if (last && offered.includes(last)) return last;
  return offered[0] ?? DEFAULT_KEEP_GAME;
}
