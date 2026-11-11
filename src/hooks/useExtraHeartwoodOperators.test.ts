// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const db = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
}));
const started = vi.hoisted(() => ({ live: 0, total: 0 }));

vi.mock('../lib/db', () => ({
  loadExtraHeartwoodOperators: db.load,
  saveExtraHeartwoodOperators: db.save,
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
    // Lock while the key is being saved.
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
