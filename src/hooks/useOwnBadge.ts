import { useState, useEffect } from 'react';
import { fetchBadge } from '../lib/badge-fetch';
import type { CachedBadge } from '../lib/badge-fetch';

/** Fetches the user's own Signet badge (and IQ score) from the relay.
 *  Returns null if either argument is absent or the relay is unreachable. */
export function useOwnBadge(pubkey: string | undefined, relayUrl: string | undefined): { badge: CachedBadge | null } {
  const [badge, setBadge] = useState<CachedBadge | null>(null);

  useEffect(() => {
    if (!pubkey || !relayUrl) return;

    let cancelled = false;

    fetchBadge(pubkey, relayUrl).then(result => {
      if (!cancelled) setBadge(result);
    }).catch(() => {
      // Silently ignore — relay may be unreachable
    });

    return () => { cancelled = true; };
  }, [pubkey, relayUrl]);

  return { badge };
}
