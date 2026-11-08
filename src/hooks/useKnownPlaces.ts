import { useState, useEffect, useCallback, useRef } from 'react';
import type { KnownPlace, KnownPlaceInput } from '../types';
import {
  listKnownPlaces,
  setKnownPlaceAlias,
  setKnownPlacePinned,
  deleteKnownPlace,
  deleteKnownPlacesForPlace,
  subscribeKnownPlaces,
} from '../lib/db';
import { recordKnownPlace } from '../lib/known-places-record';

/**
 * Places this phone remembers an identity being used (signed-in sites, paired
 * NIP-46 apps, NIP-55 callers). Reloads on mount, whenever `encryptionKey`
 * flips (lock / unlock), and whenever any writer — including the NIP-46 and
 * NIP-55 hooks, which write straight to the DB — commits a change.
 */
export function useKnownPlaces(encryptionKey: string | null | undefined) {
  const [places, setPlaces] = useState<KnownPlace[]>([]);
  const [loading, setLoading] = useState(true);
  const live = useRef(true);

  const refresh = useCallback(async () => {
    const all = await listKnownPlaces();
    if (!live.current) return;
    setPlaces(all.sort((a, b) => b.lastAt - a.lastAt));
  }, []);

  useEffect(() => {
    live.current = true;
    const off = subscribeKnownPlaces(() => { void refresh().catch(() => {}); });
    return () => { live.current = false; off(); };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    refresh()
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refresh, encryptionKey]);

  const record = useCallback((input: KnownPlaceInput) => recordKnownPlace(input), []);
  const setAlias = useCallback((id: string, alias: string) => setKnownPlaceAlias(id, alias), []);
  const setPinned = useCallback((id: string, pinned: boolean) => setKnownPlacePinned(id, pinned), []);
  const forget = useCallback((id: string) => deleteKnownPlace(id), []);
  const forgetPlace = useCallback((placeKey: string) => deleteKnownPlacesForPlace(placeKey), []);

  return { places, loading, refresh, record, setAlias, setPinned, forget, forgetPlace };
}
