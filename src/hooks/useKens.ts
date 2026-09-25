import { useState, useEffect, useCallback } from 'react';
import type { KenEntry } from '@forgesworn/kenspeckle';
import * as db from '../lib/db';

export function useKens(ownerPubkey: string | undefined) {
  const [kens, setKens] = useState<KenEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!ownerPubkey) { setKens([]); setLoading(false); return; }
    const all = await db.getKens(ownerPubkey);
    setKens(all.sort((a, b) => (b.lastResolvedAt ?? b.addedAt) - (a.lastResolvedAt ?? a.addedAt)));
    setLoading(false);
  }, [ownerPubkey]);

  useEffect(() => { reload(); }, [reload]);

  const addKen = useCallback(async (ken: KenEntry) => { await db.saveKen(ken); await reload(); }, [reload]);
  const removeKen = useCallback(async (pubkey: string) => {
    await db.deleteKen(pubkey);
    await db.deleteContactAvatar(pubkey);
    await reload();
  }, [reload]);

  return { kens, loading, addKen, removeKen, reload };
}
