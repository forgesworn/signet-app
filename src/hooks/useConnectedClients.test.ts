// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useConnectedClients } from './useConnectedClients';
import * as db from '../lib/db';
import type { ConnectedClient } from '../types';

const CLIENT_A = 'a'.repeat(64);
const CLIENT_B = 'b'.repeat(64);

function client(clientPubkey: string, lastSeenAt = 2000): ConnectedClient {
  return { clientPubkey, appName: 'Test App', appUrl: 'https://example.test', connectedAt: 1000, lastSeenAt, allowAlways: true };
}

beforeEach(async () => {
  await db.purgeAllUserData();
});

describe('useConnectedClients', () => {
  it('shows grants created, changed and revoked after the app mounted', async () => {
    const { result } = renderHook(() => useConnectedClients());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await db.saveConnectedClient(client(CLIENT_A)); });
    await waitFor(() => expect(result.current.clients).toHaveLength(1));
    expect(result.current.clients[0].allowAlways).toBe(true);

    await act(async () => { await db.saveConnectedClient({ ...client(CLIENT_A), allowAlways: false }); });
    await waitFor(() => expect(result.current.clients[0].allowAlways).toBe(false));

    await act(async () => { await db.deleteConnectedClient(CLIENT_A); });
    await waitFor(() => expect(result.current.clients).toEqual([]));
  });

  it('loads paired bunker clients', async () => {
    await db.saveConnectedClient(client(CLIENT_A));
    const { result } = renderHook(() => useConnectedClients());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.clients.map(c => c.clientPubkey)).toEqual([CLIENT_A]);
  });

  it('disconnect revokes the client so its silent-crypto grant is gone', async () => {
    await db.saveConnectedClient(client(CLIENT_A));
    const { result } = renderHook(() => useConnectedClients());
    await waitFor(() => expect(result.current.clients.length).toBe(1));

    await act(async () => { await result.current.disconnect(CLIENT_A); });

    expect(result.current.clients).toEqual([]);
    // useBunkerServer gates silent sign/decrypt on getConnectedClient().allowAlways —
    // with the row gone, the next request finds nothing to auto-approve and prompts.
    expect(await db.getConnectedClient(CLIENT_A)).toBeUndefined();
  });

  it('lists the most-recently-active client first', async () => {
    await db.saveConnectedClient(client(CLIENT_A, 100));
    await db.saveConnectedClient(client(CLIENT_B, 900));
    const { result } = renderHook(() => useConnectedClients());
    await waitFor(() => expect(result.current.clients.length).toBe(2));
    expect(result.current.clients.map(c => c.clientPubkey)).toEqual([CLIENT_B, CLIENT_A]);
  });
});
