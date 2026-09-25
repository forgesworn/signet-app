// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useContactsV2 } from './useContactsV2';
import * as db from '../lib/db';
import * as reducer from '../lib/contacts-v2-reducer';
import type { MutationActor } from '../lib/contacts-v2-mutations';

const KEY = 'correct-horse-battery-staple';
const GUARDIAN = '1'.repeat(64);
const OTHER_GUARDIAN = '2'.repeat(64);
const DIR = `dependant:${'b'.repeat(64)}`;
const OTHER_DIR = 'owner';
const TIMEOUT = 45_000;

const actor: MutationActor = { actorPubkey: GUARDIAN, actorRole: 'guardian', actorDeviceId: 'd'.repeat(32) };
const context = { activeGuardianPubkeys: [GUARDIAN, OTHER_GUARDIAN], defaultChildCeiling: 'ken' as const, directoryIsDependant: true };

beforeEach(async () => {
  await db.purgeAllUserData();
});

function render() {
  return renderHook(() => useContactsV2({ directoryId: DIR, encryptionKey: KEY, actor, context }));
}

describe('useContactsV2', () => {
  it('adds a contact, persists one operation and materialises the record', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    let contactId = '';
    await act(async () => {
      contactId = await result.current.addContact({ type: 'person', displayName: 'Dave', tier: 'kith' });
    });

    await waitFor(() => expect(result.current.records).toHaveLength(1));
    expect(result.current.records[0].contactId).toBe(contactId);
    expect(result.current.records[0].displayName).toBe('Dave');
    expect(result.current.effective[0].effectiveTier).toBe('kith');
    expect(result.current.effective[0].tierSource).toBe('direct');

    expect(await db.listContactOperationsV2(DIR, KEY)).toHaveLength(1);
  }, TIMEOUT);

  it('advances the Lamport clock by one per mutation and reloads from storage', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    let contactId = '';
    await act(async () => {
      contactId = await result.current.addContact({ type: 'person', displayName: 'Dave', tier: 'ken' });
    });
    await act(async () => { await result.current.setTier(contactId, 'kin'); });

    const ops = (await db.listContactOperationsV2(DIR, KEY)).sort((a, b) => a.logicalClock - b.logicalClock);
    expect(ops.map(o => [o.action, o.logicalClock])).toEqual([['add', 1], ['set-tier', 2]]);

    const fresh = render();
    await waitFor(() => expect(fresh.result.current.loading).toBe(false));
    await waitFor(() => expect(fresh.result.current.records).toHaveLength(1));
    expect(fresh.result.current.records[0].tier).toBe('kin');
    // A guardian-created contact is not capped by the default child ceiling.
    expect(fresh.result.current.effective[0].effectiveTier).toBe('kin');
  }, TIMEOUT);

  it('blocks a contact and refuses an unblock the actor did not author', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    let contactId = '';
    await act(async () => {
      contactId = await result.current.addContact({ type: 'person', displayName: 'Dave', tier: 'kin' });
    });
    await act(async () => { await result.current.block(contactId, { scope: { kind: 'contact' }, reason: 'bullying' }); });
    await waitFor(() => expect(result.current.effective[0].blocked).toBe(true));
    expect(result.current.effective[0].blockedBy).toEqual([GUARDIAN]);
    const blockOpId = result.current.records[0].blocks[0].operationId;

    // A second guardian's device cannot lift the first guardian's block.
    const foreign = renderHook(() => useContactsV2({
      directoryId: DIR,
      encryptionKey: KEY,
      actor: { ...actor, actorPubkey: OTHER_GUARDIAN },
      context,
    }));
    await waitFor(() => expect(foreign.result.current.loading).toBe(false));
    await act(async () => { await foreign.result.current.unblock(contactId, blockOpId); });
    await waitFor(() => expect(foreign.result.current.records).toHaveLength(1));
    expect(foreign.result.current.effective[0].blocked).toBe(true);

    await act(async () => { await result.current.unblock(contactId, blockOpId); });
    await waitFor(() => expect(result.current.effective[0].blocked).toBe(false));
  }, TIMEOUT);

  it('stays idle without a directory, a key or an actor, and REFUSES a mutation there', async () => {
    const { result } = renderHook(() => useContactsV2({ directoryId: null, encryptionKey: null, actor: null, context }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.records).toEqual([]);

    // I5: a silent no-op reported success for a write that never happened.
    await act(async () => {
      await expect(result.current.addContact({ type: 'person', displayName: 'Nobody', tier: 'ken' }))
        .rejects.toThrow(/add.*contacts scope not ready/);
    });
    expect(result.current.records).toEqual([]);
  }, TIMEOUT);

  it('refuses an operation the reducer would drop instead of returning an id for it', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      // 'boss' is not a tier — validateOperation rejects it.
      await expect(result.current.addContact({ type: 'person', displayName: 'Dave', tier: 'boss' as 'kin' }))
        .rejects.toThrow(/add.*invalid operation/);
    });

    expect(result.current.records).toEqual([]);
    expect(await db.listContactOperationsV2(DIR, KEY)).toHaveLength(0);
  }, TIMEOUT);

  it('clears the previous directory rows and re-enters loading when the directory changes', async () => {
    const { result, rerender } = renderHook(
      (props: { directoryId: string }) => useContactsV2({ ...props, encryptionKey: KEY, actor, context }),
      { initialProps: { directoryId: DIR } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.addContact({ type: 'person', displayName: 'Dave', tier: 'kith' }); });
    await waitFor(() => expect(result.current.records).toHaveLength(1));

    // M7: without the reset, Dave stayed on screen under the OTHER directory's
    // heading until the new load resolved.
    rerender({ directoryId: OTHER_DIR });
    expect(result.current.loading).toBe(true);
    expect(result.current.records).toEqual([]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.records).toEqual([]);
  }, TIMEOUT);
});

