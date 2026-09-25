import { useState, useEffect, useCallback } from 'react';
import type { AuthorizedSite } from '../types';
import {
  getAuthorizedSites,
  deleteAuthorizedSite,
  upsertAuthorizedSiteByOrigin,
  saveAuthorizedSite,
} from '../lib/db';

export function useAuthorizedSites() {
  const [sites, setSites] = useState<AuthorizedSite[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const all = await getAuthorizedSites();
    setSites(all.sort((a, b) => b.lastUsedAt - a.lastUsedAt));
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const authorize = useCallback(async (
    origin: string,
    name: string,
    keypairUsed: string,
    pubkeyShared: string,
    extras?: { shareHandle?: boolean; consumerDisplayName?: string },
  ) => {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { return; }
    // Reject non-web schemes — origin is later surfaced in UI and used as a
    // principal for grants, so `javascript:` / `data:` / `file:` etc. must
    // not enter the store.
    if (parsed.protocol !== 'https:' &&
        !(parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'))) {
      return;
    }
    if (origin.length > 2048) return;
    const safeName = name.slice(0, 200);
    if (!/^[0-9a-f]{64}$/i.test(pubkeyShared)) return;

    const safeAlias = extras?.consumerDisplayName
      ? extras.consumerDisplayName.slice(0, 64)
      : undefined;

    const now = Math.floor(Date.now() / 1000);
    // Single-transaction upsert: the read (find existing by origin) and
    // the write happen in the same IDB transaction, so concurrent
    // authorize() calls for the same origin can't both decide "no existing"
    // and leave duplicate rows keyed on different random UUIDs.
    await upsertAuthorizedSiteByOrigin(origin, {
      name: safeName,
      keypairUsed,
      pubkeyShared,
      lastUsedAt: now,
      ...(extras?.shareHandle !== undefined ? { shareHandle: extras.shareHandle } : {}),
      ...(safeAlias ? { consumerDisplayName: safeAlias } : {}),
    });
    await refresh();
  }, [refresh]);

  const revoke = useCallback(async (id: string) => {
    await deleteAuthorizedSite(id);
    await refresh();
  }, [refresh]);

  const updateAlias = useCallback(async (id: string, alias: string) => {
    const all = await getAuthorizedSites();
    const target = all.find(s => s.id === id);
    if (!target) return;
    const trimmed = alias.trim().slice(0, 64);
    const next: AuthorizedSite = {
      ...target,
      consumerDisplayName: trimmed.length > 0 ? trimmed : undefined,
    };
    await saveAuthorizedSite(next);
    await refresh();
  }, [refresh]);

  return { sites, loading, authorize, revoke, updateAlias };
}
