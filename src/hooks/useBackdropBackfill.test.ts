// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useBackdropBackfill, type UseBackdropBackfillOpts } from './useBackdropBackfill';
import type { DependantBackdropLink, DependantBackdropLookup } from '../lib/backdrop-send-context';

const PK = 'a'.repeat(64);
const blob = new Blob(['pic'], { type: 'image/jpeg' });

function mkLookup(send: DependantBackdropLink['send']): DependantBackdropLookup {
  return pk => (pk === PK ? { name: 'Lily', canSend: true, unlocked: true, sent: false, slotKey: 'hook-dep:persona', send, remove: async () => undefined } : null);
}

function setup(over: Partial<UseBackdropBackfillOpts> = {}) {
  const send = vi.fn(async () => ({ ok: true as const }));
  const base: UseBackdropBackfillOpts = {
    enabled: true, encryptionKey: 'k1', slotPubkeys: [PK], lookup: mkLookup(send),
    readLocal: async () => blob, digest: async () => 'd'.repeat(64), ...over,
  };
  const hook = renderHook((p: UseBackdropBackfillOpts) => useBackdropBackfill(p), { initialProps: base });
  return { send, hook, base };
}

describe('useBackdropBackfill', () => {
  it('sends the unsent slot once after the dependants load, and not again when they reload', async () => {
    const { send, hook, base } = setup();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith(blob, { backfill: { generation: expect.any(Number) } });
    hook.rerender({ ...base, lookup: mkLookup(send), slotPubkeys: [PK] });
    await new Promise(r => setTimeout(r, 30));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does nothing while disabled (paired-child install, no consent, locked, dependants not loaded)', async () => {
    const { send, hook, base } = setup({ enabled: false });
    await new Promise(r => setTimeout(r, 30));
    expect(send).not.toHaveBeenCalled();
    hook.rerender({ ...base, enabled: true, encryptionKey: null });
    await new Promise(r => setTimeout(r, 30));
    expect(send).not.toHaveBeenCalled();
  });

  it('a new unlock tries again, a lock in between forgets what was tried', async () => {
    const { send, hook, base } = setup();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    hook.rerender({ ...base, encryptionKey: null });
    hook.rerender({ ...base, encryptionKey: 'k2', lookup: mkLookup(send) });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  });
});
