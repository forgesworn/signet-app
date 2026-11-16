// @vitest-environment jsdom
/**
 * Child-direct Heartwood pairing: the guardian publishes the persona inventory
 * signed by the dependant's `bunkerEndpoint`, which on a direct dependant is
 * the RAIL key. The record's `bunkerUri` there is `bunker://<bound persona>`,
 * so the subscription must pin the rail key (`record.railPubkey`), never the
 * key in the URI. A legacy phone-paired record keeps the URI's endpoint.
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
import { subscribePersonaInventory, type PersonaInventoryPayload } from '../lib/persona-inventory-sync';
import { usePersonaInventory } from './usePersonaInventory';
import type { SignetIdentity } from '../types';

const DEP = 'd'.repeat(64);
const RAIL = 'a'.repeat(64);
const PERSONA = 'b'.repeat(64);
const CLIENT_PRIV = '1'.repeat(64);
const ENDPOINT = 'e'.repeat(64);

const directRecord = (over: Record<string, unknown> = {}) => ({
  id: DEP,
  bunkerUri: `bunker://${PERSONA}?relay=wss%3A%2F%2Fhw.example`,
  clientKeypair: { privateKey: CLIENT_PRIV, publicKey: 'c'.repeat(64) },
  dependantPubkey: DEP,
  dependantName: 'Lily',
  pairedAt: 1,
  mode: 'heartwood-direct' as const,
  railPubkey: RAIL,
  personaPubkey: PERSONA,
  hwRelays: ['wss://hw.example'],
  railRelay: 'wss://relay.example',
  ...over,
});

const legacyRecord = () => ({
  id: DEP,
  bunkerUri: `bunker://${ENDPOINT}?relay=wss%3A%2F%2Frelay.example&secret=s`,
  clientKeypair: { privateKey: CLIENT_PRIV, publicKey: 'c'.repeat(64) },
  dependantPubkey: DEP,
  dependantName: 'Lily',
  pairedAt: 1,
});

const props = { relayUrl: 'wss://relay.example', encryptionKey: 'k', dependantPubkey: DEP, enabled: true, onInventoryMerged: async () => {} };

describe('usePersonaInventory — which guardian key it listens for', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('a direct record subscribes with the rail key, never the bound persona in bunkerUri', async () => {
    vi.mocked(db.loadPairedChild).mockResolvedValue(directRecord() as never);
    renderHook(() => usePersonaInventory(props));
    await waitFor(() => expect(subscribePersonaInventory).toHaveBeenCalledTimes(1));
    expect(vi.mocked(subscribePersonaInventory).mock.calls[0][0]).toBe(RAIL);
    expect(vi.mocked(subscribePersonaInventory).mock.calls[0][0]).not.toBe(PERSONA);
  });

  it('a direct record with no usable rail key subscribes to nothing (no bunkerUri fallback)', async () => {
    vi.mocked(db.loadPairedChild).mockResolvedValue(directRecord({ railPubkey: undefined }) as never);
    renderHook(() => usePersonaInventory(props));
    await waitFor(() => expect(db.loadPairedChild).toHaveBeenCalledTimes(1));
    await new Promise(r => setTimeout(r, 20));
    expect(subscribePersonaInventory).not.toHaveBeenCalled();
  });

  it('a legacy phone-paired record still subscribes with the bunkerUri endpoint', async () => {
    vi.mocked(db.loadPairedChild).mockResolvedValue(legacyRecord() as never);
    renderHook(() => usePersonaInventory(props));
    await waitFor(() => expect(subscribePersonaInventory).toHaveBeenCalledTimes(1));
    expect(vi.mocked(subscribePersonaInventory).mock.calls[0][0]).toBe(ENDPOINT);
  });

  it('a direct record merges with the bound persona pinned (hidden persona is not blanked)', async () => {
    vi.mocked(db.loadPairedChild).mockResolvedValue(directRecord() as never);
    vi.mocked(db.loadPairedChildPersonaRevision).mockResolvedValue(0);
    const stored = {
      id: DEP, mnemonic: '',
      naturalPerson: { publicKey: '', privateKey: '', displayName: 'Lily' },
      persona: { publicKey: PERSONA, privateKey: '', displayName: 'Lily' },
      primaryKeypair: 'persona', naturalPersonActive: false,
    } as unknown as SignetIdentity;
    vi.mocked(db.loadIdentityDecrypted).mockResolvedValue(stored);
    const merged = vi.fn(async () => {});
    renderHook(() => usePersonaInventory({ ...props, onInventoryMerged: merged }));
    await waitFor(() => expect(subscribePersonaInventory).toHaveBeenCalledTimes(1));
    const onPayload = vi.mocked(subscribePersonaInventory).mock.calls[0][3] as (r: { payload: PersonaInventoryPayload; createdAt: number }) => Promise<void>;
    // The guardian activated the real identity, hid the bound persona from
    // the phone and added an extra.
    const NP = '9'.repeat(64);
    await onPayload({ payload: {
      v: 1, revision: 5,
      naturalPerson: { publicKey: NP, displayName: 'Lily Rivera' },
      extraPersonas: [{ publicKey: 'f'.repeat(64), displayName: 'Gamer' }],
    } as PersonaInventoryPayload, createdAt: 5 });
    await waitFor(() => expect(merged).toHaveBeenCalled());
    const saved = vi.mocked(db.saveIdentityEncrypted).mock.calls[0][0] as SignetIdentity;
    expect(saved.persona.publicKey).toBe(PERSONA);
    expect(saved.primaryKeypair).toBe('persona');
    expect(saved.extraPersonas?.map(x => x.publicKey)).toEqual(['f'.repeat(64)]);
  });
});