describe('useContactsV2 — concurrent mutations (review fix)', () => {
  it('serialises two calls fired without an intervening await so they never share a Lamport clock', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    let ids: string[] = [];
    await act(async () => {
      // No `await` between these two calls — this is exactly the shape that
      // previously let both mutators read the same stale clock.
      ids = await Promise.all([
        result.current.addContact({ type: 'person', displayName: 'A', tier: 'ken' }),
        result.current.addContact({ type: 'person', displayName: 'B', tier: 'ken' }),
      ]);
    });

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);

    await waitFor(() => expect(result.current.records).toHaveLength(2));

    const ops = (await db.listContactOperationsV2(DIR, KEY)).sort((a, b) => a.logicalClock - b.logicalClock);
    expect(ops).toHaveLength(2);
    // Distinct, consecutive Lamport clocks — the reviewer's throwaway test
    // proved both landed at `logicalClock: 1` before this fix.
    expect(ops.map(o => o.logicalClock)).toEqual([1, 2]);
    expect(new Set(ops.map(o => o.contactId))).toEqual(new Set(ids));
  }, TIMEOUT);
});

describe('useContactsV2 — a rejected mutation does not block the queue (review fix)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets the next queued mutation succeed after the first one rejects', async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.spyOn(db, 'saveContactOperationV2').mockRejectedValueOnce(new Error('boom'));

    let secondId = '';
    await act(async () => {
      const first = result.current.addContact({ type: 'person', displayName: 'Fails', tier: 'ken' });
      const second = result.current
        .addContact({ type: 'person', displayName: 'Succeeds', tier: 'ken' })
        .then(id => { secondId = id; });
      await expect(first).rejects.toThrow('boom');
      await second;
    });

    await waitFor(() => expect(result.current.records).toHaveLength(1));
    expect(result.current.records[0].contactId).toBe(secondId);
    expect(result.current.records[0].displayName).toBe('Succeeds');

    const ops = await db.listContactOperationsV2(DIR, KEY);
    expect(ops).toHaveLength(1);
    expect(ops[0].contactId).toBe(secondId);
  }, TIMEOUT);
});

describe('useContactsV2 — onMutated (R3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires once per persisted mutation, and not for one that threw before the write landed', async () => {
    const onMutated = vi.fn();
    const { result } = renderHook(() =>
      useContactsV2({ directoryId: DIR, encryptionKey: KEY, actor, context, onMutated }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.spyOn(db, 'saveContactOperationV2').mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      await expect(
        result.current.addContact({ type: 'person', displayName: 'Fails', tier: 'ken' }),
      ).rejects.toThrow('boom');
    });
    expect(onMutated).not.toHaveBeenCalled();

    let contactId = '';
    await act(async () => {
      contactId = await result.current.addContact({ type: 'person', displayName: 'Dave', tier: 'kith' });
    });
    expect(onMutated).toHaveBeenCalledTimes(1);

    await act(async () => { await result.current.setTier(contactId, 'kin'); });
    expect(onMutated).toHaveBeenCalledTimes(2);
  }, TIMEOUT);

  // M5/R-15: `onMutated` fires once the operation itself is durable — there is
  // no separate record-cache write left to fail after it (the cache row was
  // retired; the reducer rebuilds `records`/`effective` from the log itself).
  it('fires once the operation is durable', async () => {
    const onMutated = vi.fn();
    const { result } = renderHook(() =>
      useContactsV2({ directoryId: DIR, encryptionKey: KEY, actor, context, onMutated }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.addContact({ type: 'person', displayName: 'Dave', tier: 'kith' });
    });

    expect(onMutated).toHaveBeenCalledTimes(1);
    expect(await db.listContactOperationsV2(DIR, KEY)).toHaveLength(1);
  }, TIMEOUT);

  // Fix round 1: `onMutated` sits in a `finally` specifically so a throw from
  // the post-save re-reduce (rebuilding `records`/`effective` from the
  // in-memory log) can't swallow the signal the rail is waiting on — the
  // operation is already durable in storage by the time this step runs.
  it('still fires when the post-save re-reduce throws, since the operation is already durable', async () => {
    const onMutated = vi.fn();
    const { result } = renderHook(() =>
      useContactsV2({ directoryId: DIR, encryptionKey: KEY, actor, context, onMutated }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.spyOn(reducer, 'applyOperations').mockImplementationOnce(() => { throw new Error('reduce boom'); });
    await act(async () => {
      await expect(
        result.current.addContact({ type: 'person', displayName: 'Dave', tier: 'kith' }),
      ).rejects.toThrow('reduce boom');
    });

    expect(onMutated).toHaveBeenCalledTimes(1);
    // The operation itself landed even though the re-reduce failed.
    expect(await db.listContactOperationsV2(DIR, KEY)).toHaveLength(1);
  }, TIMEOUT);
});

