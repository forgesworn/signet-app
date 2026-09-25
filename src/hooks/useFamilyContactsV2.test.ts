// @vitest-environment jsdom
import { StrictMode } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import 'fake-indexeddb/auto';
import { useFamilyContactsV2, type FamilyDirectoryRef } from './useFamilyContactsV2';
import * as db from '../lib/db';
import { saveContactOperationV2, listAllContactOperationsV2, purgeAllUserData } from '../lib/db';
import { buildOperation } from '../lib/contacts-v2-mutations';

const KEY = 'f'.repeat(64);
const GUARDIAN = '1'.repeat(64);
const DEVICE = 'd'.repeat(32);
const OWNER_CID = 'c0'.repeat(16);
const SAM_CID = 'c1'.repeat(16);
const A_CID = 'ca'.repeat(16);
const B_CID = 'cb'.repeat(16);
const actor = { actorPubkey: GUARDIAN, actorRole: 'guardian' as const, actorDeviceId: DEVICE };
const DEP_DIR = `dependant:${'b'.repeat(64)}`;

const directories: FamilyDirectoryRef[] = [
  { directoryId: 'owner', label: 'You', isOwner: true, activeGuardianPubkeys: [GUARDIAN], defaultChildCeiling: 'ken' },
  { directoryId: DEP_DIR, label: 'Sam', isOwner: false, activeGuardianPubkeys: [GUARDIAN], defaultChildCeiling: 'ken' },
];

async function seed() {
  await saveContactOperationV2(buildOperation({
    directoryId: 'owner', contactId: OWNER_CID, action: 'add',
    value: { type: 'person', displayName: 'Dave', tier: 'kin' },
    clock: 1, actor, now: 1_000, operationId: 'aa'.repeat(16),
  }), KEY);
}

