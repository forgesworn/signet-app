import { useState, useEffect, useCallback } from 'react';
import type { ConnectedClient } from '../types';
import { listConnectedClients, deleteConnectedClient, subscribeConnectedClients } from '../lib/db';

/**
 * Bunker (NIP-46) clients that have paired with this device.
 *
 * A client with `allowAlways: true` can `sign_event` / `nip44_*` WITHOUT a
 * prompt (useBunkerServer gates silent crypto on `getConnectedClient().allowAlways`),
 * so this is the surface that must let the user SEE and END those grants — the
 * `ConnectedClient.allowAlways` docstring already promises it is "revocable via
 * the Connections settings page", but nothing wired it until now. Deleting the
 * row genuinely revokes: the next request finds no `allowAlways` row and prompts
 * again, and reconnect only re-grants against a fresh, one-shot, user-minted
 * pairing secret — never silently.
 */
export function useConnectedClients() {
  const [clients, setClients] = useState<ConnectedClient[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const all = await listConnectedClients();
    setClients(all.sort((a, b) => b.lastSeenAt - a.lastSeenAt));
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeConnectedClients(() => {
      void refresh().catch(() => {});
    });
    refresh().finally(() => setLoading(false));
    return unsubscribe;
  }, [refresh]);

  const disconnect = useCallback(async (clientPubkey: string) => {
    await deleteConnectedClient(clientPubkey);
    await refresh();
  }, [refresh]);

  return { clients, loading, disconnect, refresh };
}
