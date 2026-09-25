// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useContactsV2Reimport, DEBOUNCE_MS } from './useContactsV2Reimport';
import { listContactOperationsV2, purgeAllUserData } from '../lib/db';
import * as db from '../lib/db';
import type { ImportDependantRef } from '../lib/contacts-v2-import';
import type { Contact } from '../types';
import type { KenEntry } from '@forgesworn/kenspeckle';

const KEY = 'f'.repeat(64);
const OWNER = '1'.repeat(64);
const PEER = '2'.repeat(64);
const PEER2 = '3'.repeat(64);

// Stable references (not fresh literals per render): the hook re-runs on
// ARRAY IDENTITY change (by design — see the hook's own docstring), and
// `renderHook` re-invokes its callback on every state update the hook itself
// causes (e.g. `setRuns`), not just on an explicit `rerender()`. A fresh `[]`
// literal built inline in that callback would look like a genuine prop change
// on every one of those self-triggered re-renders and spuriously re-fire the
// debounced import forever, racing the deliberate `rerender()` below.
const OWNER_PUBKEYS = [OWNER];
const NO_DEPS: ImportDependantRef[] = [];
const NO_KENS: KenEntry[] = [];

function contact(pubkey: string, name: string): Contact {
  return {
    pubkey, ownerPubkey: OWNER, displayName: name,
    sharedSecret: 'deadbeef', verifiedAt: 1_700, relationship: 'other',
  } as Contact;
}

