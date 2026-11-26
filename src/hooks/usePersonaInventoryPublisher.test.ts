// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/persona-inventory-sync', async (original) => ({
  ...await original<typeof import('../lib/persona-inventory-sync')>(),
  publishPersonaInventory: vi.fn(),
}));

import { publishPersonaInventory, type PersonaInventoryParams } from '../lib/persona-inventory-sync';
import { buildPersonaFirstDependant } from '../lib/dependant-record';
import { usePersonaInventoryPublisher } from './usePersonaInventoryPublisher';
import type { DependantIdentity } from '../types';

const mPublish = vi.mocked(publishPersonaInventory);
const NP = 'a'.repeat(64), PERSONA = 'b'.repeat(64), EXTRA = 'c'.repeat(64), HIDDEN = 'e'.repeat(64), CLIENT = 'd'.repeat(64);
const RELAY = 'wss://guardian.example', RAIL = 'wss://rail.example';

function dep(over: Partial<DependantIdentity> = {}): DependantIdentity {
  return {
    ...buildPersonaFirstDependant({ guardianPubkey: 'f'.repeat(64), enteredName: 'Lily', derivationPath: 'dependant-2',
      naturalPerson: { publicKey: NP, privateKey: '' }, persona: { publicKey: PERSONA, privateKey: '' }, createdAt: 1 }),
    bunkerEndpoint: { publicKey: '9'.repeat(64), privateKey: '11'.repeat(32), authorizedClientPubkey: CLIENT } as never,
    extraPersonas: [{ publicKey: EXTRA, privateKey: '', displayName: 'Gamer' } as never],
    ...over,
  };
}
const direct = (over: Partial<NonNullable<DependantIdentity['childDevice']>> = {}): DependantIdentity => dep({
  childDevice: { mode: 'heartwood-direct', slotLabel: 'signet:child-device:v2:x', secretFingerprint: 'ab', slotIndex: 6,
    clientPubkey: CLIENT, boundPersona: PERSONA, pairedAt: 1, railRelay: RAIL, ...over },
});
const sentKeys = (call: number) => {
  const p = mPublish.mock.calls[call][0] as PersonaInventoryParams;
  return [p.persona?.publicKey, p.naturalPerson?.publicKey, ...p.extraPersonas.map(e => e.publicKey)].filter(Boolean);
};

beforeEach(() => { mPublish.mockReset(); mPublish.mockResolvedValue(true); });

