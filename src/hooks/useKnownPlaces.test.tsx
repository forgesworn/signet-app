// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useKnownPlaces } from './useKnownPlaces';
import * as db from '../lib/db';
import type { KnownPlaceInput } from '../types';

const PK = 'a'.repeat(64);

const input = (over: Partial<KnownPlaceInput> = {}): KnownPlaceInput => ({
  placeKey: 'https://x.example',
  pubkey: PK,
  kind: 'sign-in',
  name: 'X',
  origin: 'https://x.example',
  channel: 'browser',
  signer: 'local',
  shared: {},
  ...over,
});

beforeEach(async () => {
  await db.purgeAllUserData();
});

describe('useKnownPlaces', () => {
  it('starts loading and empty, then settles', async () => {
    const { result } = renderHook(() => useKnownPlaces('key'));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.places).toEqual([]);
  });

  it('record, alias, pin and forget flow through to state', async () => {
    const { result } = renderHook(() => useKnownPlaces('key'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.record(input()); });
    await waitFor(() => expect(result.current.places).toHaveLength(1));
    const id = result.current.places[0].id;
    await act(async () => { await result.current.setAlias(id, 'Mine'); });
    await act(async () => { await result.current.setPinned(id, true); });
    await waitFor(() => expect(result.current.places[0]).toMatchObject({ alias: 'Mine', pinned: true }));
    await act(async () => { await result.current.forget(id); });
    await waitFor(() => expect(result.current.places).toHaveLength(0));
  });

  it('forgetPlace removes the place for every identity', async () => {
    const { result } = renderHook(() => useKnownPlaces('key'));
    await act(async () => {
      await result.current.record(input());
      await result.current.record(input({ pubkey: 'b'.repeat(64) }));
    });
    await waitFor(() => expect(result.current.places).toHaveLength(2));
    await act(async () => { await result.current.forgetPlace('https://x.example'); });
    await waitFor(() => expect(result.current.places).toHaveLength(0));
  });

  it('picks up a write made outside the hook (NIP-46 / NIP-55 writers)', async () => {
    const { result } = renderHook(() => useKnownPlaces('key'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await db.upsertKnownPlace(input({ placeKey: 'pkg:com.x', kind: 'nip55', channel: 'nip55' })); });
    await waitFor(() => expect(result.current.places.map(p => p.placeKey)).toEqual(['pkg:com.x']));
  });

  it('reloads when the encryption key flips, even without an emitter event', async () => {
    const { result, rerender } = renderHook(({ k }) => useKnownPlaces(k), { initialProps: { k: null as string | null } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    // A row that landed while no subscriber could see it (e.g. written by a restore).
    const raw = await db.getDb();
    await raw.put('knownPlaces', {
      id: `https://late.example:${PK}`, pubkey: PK, placeKey: 'https://late.example', kind: 'sign-in',
      name: 'Late', channel: 'unknown', signer: 'unknown', firstAt: 1, lastAt: 1, uses: 1, shared: {},
    });
    expect(result.current.places).toHaveLength(0);
    rerender({ k: 'unlocked' });
    await waitFor(() => expect(result.current.places).toHaveLength(1));
  });
});
