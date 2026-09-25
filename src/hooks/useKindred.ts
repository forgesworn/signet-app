import { useCallback, useMemo } from 'react';
import type { KindredEntry } from '@forgesworn/kenspeckle';
import { searchEntries } from '@forgesworn/kenspeckle';
import { useContacts } from './useContacts';
import { useKens } from './useKens';
import { contactToKindredEntry } from '../lib/kindred-adapter';

/** Unified per-identity relationships view: kin/kith from `contacts`,
 *  ken from the `ken` store, all scoped to one `ownerPubkey`. Every contact
 *  and ken is shown here regardless of timestamp validity — this is a
 *  display list, not the envelope-building path, and a bad `addedAt`/
 *  `verifiedAt` must never hide a record the user needs to see or delete
 *  (sanitising/dropping happens only at `companion-rail.ts`'s
 *  `filterByScope`, on the way into a companion-app snapshot). */
export function useKindred(ownerPubkey: string | undefined, encryptionKey?: string | null) {
  const { members, loading: cLoading, reload: reloadContacts } = useContacts(ownerPubkey, encryptionKey);
  const { kens, loading: kLoading, reload: reloadKens } = useKens(ownerPubkey);

  const entries = useMemo<KindredEntry[]>(
    () => [...members.map(contactToKindredEntry), ...kens],
    [members, kens],
  );
  const kin = useMemo(() => entries.filter(e => e.tier === 'kin'), [entries]);
  const kith = useMemo(() => entries.filter(e => e.tier === 'kith'), [entries]);
  const ken = useMemo(() => entries.filter(e => e.tier === 'ken'), [entries]);

  // Stable references so memoised consumers (e.g. the Rolodex) don't churn.
  const search = useCallback((q: string) => searchEntries(entries, q), [entries]);
  const reload = useCallback(
    async () => { await Promise.all([reloadContacts(), reloadKens()]); },
    [reloadContacts, reloadKens],
  );

  return {
    entries, kin, kith, ken,
    loading: cLoading || kLoading,
    search,
    reload,
  };
}
