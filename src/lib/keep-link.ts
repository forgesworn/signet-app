/**
 * The pairing link a Keep shows on its own box (K1d contract):
 *
 *   signet-keep:pair?k=<K hex>&c=<code 32 hex>&n=<name>&r=<wss URL>[&r=...]
 *
 * One to three `r` values, `wss://` only. Parsing is strict: anything else is
 * not a Keep link. Relays are NOT held to the handshake's public-host rule,
 * because a Keep's relay may legitimately be one the owner runs at home.
 */
import { sanitizeDisplayName } from './text-sanitize';
import { isValidRelayUrl } from './relay-url';

export interface KeepPairLink {
  /** The Keep's key, lowercase hex. */
  keep: string;
  /** The one-time claim code, lowercase hex. */
  code: string;
  name: string;
  relays: string[];
}

const PREFIX = 'signet-keep:pair?';
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
export const KEEP_NAME_MAX = 40;
const MAX_LINK = 2048;

export function parseKeepPairLink(raw: string): KeepPairLink | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || text.length > MAX_LINK || !text.toLowerCase().startsWith(PREFIX)) return null;
  let params: URLSearchParams;
  try { params = new URLSearchParams(text.slice(PREFIX.length)); } catch { return null; }
  const one = (key: string): string | null => {
    const all = params.getAll(key);
    return all.length === 1 ? all[0] : null;
  };
  const keep = one('k')?.toLowerCase() ?? '';
  const code = one('c')?.toLowerCase() ?? '';
  if (!HEX64.test(keep) || !HEX32.test(code)) return null;
  const relays = params.getAll('r');
  if (relays.length < 1 || relays.length > 3) return null;
  for (const url of relays) {
    if (!url.startsWith('wss://') || !isValidRelayUrl(url)) return null;
    try { new URL(url); } catch { return null; }
  }
  if (new Set(relays).size !== relays.length) return null;
  const name = sanitizeDisplayName(params.get('n') ?? '', KEEP_NAME_MAX).trim();
  return { keep, code, name: name || 'Your Keep', relays };
}