describe('useFamilyContactsV2', () => {
  beforeEach(async () => {
    await purgeAllUserData();
  });

  it('loads every directory and resolves each with its own context', async () => {
    await seed();
    const { result } = renderHook(() => useFamilyContactsV2({
      enabled: true, encryptionKey: KEY, actor, directories,
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.directories.map(d => d.directoryId)).toEqual(['owner', DEP_DIR]);
    expect(result.current.directories[0].contacts).toHaveLength(1);
    expect(result.current.directories[0].contacts[0].displayName).toBe('Dave');
    expect(result.current.directories[1].contacts).toEqual([]);
  });

  it('applies a batch of operations and reloads', async () => {
    await seed();
    const { result } = renderHook(() => useFamilyContactsV2({
      enabled: true, encryptionKey: KEY, actor, directories,
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.applyOps([
        { directoryId: DEP_DIR, contactId: SAM_CID, action: 'add', value: { type: 'person', displayName: 'Dave', tier: 'ken' } },
        { directoryId: DEP_DIR, contactId: SAM_CID, action: 'vouch', value: { guardianPubkey: GUARDIAN, tier: 'kin', role: 'Uncle Dave' } },
      ]);
    });

    await waitFor(() => expect(result.current.directories[1].contacts).toHaveLength(1));
    const sam = result.current.directories[1].contacts[0];
    expect(sam.displayName).toBe('Dave');
    expect(sam.effectiveTier).toBe('kin');
    expect(sam.tierSource).toBe('guardian-vouched');

    // Persisted `actorRole` is derived from the DIRECTORY, not copied
    // verbatim from the caller-supplied `actor` — a dependant directory
    // stamps 'guardian' even though `actor.actorRole` here is also
    // 'guardian' (see the owner-directory assertion below, where the ref's
    // `isOwner` flips it to 'owner' despite the same input actor).
    const samOps = (await listAllContactOperationsV2(KEY)).filter(o => o.contactId === SAM_CID);
    expect(samOps.length).toBeGreaterThan(0);
    expect(samOps.every(o => o.actorRole === 'guardian')).toBe(true);
  });

  it('advances the clock across a batch so the operations stay ordered', async () => {
    await seed();
    const { result } = renderHook(() => useFamilyContactsV2({
      enabled: true, encryptionKey: KEY, actor, directories,
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.applyOps([
        { directoryId: 'owner', contactId: OWNER_CID, action: 'rename', value: { displayName: 'Davey' } },
        { directoryId: 'owner', contactId: OWNER_CID, action: 'rename', value: { displayName: 'David' } },
      ]);
    });
    await waitFor(() => expect(result.current.directories[0].contacts[0].displayName).toBe('David'));

    // Owner-directory ops stamp `actorRole: 'owner'`, derived from
    // `directories[0].isOwner`, even though `actor.actorRole` supplied to
    // the hook is 'guardian'.
    const ownerOps = (await listAllContactOperationsV2(KEY))
      .filter(o => o.contactId === OWNER_CID && o.operationId !== 'aa'.repeat(16));
    expect(ownerOps.length).toBeGreaterThan(0);
    expect(ownerOps.every(o => o.actorRole === 'owner')).toBe(true);
  });

  it('stays idle while locked or disabled', async () => {
    const locked = renderHook(() => useFamilyContactsV2({
      enabled: true, encryptionKey: null, actor, directories,
    }));
    await new Promise(r => setTimeout(r, 30));
    expect(locked.result.current.directories.every(d => d.contacts.length === 0)).toBe(true);

    const off = renderHook(() => useFamilyContactsV2({
      enabled: false, encryptionKey: KEY, actor, directories,
    }));
    await new Promise(r => setTimeout(r, 30));
    expect(off.result.current.directories.every(d => d.contacts.length === 0)).toBe(true);
  });

  it('reloads to observe an out-of-band write and seeds the next applyOps clock past it', async () => {
    const { result } = renderHook(() => useFamilyContactsV2({
      enabled: true, encryptionKey: KEY, actor, directories,
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Written directly to storage, bypassing this hook instance entirely —
    // e.g. another tab, or a `useContactsV2` instance acting on the same
    // log. This hook only learns about it via an EXPLICIT `reload()`; it
    // does not poll or subscribe. A batch fired WITHOUT an intervening
    // reload is not guaranteed (and not required) to see clock 500 — every
    // real write path in this app goes through a hook's own
    // `applyOps`/`reload` pair, so that "no reload" case is deliberately
    // not asserted here.
    await saveContactOperationV2(buildOperation({
      directoryId: 'owner', contactId: OWNER_CID, action: 'add',
      value: { type: 'person', displayName: 'Out Of Band', tier: 'ken' },
      clock: 500, actor, now: 2_000, operationId: 'bb'.repeat(16),
    }), KEY);

    await act(async () => { await result.current.reload(); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.directories[0].contacts).toHaveLength(1));

    await act(async () => {
      await result.current.applyOps([
        { directoryId: 'owner', contactId: OWNER_CID, action: 'rename', value: { displayName: 'Next' } },
      ]);
    });

    const allOps = await listAllContactOperationsV2(KEY);
    expect(allOps).toHaveLength(2);
    const applied = allOps.find(o => o.logicalClock !== 500);
    expect(applied).toBeDefined();
    expect(applied!.logicalClock).toBeGreaterThan(500);
  });

  it('resolves reload() to the freshly loaded directories, including a contact saved out-of-band just before the call', async () => {
    const { result } = renderHook(() => useFamilyContactsV2({
      enabled: true, encryptionKey: KEY, actor, directories,
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Same out-of-band write as the previous test, but this time we assert
    // on reload()'s RESOLVED VALUE directly, not on `result.current` after
    // a separate `waitFor` — a caller that plans against the awaited
    // return of `reload()` (rather than the `directories` memo, which is
    // one render behind the state update `reload()` triggers) must see the
    // out-of-band contact synchronously off that same await.
    await saveContactOperationV2(buildOperation({
      directoryId: 'owner', contactId: OWNER_CID, action: 'add',
      value: { type: 'person', displayName: 'Out Of Band', tier: 'ken' },
      clock: 500, actor, now: 2_000, operationId: 'cc'.repeat(16),
    }), KEY);

    let resolved: Awaited<ReturnType<typeof result.current.reload>> = { ok: true, directories: [] };
    await act(async () => { resolved = await result.current.reload(); });

    expect(resolved.ok).toBe(true);
    const owner = resolved.ok ? resolved.directories.find(d => d.directoryId === 'owner') : undefined;
    expect(owner).toBeDefined();
    expect(owner!.contacts.map(c => c.displayName)).toContain('Out Of Band');
  });

  it('persists two concurrent applyOps batches without interleaving their saves', async () => {
    const { result } = renderHook(() => useFamilyContactsV2({
      enabled: true, encryptionKey: KEY, actor, directories,
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Prove serialisation on the ACTUAL persistence calls, not merely on
    // the clocks that come out the other end — a bug that let two batches'
    // saves interleave but happened to still hand out distinct clocks
    // would pass a clocks-only assertion.
    const order: string[] = [];
    const originalSave = db.saveContactOperationV2;
    vi.spyOn(db, 'saveContactOperationV2').mockImplementation(async (op, key) => {
      order.push(`${op.contactId}:start`);
      // A real async gap, so two overlapping `applyOps` calls genuinely
      // COULD interleave here if the hook did not serialise them.
      await new Promise(r => setTimeout(r, 5));
      const out = await originalSave(op, key);
      order.push(`${op.contactId}:end`);
      return out;
    });

    try {
      await act(async () => {
        await Promise.all([
          result.current.applyOps([
            { directoryId: 'owner', contactId: A_CID, action: 'add', value: { type: 'person', displayName: 'A', tier: 'ken' } },
            { directoryId: 'owner', contactId: A_CID, action: 'rename', value: { displayName: 'A2' } },
          ]),
          result.current.applyOps([
            { directoryId: DEP_DIR, contactId: B_CID, action: 'add', value: { type: 'person', displayName: 'B', tier: 'ken' } },
            { directoryId: DEP_DIR, contactId: B_CID, action: 'rename', value: { displayName: 'B2' } },
          ]),
        ]);
      });
    } finally {
      vi.restoreAllMocks();
    }

    // Not interleaved: every save for whichever batch ran first completes
    // before any save for the other batch starts — never
    // A-start, B-start, A-end, B-end.
    const firstContact = order[0].split(':')[0];
    const secondContact = firstContact === A_CID ? B_CID : A_CID;
    expect(order).toEqual([
      `${firstContact}:start`, `${firstContact}:end`,
      `${firstContact}:start`, `${firstContact}:end`,
      `${secondContact}:start`, `${secondContact}:end`,
      `${secondContact}:start`, `${secondContact}:end`,
    ]);

    const allOps = await listAllContactOperationsV2(KEY);
    const clocks = allOps.map(o => o.logicalClock).sort((a, b) => a - b);
    expect(clocks).toHaveLength(4);
    expect(new Set(clocks).size).toBe(4);
    for (let i = 1; i < clocks.length; i++) {
      expect(clocks[i]).toBeGreaterThan(clocks[i - 1]);
    }
  });

  it('survives a React StrictMode mount→cleanup→mount and still reaches loading:false with directories populated', async () => {
    await seed();
    const { result } = renderHook(() => useFamilyContactsV2({
      enabled: true, encryptionKey: KEY, actor, directories,
    }), { wrapper: StrictMode });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.directories[0].contacts).toHaveLength(1);
    expect(result.current.directories[0].contacts[0].displayName).toBe('Dave');
  });

  it('reload() reports ok:false on a genuine read failure — never a bare empty array a caller could mistake for "nothing to strand"', async () => {
    await seed();
    const { result } = renderHook(() => useFamilyContactsV2({
      enabled: true, encryptionKey: KEY, actor, directories,
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.spyOn(db, 'listAllContactOperationsV2').mockRejectedValueOnce(new Error('decrypt failed'));
    let outcome: Awaited<ReturnType<typeof result.current.reload>> = { ok: true, directories: [] };
    await act(async () => { outcome = await result.current.reload(); });
    vi.restoreAllMocks();

    expect(outcome).toEqual({ ok: false });
    expect(result.current.error).toBe('decrypt failed');
  });

  it('fires onMutated after a batch persists at least one operation (R3)', async () => {
    await seed();
    const onMutated = vi.fn();
    const { result } = renderHook(() => useFamilyContactsV2({
      enabled: true, encryptionKey: KEY, actor, directories, onMutated,
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(onMutated).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.applyOps([
        { directoryId: DEP_DIR, contactId: SAM_CID, action: 'add', value: { type: 'person', displayName: 'Dave', tier: 'ken' } },
      ]);
    });

    expect(onMutated).toHaveBeenCalledTimes(1);
  });

  // M5: `onMutated` isn't React state — it must fire for a persisted write
  // even when the hook instance that made it has since unmounted, so the
  // rail (mounted at App level) never misses a signal a component-scoped
  // mountedRef check would have swallowed.
  it('fires onMutated for a batch that finishes persisting after the hook has unmounted', async () => {
    await seed();
    const onMutated = vi.fn();
    const { result, unmount } = renderHook(() => useFamilyContactsV2({
      enabled: true, encryptionKey: KEY, actor, directories, onMutated,
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let releaseGate: () => void = () => {};
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    const spy = vi.spyOn(db, 'saveContactOperationV2').mockImplementationOnce(async (op, key) => {
      await gate;
      return saveContactOperationV2(op, key);
    });

    const applyPromise = result.current.applyOps([
      { directoryId: DEP_DIR, contactId: SAM_CID, action: 'add', value: { type: 'person', displayName: 'Dave', tier: 'ken' } },
    ]);

    unmount();
    releaseGate();
    await applyPromise;

    expect(onMutated).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
