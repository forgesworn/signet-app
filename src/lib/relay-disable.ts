import type { AppPreferences, RelayConfig } from '../types';
import { defaultRelays, migrateRelayPreferences } from './relay-defaults';
import { isValidRelayUrl } from './relay-url';

/** The relay list with `url` switched off (kept, so it stays reversible), or
 * null when switching it off would do nothing or leave no write relay. Works
 * from the same list `resolveSyncRelays` syncs against: retired relays migrated
 * out, and the defaults materialised when no list is stored. A legacy install
 * with only a single `relayUrl` is not touched. */
export function relayListWithDisabled(
  prefs: Pick<AppPreferences, 'relays' | 'relayUrl'>, url: string,
): RelayConfig[] | null {
  const effective = migrateRelayPreferences(prefs);
  const stored = effective.relays ?? [];
  const legacyOnly = !stored.some(r => isValidRelayUrl(r.url)) && !!effective.relayUrl && isValidRelayUrl(effective.relayUrl);
  if (legacyOnly) return null;
  const list = stored.length ? stored : defaultRelays();
  const target = list.find(r => r.url === url);
  if (!target?.enabled) return null;
  if (target.write && list.filter(r => r.enabled && r.write).length <= 1) return null;
  return list.map(r => (r.url === url ? { ...r, enabled: false } : r));
}
