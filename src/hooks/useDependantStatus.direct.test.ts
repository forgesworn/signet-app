// @vitest-environment jsdom
/**
 * The guardian signs the dependant-status rail with the dependant's
 * `bunkerEndpoint` — the rail key on a child-direct dependant. A direct
 * child must fetch from (and decrypt against) the rail key, never the bound
 * persona its `bunker://` URI names. A legacy record keeps the URI endpoint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../lib/db', () => ({
  loadPairedChild: vi.fn(),
  loadPairedChildStatus: vi.fn(),
  savePairedChildStatus: vi.fn(),
}));
vi.mock('../lib/dependant-status-sync', async (original) => ({
  ...await original<typeof import('../lib/dependant-status-sync')>(),
  fetchDependantStatus: vi.fn(),
}));

import * as db from '../lib/db';
import { fetchDependantStatus } from '../lib/dependant-status-sync';
import { useDependantStatus } from './useDependantStatus';

const DEP = 'd'.repeat(64);
const RAIL = 'a'.repeat(64);
const PERSONA = 'b'.repeat(64);
const ENDPOINT = 'e'.repeat(64);
const CLIENT = { privateKey: '1'.repeat(64), publicKey: 'c'.repeat(64) };
const props = { relayUrl: 'wss://relay.example', encryptionKey: 'k', dependantPubkey: DEP, enabled: true };

describe('useDependantStatus — which guardian key it fetches from', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.loadPairedChildStatus).mockResolvedValue(null as never);
    vi.mocked(fetchDependantStatus).mockResolvedValue(null);
  });

  it('a direct record fetches from the rail key', async () => {
    vi.mocked(db.loadPairedChild).mockResolvedValue({
      id: DEP, dependantPubkey: DEP, dependantName: 'Lily', pairedAt: 1, clientKeypair: CLIENT,
      bunkerUri: `bunker://${PERSONA}?relay=wss%3A%2F%2Fhw.example`,
      mode: 'heartwood-direct', railPubkey: RAIL, personaPubkey: PERSONA,
    } as never);
    renderHook(() => useDependantStatus(props));
    await waitFor(() => expect(fetchDependantStatus).toHaveBeenCalledTimes(1));
    expect(vi.mocked(fetchDependantStatus).mock.calls[0][0]).toBe(RAIL);
  });

  it('a legacy record fetches from the bunkerUri endpoint', async () => {
    vi.mocked(db.loadPairedChild).mockResolvedValue({
      id: DEP, dependantPubkey: DEP, dependantName: 'Lily', pairedAt: 1, clientKeypair: CLIENT,
      bunkerUri: `bunker://${ENDPOINT}?relay=wss%3A%2F%2Frelay.example&secret=s`,
    } as never);
    renderHook(() => useDependantStatus(props));
    await waitFor(() => expect(fetchDependantStatus).toHaveBeenCalledTimes(1));
    expect(vi.mocked(fetchDependantStatus).mock.calls[0][0]).toBe(ENDPOINT);
  });
});
