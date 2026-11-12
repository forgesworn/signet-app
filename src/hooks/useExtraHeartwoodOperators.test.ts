// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const db = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
}));
const started = vi.hoisted(() => ({ live: 0, total: 0 }));

vi.mock('../lib/db', () => ({
  readExtraHeartwoodOperators: (k: string) => db.load(k),
  updateExtraHeartwoodOperators: async (k: string, change: (l: unknown[]) => unknown[]) => {
    const next = change(await db.load(k));
    await db.save(next, k);
    return next;
  },
}));
vi.mock('../lib/heartwood-mgmt', () => ({
  HeartwoodMgmtClient: class {
    deviceHex: string;
    constructor(c: { deviceHex: string }) { this.deviceHex = c.deviceHex; }
    start() { started.live++; started.total++; }
    stop() { started.live--; }
  },
}));
vi.mock('../lib/heartwood-operator-import', () => ({
  resolveImportInput: () => ({ kind: 'credential', cred: { skHex: '1'.repeat(64), deviceHex: 'b'.repeat(64), relays: ['wss://r.example'] } }),
  resolvePhraseInput: () => ({ kind: 'error', message: 'unused' }),
}));

import { useExtraHeartwoodOperators } from './useExtraHeartwoodOperators';

describe('useExtraHeartwoodOperators', () => {
  beforeEach(() => {
    db.load.mockReset().mockResolvedValue([]);
    db.save.mockReset();
    started.live = 0;
    started.total = 0;
  });

  it('an import that finishes after the lock starts no operator client', async () => {
    let finishSave!: () => void;
    db.save.mockImplementation(() => new Promise<void>(r => { finishSave = r; }));
    const { result, rerender } = renderHook(
      (p: { encryptionKey: string | null }) => useExtraHeartwoodOperators({ ...p, enabled: !!p.encryptionKey }),
      { initialProps: { encryptionKey: 'k'.repeat(64) as string | null } },
    );
    await act(async () => { await Promise.resolve(); });
    let outcome: Promise<unknown>;
    act(() => { outcome = result.current.importLink('link'); });
    // Lock while the key is being saved (after the stored list was read).
    await act(async () => { await vi.waitFor(() => expect(db.save).toHaveBeenCalled()); });
    rerender({ encryptionKey: null });
    await act(async () => { finishSave(); await outcome; });
    expect(await outcome!).toEqual({ imported: true });
    expect(started.total).toBe(0);
    expect(result.current.clients).toEqual([]);
  });

  it('an import while unlocked starts the client', async () => {
    db.save.mockResolvedValue(undefined);
    const { result } = renderHook(() => useExtraHeartwoodOperators({ encryptionKey: 'k'.repeat(64), enabled: true }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await result.current.importLink('link'); });
    expect(started.live).toBe(1);
    expect(result.current.clients).toHaveLength(1);
  });
});

describe('an import or forget straight after unlock', () => {
  const stored = { skHex: '2'.repeat(64), deviceHex: 'c'.repeat(64), relays: ['wss://r.example'] };
  beforeEach(() => {
    db.load.mockReset();
    db.save.mockReset().mockResolvedValue(undefined);
  });

  it('an import before the unlock load lands keeps the keys already stored', async () => {
    let landLoad!: () => void;
    db.load
      .mockImplementationOnce(() => new Promise(r => { landLoad = () => r([stored]); }))
      .mockResolvedValue([stored]);
    const { result } = renderHook(() => useExtraHeartwoodOperators({ encryptionKey: 'k'.repeat(64), enabled: true }));
    await act(async () => { await result.current.importLink('link'); });
    expect(db.save).toHaveBeenCalledTimes(1);
    expect((db.save.mock.calls[0][0] as { deviceHex: string }[]).map(c => c.deviceHex)).toEqual(['c'.repeat(64), 'b'.repeat(64)]);
    await act(async () => { landLoad(); await Promise.resolve(); });
  });

  it('a forget before the unlock load lands removes only that key from what is stored', async () => {
    const other = { ...stored, deviceHex: 'd'.repeat(64) };
    db.load.mockResolvedValue([stored, other]);
    const { result } = renderHook(() => useExtraHeartwoodOperators({ encryptionKey: 'k'.repeat(64), enabled: true }));
    await act(async () => { await result.current.forget('C'.repeat(64)); });
    expect(db.save.mock.calls.at(-1)?.[0]).toEqual([other]);
    expect(result.current.credentials).toEqual([other]);
  });
});