describe('usePersonaInventoryPublisher — what goes to the paired phone', () => {
  it('A51: a persona removed from the phone is not published, and the removal republishes', async () => {
    const { rerender } = renderHook(({ deps }) => usePersonaInventoryPublisher({ dependants: deps, relayUrl: RELAY, encryptionKey: 'k' }),
      { initialProps: { deps: [direct()] } });
    await waitFor(() => expect(mPublish).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(sentKeys(0)).toEqual([PERSONA, EXTRA]);

    rerender({ deps: [direct({ removedPersonas: [EXTRA] })] });
    await waitFor(() => expect(mPublish).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(sentKeys(1)).toEqual([PERSONA]);
  });

  it('A51: a removed real identity is not published even when active', async () => {
    renderHook(() => usePersonaInventoryPublisher({
      dependants: [{ ...direct({ removedPersonas: [NP] }), naturalPersonActive: true }], relayUrl: RELAY, encryptionKey: 'k' }));
    await waitFor(() => expect(mPublish).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(sentKeys(0)).toEqual([PERSONA, EXTRA]);
  });

  it('A51: the bound persona is published even when hidden from the paired device', async () => {
    renderHook(() => usePersonaInventoryPublisher({
      dependants: [{ ...direct({ removedPersonas: [PERSONA] }), hiddenOnPairedDeviceKeys: [PERSONA] }], relayUrl: RELAY, encryptionKey: 'k' }));
    await waitFor(() => expect(mPublish).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(sentKeys(0)).toEqual([PERSONA, EXTRA]);
  });

  it('legacy dependant: unchanged — a hidden persona and hidden extras stay off the wire', async () => {
    renderHook(() => usePersonaInventoryPublisher({
      dependants: [dep({ hiddenOnPairedDeviceKeys: [PERSONA],
        extraPersonas: [{ publicKey: EXTRA, privateKey: '', displayName: 'Gamer' } as never, { publicKey: HIDDEN, privateKey: '', displayName: 'Old', hidden: true } as never] })],
      relayUrl: RELAY, encryptionKey: 'k' }));
    await waitFor(() => expect(mPublish).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(sentKeys(0)).toEqual([EXTRA]);
    expect(mPublish.mock.calls[0][2]).toEqual([RELAY]);
  });

  it('A56: a direct dependant\'s inventory also goes to the pairing\'s rail relay', async () => {
    renderHook(() => usePersonaInventoryPublisher({ dependants: [direct()], relayUrl: RELAY, encryptionKey: 'k' }));
    await waitFor(() => expect(mPublish).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(mPublish.mock.calls[0][2]).toEqual([RELAY, RAIL]);
  });

  describe('guardian backdrops', () => {
    const H = '1'.repeat(64), K = '2'.repeat(64), H2 = '3'.repeat(64), K2 = '4'.repeat(64);
    const bd = (hash = H, key = K) => ({ backdropHash: hash, backdropBlossomUrl: 'https://nostr.download', backdropKey: key, backdropUpdatedAt: 5 });
    const withBackdrop = (d: DependantIdentity, fields = bd()): DependantIdentity => ({
      ...d,
      persona: { ...d.persona, ...fields },
      naturalPerson: { ...d.naturalPerson, ...fields },
      extraPersonas: (d.extraPersonas ?? []).map(e => ({ ...e, ...fields })),
      naturalPersonActive: true,
    });
    const sent = (call = 0) => mPublish.mock.calls[call][0] as PersonaInventoryParams;

    it('puts the backdrop fields on the wire for NP, persona and extras', async () => {
      renderHook(() => usePersonaInventoryPublisher({ dependants: [withBackdrop(dep())], relayUrl: RELAY, encryptionKey: 'k' }));
      await waitFor(() => expect(mPublish).toHaveBeenCalledTimes(1), { timeout: 3000 });
      for (const e of [sent().naturalPerson!, sent().persona!, sent().extraPersonas[0]]) {
        expect(e).toMatchObject({ backdropHash: H, backdropKey: K, backdropBlossomUrl: 'https://nostr.download', backdropUpdatedAt: 5 });
      }
    });

    it('child-direct (a phone paired straight to a Heartwood) gets the backdrop fields too', async () => {
      // Fixture shape = what `useChildDevicePairing` writes on a direct pairing:
      // `bunkerEndpoint.authorizedClientPubkey` is the child's client key and
      // `childDevice.clientPubkey` repeats it. The publisher's only gate is that
      // `authorizedClientPubkey`, so a direct child is covered by the same send.
      const d = withBackdrop(direct());
      expect(d.bunkerEndpoint?.authorizedClientPubkey).toBe(d.childDevice?.clientPubkey);
      renderHook(() => usePersonaInventoryPublisher({ dependants: [d], relayUrl: RELAY, encryptionKey: 'k' }));
      await waitFor(() => expect(mPublish).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(sent().childTransportPubkey).toBe(CLIENT);
      expect(sent().persona).toMatchObject({ backdropHash: H, backdropKey: K });
      expect(mPublish.mock.calls[0][2]).toEqual([RELAY, RAIL]);
    });

    it('a changed hash, a changed key and a removal each republish', async () => {
      const { rerender } = renderHook(({ deps }) => usePersonaInventoryPublisher({ dependants: deps, relayUrl: RELAY, encryptionKey: 'k' }),
        { initialProps: { deps: [dep()] } });
      await waitFor(() => expect(mPublish).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(sent(0).persona?.backdropHash).toBeUndefined();

      rerender({ deps: [withBackdrop(dep())] });
      await waitFor(() => expect(mPublish).toHaveBeenCalledTimes(2), { timeout: 3000 });
      expect(sent(1).persona?.backdropHash).toBe(H);

      // same bytes re-picked: same hash, new key
      rerender({ deps: [withBackdrop(dep(), bd(H, K2))] });
      await waitFor(() => expect(mPublish).toHaveBeenCalledTimes(3), { timeout: 3000 });
      expect(sent(2).persona?.backdropKey).toBe(K2);

      rerender({ deps: [withBackdrop(dep(), bd(H2, K2))] });
      await waitFor(() => expect(mPublish).toHaveBeenCalledTimes(4), { timeout: 3000 });
      expect(sent(3).persona?.backdropHash).toBe(H2);

      rerender({ deps: [dep({ naturalPersonActive: true })] });
      await waitFor(() => expect(mPublish).toHaveBeenCalledTimes(5), { timeout: 3000 });
      expect(sent(4).persona?.backdropHash).toBeUndefined();
      expect(sent(4).persona?.backdropKey).toBeUndefined();
    });
  });
});
