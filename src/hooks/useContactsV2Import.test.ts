// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useContactsV2Import } from './useContactsV2Import';
import * as db from '../lib/db';

const KEY = 'correct-horse-battery-staple';
const OWNER_NP = 'a'.repeat(64);
const DEP_NP = 'c'.repeat(64);
const PEER_1 = '1'.repeat(64);
const PEER_2 = '2'.repeat(64);
const TIMEOUT = 45_000;
const DEP_DIR = `dependant:${'b'.repeat(64)}`;

const options = {
  enabled: true,
  encryptionKey: KEY,
  deviceId: 'd'.repeat(32),
  actorPubkey: OWNER_NP,
  ownerPubkeys: [OWNER_NP],
  dependants: [{ directoryId: DEP_DIR, slotPubkeys: [DEP_NP] }],
};

beforeEach(async () => {
  await db.purgeAllUserData();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useContactsV2Import', () => {
  it('imports the legacy stores once and routes rows to their directories', async () => {
    await db.saveContact({ pubkey: PEER_1, ownerPubkey: OWNER_NP, displayName: 'Dave', sharedSecret: 'deadbeef', verifiedAt: 1_700 }, KEY);
    await db.saveContact({ pubkey: PEER_2, ownerPubkey: DEP_NP, displayName: 'Charlie', sharedSecret: 'beefdead', verifiedAt: 1_750, relationship: 'sibling' }, KEY);

    const { result } = renderHook(() => useContactsV2Import(options));
    await waitFor(() => expect(result.current.status).toBe('done'), { timeout: 20_000 });

    expect(result.current.result).toEqual({ imported: 2, skipped: 0, quarantined: 0, operations: 8 });
    expect(await db.listContactOperationsV2('owner', KEY)).toHaveLength(4);
    expect(await db.listContactOperationsV2(DEP_DIR, KEY)).toHaveLength(4);
    expect((await db.listContactImportSources()).sort()).toEqual([`contact:${PEER_1}`, `contact:${PEER_2}`].sort());
  }, TIMEOUT);

  it('is a no-op on a second mount', async () => {
    await db.saveContact({ pubkey: PEER_1, ownerPubkey: OWNER_NP, displayName: 'Dave', sharedSecret: 'deadbeef', verifiedAt: 1_700 }, KEY);

    const first = renderHook(() => useContactsV2Import(options));
    await waitFor(() => expect(first.result.current.status).toBe('done'), { timeout: 20_000 });

    const second = renderHook(() => useContactsV2Import(options));
    await waitFor(() => expect(second.result.current.status).toBe('done'), { timeout: 20_000 });
    expect(second.result.current.result).toEqual({ imported: 0, skipped: 1, quarantined: 0, operations: 0 });
    // Each import entry produces 4 ops (add, identity, list and history) — see test 1's
    // own owner/dependant assertions. The second mount is a no-op (0 new
    // operations), so the count left over from the first mount stays 4.
    expect(await db.listContactOperationsV2('owner', KEY)).toHaveLength(4);
  }, TIMEOUT);

  it('does not retry a failing import on a re-render with new array identities and the same key', async () => {
    const getAllContactsSpy = vi.spyOn(db, 'getAllContacts').mockRejectedValue(new Error('boom'));

    const { result, rerender } = renderHook(
      (props: typeof options) => useContactsV2Import(props),
      {
        initialProps: { ...options, ownerPubkeys: [...options.ownerPubkeys], dependants: [...options.dependants] },
      },
    );
    await waitFor(() => expect(result.current.status).toBe('error'), { timeout: 20_000 });
    expect(getAllContactsSpy).toHaveBeenCalledTimes(1);

    // Same encryptionKey, but brand-new array identities for ownerPubkeys/
    // dependants — as App.tsx would produce without useMemo. The latch must
    // hold: a retry needs a NEW encryptionKey (the next unlock), not a
    // re-render.
    rerender({ ...options, ownerPubkeys: [...options.ownerPubkeys], dependants: [...options.dependants] });
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(result.current.status).toBe('error');
    expect(getAllContactsSpy).toHaveBeenCalledTimes(1);
  }, TIMEOUT);

  // I3: one PBKDF2 derivation for the whole import batch (proven at the
  // db layer in db-contacts-v2.test.ts's "derives the key once per batch
  // call" test) instead of one per operation — the hook must route through
  // the bulk save, never the per-op one.
  it('saves the whole import batch with one saveContactOperationsV2 call, never the per-op save', async () => {
    await db.saveContact({ pubkey: PEER_1, ownerPubkey: OWNER_NP, displayName: 'Dave', sharedSecret: 'deadbeef', verifiedAt: 1_700 }, KEY);
    await db.saveContact({ pubkey: PEER_2, ownerPubkey: DEP_NP, displayName: 'Charlie', sharedSecret: 'beefdead', verifiedAt: 1_750, relationship: 'sibling' }, KEY);

    const bulkSpy = vi.spyOn(db, 'saveContactOperationsV2');
    const perOpSpy = vi.spyOn(db, 'saveContactOperationV2');

    const { result } = renderHook(() => useContactsV2Import(options));
    await waitFor(() => expect(result.current.status).toBe('done'), { timeout: 20_000 });

    expect(result.current.result?.operations).toBe(8);
    expect(bulkSpy).toHaveBeenCalledTimes(1);
    expect(bulkSpy.mock.calls[0][0]).toHaveLength(8);
    expect(perOpSpy).not.toHaveBeenCalled();
  }, TIMEOUT);

  it('stays idle while locked or unconfigured', async () => {
    const locked = renderHook(() => useContactsV2Import({ ...options, encryptionKey: null }));
    const noDevice = renderHook(() => useContactsV2Import({ ...options, deviceId: null }));
    const disabled = renderHook(() => useContactsV2Import({ ...options, enabled: false }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(locked.result.current.status).toBe('idle');
    expect(noDevice.result.current.status).toBe('idle');
    expect(disabled.result.current.status).toBe('idle');
    expect(await db.listContactImportSources()).toEqual([]);
  }, TIMEOUT);
});

it('finishes an in-flight import when hydration rebuilds equivalent input arrays', async () => {
  let finish!: (rows: Awaited<ReturnType<typeof db.getAllContacts>>) => void;
  vi.spyOn(db, 'getAllContacts').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { result, rerender, unmount } = renderHook((props: typeof options) => useContactsV2Import(props), { initialProps: options });
  await waitFor(() => expect(result.current.status).toBe('running'));
  rerender({ ...options, ownerPubkeys: [...options.ownerPubkeys], dependants: [...options.dependants] });
  finish([]);
  await waitFor(() => expect(result.current.status).toBe('done'));
  expect(db.getAllContacts).toHaveBeenCalledTimes(1);
  unmount();
});
