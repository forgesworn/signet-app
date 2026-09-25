import { useState, useEffect, useCallback } from 'react';
import { ATTESTATION_KIND, ATTESTATION_TYPES, type NostrEvent } from 'signet-protocol';
import { getRelayClient, getRelayState, addStateListener } from '../lib/relay-service';
import { verifiedAuthoredEvents } from '../lib/event-verify';

interface NostrEvents {
  credentials: NostrEvent[];
  vouches: NostrEvent[];
  bridges: NostrEvent[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useNostrEvents(pubkey: string | undefined): NostrEvents {
  const [credentials, setCredentials] = useState<NostrEvent[]>([]);
  const [vouches, setVouches] = useState<NostrEvent[]>([]);
  const [bridges, setBridges] = useState<NostrEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    if (!pubkey) return;
    if (getRelayState() !== 'connected') return;

    setLoading(true);
    setError(null);

    try {
      const client = getRelayClient();

      const creds = await client.fetch([
        { kinds: [ATTESTATION_KIND], '#t': [ATTESTATION_TYPES.CREDENTIAL], '#d': [pubkey] } as never,
      ]);
      // Drop relay-forged events with invalid signatures before display.
      const verifiedCreds = verifiedAuthoredEvents(creds as unknown as Array<{ pubkey: string; sig: string; id: string }>);
      setCredentials(verifiedCreds as unknown as NostrEvent[]);

      const vs = await client.fetch([
        { kinds: [ATTESTATION_KIND], '#t': [ATTESTATION_TYPES.VOUCH], '#d': [pubkey] } as never,
      ]);
      const verifiedVouches = verifiedAuthoredEvents(vs as unknown as Array<{ pubkey: string; sig: string; id: string }>);
      setVouches(verifiedVouches as unknown as NostrEvent[]);

      const br = await client.fetch([
        { kinds: [ATTESTATION_KIND], '#t': [ATTESTATION_TYPES.IDENTITY_BRIDGE], authors: [pubkey] } as never,
      ]);
      // Bridges are self-authored — also enforce author match.
      const verifiedBridges = verifiedAuthoredEvents(br as unknown as Array<{ pubkey: string; sig: string; id: string }>, pubkey);
      setBridges(verifiedBridges as unknown as NostrEvent[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch events');
    } finally {
      setLoading(false);
    }
  }, [pubkey]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Re-fetch when relay transitions to connected (handles async connection timing).
  // M8: fan-out listener, not a direct single-slot registration.
  useEffect(() => {
    if (!pubkey) return;
    const unsubscribe = addStateListener((newState) => {
      if (newState === 'connected') {
        fetchAll();
      }
    });
    return unsubscribe;
  }, [pubkey, fetchAll]);

  return { credentials, vouches, bridges, loading, error, refresh: fetchAll };
}