it('recognises one key across lists without replacing its shared fields, including concurrent taps', async () => {
  const peer = 'f'.repeat(64);
  const { result, rerender } = renderHook(({ list }) => useContactsV2({
    directoryId: DIR, encryptionKey: KEY, actor, context, ownerIdentityPubkey: list,
  }), { initialProps: { list: GUARDIAN } });
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => {
    await Promise.all([result.current.recogniseContact(peer, 'First'), result.current.recogniseContact(peer, 'Second')]);
  });
  expect(result.current.records).toHaveLength(1);
  expect(result.current.records[0].displayName).toBe('First');
  rerender({ list: OTHER_GUARDIAN });
  await act(async () => { await result.current.recogniseContact(peer, 'Different list'); });
  expect(result.current.records).toHaveLength(1);
  expect(result.current.records[0].displayName).toBe('First');
  expect(result.current.records[0].listMemberships?.map(m => m.ownerIdentityPubkey)).toEqual([GUARDIAN, OTHER_GUARDIAN]);
}, TIMEOUT);

it('persists manual creation and its identity-scoped history in the same batch', async () => {
  const { result } = renderHook(() => useContactsV2({ directoryId: DIR, encryptionKey: KEY, actor, context, ownerIdentityPubkey: GUARDIAN }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  const save = vi.spyOn(db, 'saveContactOperationsV2');
  await act(async () => { await result.current.addContact({ type: 'person', displayName: 'Manual', tier: 'ken' }); });
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0][0].map(op => op.action)).toEqual(['add', 'record-origin']);
  expect(result.current.records[0].origins).toEqual([expect.objectContaining({ method: 'manual', ownerIdentityPubkey: GUARDIAN })]);
  save.mockRestore();
}, TIMEOUT);

it('keeps recognition methods private to each identity without changing existing trust', async () => {
  const { result } = renderHook(() => useContactsV2({ directoryId: DIR, encryptionKey: KEY, actor, context, ownerIdentityPubkey: GUARDIAN }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => {
    const id = await result.current.recogniseContact('e'.repeat(64), 'Peer', GUARDIAN, 'qr');
    await result.current.setTier(id, 'kin');
    await result.current.recogniseContact('e'.repeat(64), 'Peer', OTHER_GUARDIAN, 'nip05');
  });
  expect(result.current.records).toHaveLength(1);
  expect(result.current.records[0].tier).toBe('kin');
  expect(result.current.records[0].origins?.map(o => [o.ownerIdentityPubkey, o.method])).toEqual([[GUARDIAN, 'qr'], [OTHER_GUARDIAN, 'nip05']]);
}, TIMEOUT);

it('edits an existing check without resurrecting a removed check or rebinding another identity’s record', async () => {
  const { result } = renderHook(() => useContactsV2({ directoryId: DIR, encryptionKey: KEY, actor, context, ownerIdentityPubkey: GUARDIAN }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  let contactId = '';
  await act(async () => {
    contactId = await result.current.recogniseContact('e'.repeat(64), 'Peer');
    await result.current.recordCheck(contactId, { identityPubkey: 'e'.repeat(64), method: 'in-person', checkedAt: 100 });
  });
  const check = result.current.records[0].checks![0];
  await act(async () => { await result.current.updateCheck(contactId, { ...check, evidence: 'Edited' }); });
  expect(result.current.records[0].checks).toHaveLength(1);
  expect(result.current.records[0].checks![0].evidence).toBe('Edited');
  await act(async () => { await result.current.removeCheck(contactId, check.id); });
  await act(async () => { await expect(result.current.updateCheck(contactId, check)).rejects.toThrow('no longer available'); });
  expect(result.current.records[0].checks).toEqual([]);
}, TIMEOUT);
