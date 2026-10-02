// @vitest-environment jsdom
/**
 * Bug 5 (device, 2026-09-30): an in-session re-pair replaces the paired-child
 * record's client key / endpoint under the SAME dependant pubkey. The
 * inventory subscription must re-read the record, not keep decrypting with
 * the retired pairing's key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../lib/db', () => ({
  loadPairedChild: vi.fn(),
  loadPairedChildPersonaRevision: vi.fn(),
  loadIdentityDecrypted: vi.fn(),
  saveIdentityEncrypted: vi.fn(),
  savePairedChildPersonaRevision: vi.fn(),
}));
vi.mock('../lib/persona-inventory-sync', () => ({
  subscribePersonaInventory: vi.fn(() => () => {}),
}));

import * as db from '../lib/db';
import { subscribePersonaInventory } from '../lib/persona-inventory-sync';
import { usePersonaInventory } from './usePersonaInventory';

const DEP = 'd'.repeat(64);
const record = (clientPriv: string, endpoint: string) => ({
  bunkerUri: `bunker://${endpoint}?relay=wss%3A%2F%2Frelay.example`,
  clientKeypair: { privateKey: clientPriv, publicKey: '' },
  dependantPubkey: DEP,
});

describe('usePersonaInventory on re-pair', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('re-subscribes with the new pairing when pairingGeneration changes', async () => {
    const load = vi.mocked(db.loadPairedChild);
    const sub = vi.mocked(subscribePersonaInventory);
    load.mockResolvedValueOnce(record('1'.repeat(64), 'a'.repeat(64)) as never);
    const props = { relayUrl: 'wss://relay.example', encryptionKey: 'k', dependantPubkey: DEP, enabled: true, onInventoryMerged: async () => {} };
    const { rerender } = renderHook((p: { gen: number }) => usePersonaInventory({ ...props, pairingGeneration: p.gen }), { initialProps: { gen: 0 } });
    await waitFor(() => expect(sub).toHaveBeenCalledTimes(1));
    expect(sub.mock.calls[0][0]).toBe('a'.repeat(64));

    load.mockResolvedValueOnce(record('2'.repeat(64), 'b'.repeat(64)) as never);
    rerender({ gen: 1 });
    await waitFor(() => expect(sub).toHaveBeenCalledTimes(2));
    expect(sub.mock.calls[1][0]).toBe('b'.repeat(64));
    expect(load).toHaveBeenCalledTimes(2);
  });
});
