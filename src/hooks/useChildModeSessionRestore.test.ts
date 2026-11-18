// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useChildModeSessionRestore, type ChildModeSessionRestoreInput } from './useChildModeSessionRestore';

function setup(overrides: Partial<ChildModeSessionRestoreInput> = {}, session: { activeDependantId: string } | null = { activeDependantId: 'dep-1' }) {
  const onRestore = vi.fn();
  const onDrop = vi.fn();
  const loadSession = vi.fn(async () => session);
  const clearSession = vi.fn(async () => {});
  const restoredRef = { current: false };
  const base: ChildModeSessionRestoreInput = {
    ready: true,
    unlocked: true,
    dependantIds: [],
    dependantsLoadedWithKey: false,
    childModeLive: false,
    restoredRef,
    onRestore,
    onDrop,
    loadSession,
    clearSession,
  };
  const hook = renderHook((props: ChildModeSessionRestoreInput) => useChildModeSessionRestore(props), {
    initialProps: { ...base, ...overrides },
  });
  const update = (next: Partial<ChildModeSessionRestoreInput>) =>
    hook.rerender({ ...base, ...overrides, ...next });
  return { onRestore, onDrop, loadSession, clearSession, restoredRef: overrides.restoredRef ?? restoredRef, hook, update };
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('useChildModeSessionRestore', () => {
  it('does nothing while locked or not ready', async () => {
    const locked = setup({ unlocked: false });
    const notReady = setup({ ready: false });
    await flush();
    expect(locked.loadSession).not.toHaveBeenCalled();
    expect(notReady.loadSession).not.toHaveBeenCalled();
  });

  it('restores once when the saved dependant is present', async () => {
    const t = setup({ dependantIds: ['dep-1'], dependantsLoadedWithKey: true });
    await waitFor(() => expect(t.onRestore).toHaveBeenCalledWith('dep-1'));
    expect(t.onRestore).toHaveBeenCalledTimes(1);
    expect(t.clearSession).not.toHaveBeenCalled();
    expect(t.onDrop).not.toHaveBeenCalled();
    expect(t.restoredRef.current).toBe(true);
  });

  it('waits on a keyless read, then clears a session whose dependant is absent after the keyed read', async () => {
    const t = setup({ dependantIds: [], dependantsLoadedWithKey: false });
    await waitFor(() => expect(t.loadSession).toHaveBeenCalledTimes(1));
    await flush();
    expect(t.onRestore).not.toHaveBeenCalled();
    expect(t.clearSession).not.toHaveBeenCalled();
    expect(t.onDrop).not.toHaveBeenCalled();
    expect(t.restoredRef.current).toBe(false);

    t.update({ dependantIds: [], dependantsLoadedWithKey: true });
    await waitFor(() => expect(t.clearSession).toHaveBeenCalledTimes(1));
    expect(t.onDrop).toHaveBeenCalledTimes(1);
    expect(t.onRestore).not.toHaveBeenCalled();
    expect(t.restoredRef.current).toBe(true);
  });

  it('a dependant merged in by a later sync does not bring the dropped session back', async () => {
    const t = setup({ dependantIds: [], dependantsLoadedWithKey: false });
    await waitFor(() => expect(t.loadSession).toHaveBeenCalledTimes(1));
    t.update({ dependantIds: [], dependantsLoadedWithKey: true });
    await waitFor(() => expect(t.clearSession).toHaveBeenCalledTimes(1));

    t.update({ dependantIds: ['dep-1'], dependantsLoadedWithKey: true });
    await flush();
    t.update({ dependantIds: ['dep-1', 'dep-2'], dependantsLoadedWithKey: true });
    await flush();
    expect(t.onRestore).not.toHaveBeenCalled();
    expect(t.clearSession).toHaveBeenCalledTimes(1);
    expect(t.onDrop).toHaveBeenCalledTimes(1);
    expect(t.loadSession).toHaveBeenCalledTimes(2); // the keyed-read rerun only; nothing after it
  });

  it('with no saved session, drops and marks the restore handled', async () => {
    const t = setup({}, null);
    await waitFor(() => expect(t.onDrop).toHaveBeenCalledTimes(1));
    expect(t.restoredRef.current).toBe(true);
    expect(t.onRestore).not.toHaveBeenCalled();
    expect(t.clearSession).not.toHaveBeenCalled();
  });

  it('never reads the session once the restore is already handled', async () => {
    const t = setup({ restoredRef: { current: true } });
    await flush();
    t.update({ dependantIds: ['dep-1'], dependantsLoadedWithKey: true });
    await flush();
    t.update({ dependantIds: ['dep-1', 'dep-2'] });
    await flush();
    expect(t.loadSession).not.toHaveBeenCalled();
    expect(t.onRestore).not.toHaveBeenCalled();
    expect(t.onDrop).not.toHaveBeenCalled();
  });

  it('never clears while child mode is live', async () => {
    const t = setup({ childModeLive: true, dependantIds: [], dependantsLoadedWithKey: true });
    await waitFor(() => expect(t.loadSession).toHaveBeenCalledTimes(1));
    await flush();
    expect(t.clearSession).not.toHaveBeenCalled();
    expect(t.onDrop).not.toHaveBeenCalled();
    expect(t.onRestore).not.toHaveBeenCalled();
  });

  it('does not re-read when a new array carries the same ids', async () => {
    const t = setup({ dependantIds: ['a'], dependantsLoadedWithKey: false }, { activeDependantId: 'zzz' });
    await waitFor(() => expect(t.loadSession).toHaveBeenCalledTimes(1));
    t.update({ dependantIds: ['a'], dependantsLoadedWithKey: false });
    await flush();
    expect(t.loadSession).toHaveBeenCalledTimes(1);
  });

  it('a superseded run does nothing; only the latest run decides', async () => {
    const resolvers: Array<(s: { activeDependantId: string } | null) => void> = [];
    const loadSession = vi.fn(() => new Promise<{ activeDependantId: string } | null>(res => { resolvers.push(res); }));
    const t = setup({ loadSession, dependantIds: ['dep-1'], dependantsLoadedWithKey: true });
    await waitFor(() => expect(loadSession).toHaveBeenCalledTimes(1));

    // Inputs change before the first read resolves: a second run starts.
    t.update({ loadSession, dependantIds: ['dep-1', 'dep-2'], dependantsLoadedWithKey: true });
    await waitFor(() => expect(loadSession).toHaveBeenCalledTimes(2));

    // The first (stale) run resolves first: its decision must not apply.
    await act(async () => { resolvers[0]({ activeDependantId: 'dep-1' }); await Promise.resolve(); });
    expect(t.onRestore).not.toHaveBeenCalled();
    expect(t.restoredRef.current).toBe(false);

    await act(async () => { resolvers[1]({ activeDependantId: 'dep-2' }); await Promise.resolve(); });
    await waitFor(() => expect(t.onRestore).toHaveBeenCalledTimes(1));
    expect(t.onRestore).toHaveBeenCalledWith('dep-2');
    expect(t.clearSession).not.toHaveBeenCalled();
  });

  it('a superseded run never clears the session', async () => {
    const resolvers: Array<(s: { activeDependantId: string } | null) => void> = [];
    const loadSession = vi.fn(() => new Promise<{ activeDependantId: string } | null>(res => { resolvers.push(res); }));
    const t = setup({ loadSession, dependantIds: [], dependantsLoadedWithKey: true });
    await waitFor(() => expect(loadSession).toHaveBeenCalledTimes(1));
    t.update({ loadSession, dependantIds: ['dep-1'], dependantsLoadedWithKey: true });
    await waitFor(() => expect(loadSession).toHaveBeenCalledTimes(2));

    // The first run saw no dependant and would clear; it was superseded.
    await act(async () => { resolvers[0]({ activeDependantId: 'dep-1' }); await Promise.resolve(); });
    expect(t.clearSession).not.toHaveBeenCalled();
    expect(t.onDrop).not.toHaveBeenCalled();

    await act(async () => { resolvers[1]({ activeDependantId: 'dep-1' }); await Promise.resolve(); });
    await waitFor(() => expect(t.onRestore).toHaveBeenCalledTimes(1));
    expect(t.clearSession).not.toHaveBeenCalled();
  });
});
