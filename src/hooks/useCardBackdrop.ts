import { useCallback, useState } from 'react';
import { useObjectUrl } from './useObjectUrl';
import { getCardBackdrop, setCardBackdrop, deleteCardBackdrop } from '../lib/db';

/** Largest accepted backdrop image. Guards the preferences store, not memory. */
export const MAX_BACKDROP_BYTES = 8 * 1024 * 1024;

/**
 * Device-local card backdrop for one identity — the card's "wallpaper".
 * Keyed by the identity's pubkey so every persona (and the real identity)
 * can carry its own. Not synced: like a phone wallpaper, it belongs to
 * this install. Returns null `url` while loading or when none is set.
 */
export function useCardBackdrop(pubkey: string | undefined): {
  url: string | null;
  set: (file: File) => Promise<void>;
  clear: () => Promise<void>;
} {
  // Bumps after a write so useObjectUrl re-reads the stored blob.
  const [version, setVersion] = useState(0);

  const url = useObjectUrl(
    pubkey ? () => getCardBackdrop(pubkey).catch(() => null) : null,
    [pubkey, version],
  );

  const set = useCallback(async (file: File) => {
    if (!pubkey) return;
    if (!file.type.startsWith('image/') || file.size > MAX_BACKDROP_BYTES) return;
    await setCardBackdrop(pubkey, file);
    setVersion(v => v + 1);
  }, [pubkey]);

  const clear = useCallback(async () => {
    if (!pubkey) return;
    await deleteCardBackdrop(pubkey);
    setVersion(v => v + 1);
  }, [pubkey]);

  return { url, set, clear };
}