describe('useContactsV2Reimport', () => {
  beforeEach(async () => {
    await purgeAllUserData();
  });

  it('imports the legacy rows it is given', async () => {
    const contacts = [contact(PEER, 'Dave')];
    const { result } = renderHook(() => useContactsV2Reimport({
      enabled: true, encryptionKey: KEY, deviceId: 'd'.repeat(32), actorPubkey: OWNER,
      ownerPubkeys: OWNER_PUBKEYS, dependants: NO_DEPS, contacts, kens: NO_KENS,
    }));
    await waitFor(() => expect(result.current.runs).toBeGreaterThan(0));
    const ops = await listContactOperationsV2('owner', KEY);
    expect(ops.length).toBeGreaterThan(0);
  });

  it('re-runs when the legacy array changes and adds only the new row', async () => {
    const onImported = vi.fn();
    const first = [contact(PEER, 'Dave')];
    const { result, rerender } = renderHook(
      (props: { contacts: Contact[] }) => useContactsV2Reimport({
        enabled: true, encryptionKey: KEY, deviceId: 'd'.repeat(32), actorPubkey: OWNER,
        ownerPubkeys: OWNER_PUBKEYS, dependants: NO_DEPS, contacts: props.contacts, kens: NO_KENS,
        onImported,
      }),
      { initialProps: { contacts: first } },
    );
    await waitFor(() => expect(result.current.runs).toBe(1));
    const afterFirst = await listContactOperationsV2('owner', KEY);

    rerender({ contacts: [...first, contact(PEER2, 'Amy')] });
    await waitFor(() => expect(result.current.runs).toBe(2));
    const afterSecond = await listContactOperationsV2('owner', KEY);
    expect(afterSecond.length).toBeGreaterThan(afterFirst.length);
    expect(onImported).toHaveBeenCalled();
  });

  it('I1: coalesces a change that lands mid-run into exactly one more run (2 total, not 1 or 3)', async () => {
    // Blocks the FIRST call to `listContactImportSources` (the run's very
    // first await) until the test releases it, so the "in flight" window is
    // deterministic rather than relying on real PBKDF2 timing under load.
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    let calls = 0;
    const spy = vi.spyOn(db, 'listContactImportSources').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await gate;
      return [];
    });

    const first = [contact(PEER, 'Dave')];
    const { result, rerender } = renderHook(
      (props: { contacts: Contact[] }) => useContactsV2Reimport({
        enabled: true, encryptionKey: KEY, deviceId: 'd'.repeat(32), actorPubkey: OWNER,
        ownerPubkeys: OWNER_PUBKEYS, dependants: NO_DEPS, contacts: props.contacts, kens: NO_KENS,
      }),
      { initialProps: { contacts: first } },
    );

    // The first run has started (past its debounce) and is now blocked
    // in-flight on the gate.
    await waitFor(() => expect(calls).toBe(1));
    expect(result.current.runs).toBe(0);

    // A change lands while that run is still in flight. Its own debounced
    // attempt (DEBOUNCE_MS later) hits the in-flight guard and coalesces
    // into `pendingRef` rather than starting a second concurrent run.
    rerender({ contacts: [...first, contact(PEER2, 'Amy')] });
    await new Promise(r => setTimeout(r, DEBOUNCE_MS + 150));
    expect(calls).toBe(1);
    expect(result.current.runs).toBe(0);

    // Let the first run finish — its `finally` should immediately fire the
    // coalesced second run (no further debounce wait needed).
    releaseGate();
    await waitFor(() => expect(result.current.runs).toBe(2));
    expect(calls).toBe(2);

    // No stray third run turns up later (the rerender's own timer already
    // fired and was consumed into the coalesce, not left pending).
    await new Promise(r => setTimeout(r, DEBOUNCE_MS + 150));
    expect(result.current.runs).toBe(2);
    expect(calls).toBe(2);

    spy.mockRestore();
  });

  it('fix round 2: a run gated in flight when the hook unmounts does not call onImported or warn', async () => {
    // Blocks the run's very first await, same technique as the I1 test, so
    // "unmount while genuinely in flight" is deterministic.
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    let calls = 0;
    const spy = vi.spyOn(db, 'listContactImportSources').mockImplementation(async () => {
      calls += 1;
      await gate;
      return [];
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const onImported = vi.fn();
    const contacts = [contact(PEER, 'Dave')];
    const { unmount } = renderHook(() => useContactsV2Reimport({
      enabled: true, encryptionKey: KEY, deviceId: 'd'.repeat(32), actorPubkey: OWNER,
      ownerPubkeys: OWNER_PUBKEYS, dependants: NO_DEPS, contacts, kens: NO_KENS,
      onImported,
    }));

    // The run has started (past its debounce) and is blocked in flight.
    await waitFor(() => expect(calls).toBe(1));

    unmount();

    // Let the blocked run finish AFTER the hook is gone.
    releaseGate();
    await new Promise(r => setTimeout(r, 200));

    expect(onImported).not.toHaveBeenCalled();
    // No React "not wrapped in act(...)" / unmounted-update warning — the
    // `aliveRef` guard must stop `setRuns` from firing post-cleanup.
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    spy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('fix round 2: a run gated in flight when `enabled` flips to false does not call onImported or warn', async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    let calls = 0;
    const spy = vi.spyOn(db, 'listContactImportSources').mockImplementation(async () => {
      calls += 1;
      await gate;
      return [];
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const onImported = vi.fn();
    const contacts = [contact(PEER, 'Dave')];
    const { result, rerender } = renderHook(
      (props: { enabled: boolean }) => useContactsV2Reimport({
        enabled: props.enabled, encryptionKey: KEY, deviceId: 'd'.repeat(32), actorPubkey: OWNER,
        ownerPubkeys: OWNER_PUBKEYS, dependants: NO_DEPS, contacts, kens: NO_KENS,
        onImported,
      }),
      { initialProps: { enabled: true } },
    );

    await waitFor(() => expect(calls).toBe(1));

    // Locks mid-run: `enabled` flips false, same as App.tsx's gate does.
    rerender({ enabled: false });

    releaseGate();
    await new Promise(r => setTimeout(r, 200));

    expect(onImported).not.toHaveBeenCalled();
    expect(result.current.runs).toBe(0);
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    spy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  // I3: one PBKDF2 derivation for the whole import batch instead of one per
  // operation — the hook must route through the bulk save, never the per-op
  // one (proven at the db layer in db-contacts-v2.test.ts).
  it('saves a multi-row import with one saveContactOperationsV2 call, never the per-op save', async () => {
    const bulkSpy = vi.spyOn(db, 'saveContactOperationsV2');
    const perOpSpy = vi.spyOn(db, 'saveContactOperationV2');
    const contacts = [contact(PEER, 'Dave'), contact(PEER2, 'Amy')];

    const { result } = renderHook(() => useContactsV2Reimport({
      enabled: true, encryptionKey: KEY, deviceId: 'd'.repeat(32), actorPubkey: OWNER,
      ownerPubkeys: OWNER_PUBKEYS, dependants: NO_DEPS, contacts, kens: NO_KENS,
    }));
    await waitFor(() => expect(result.current.runs).toBe(1));

    expect(bulkSpy).toHaveBeenCalledTimes(1);
    expect(bulkSpy.mock.calls[0][0].length).toBeGreaterThan(1);
    expect(perOpSpy).not.toHaveBeenCalled();

    bulkSpy.mockRestore();
    perOpSpy.mockRestore();
  });

  it('does nothing while locked', async () => {
    const contacts = [contact(PEER, 'Dave')];
    const { result } = renderHook(() => useContactsV2Reimport({
      enabled: true, encryptionKey: null, deviceId: 'd'.repeat(32), actorPubkey: OWNER,
      ownerPubkeys: OWNER_PUBKEYS, dependants: NO_DEPS, contacts, kens: NO_KENS,
    }));
    await new Promise(r => setTimeout(r, 50));
    expect(result.current.runs).toBe(0);
  });

  it('does nothing when disabled', async () => {
    const contacts = [contact(PEER, 'Dave')];
    const { result } = renderHook(() => useContactsV2Reimport({
      enabled: false, encryptionKey: KEY, deviceId: 'd'.repeat(32), actorPubkey: OWNER,
      ownerPubkeys: OWNER_PUBKEYS, dependants: NO_DEPS, contacts, kens: NO_KENS,
    }));
    await new Promise(r => setTimeout(r, 50));
    expect(result.current.runs).toBe(0);
  });
});
