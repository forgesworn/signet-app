// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const sync = vi.hoisted(() => ({ calls: [] as Array<{ identity: unknown; isLive: () => boolean }> }));
vi.mock('../lib/guardian-backdrop-sync', async (orig) => ({
  ...await orig<typeof import('../lib/guardian-backdrop-sync')>(),
  defaultGuardianBackdropDeps: (isLive: () => boolean) => ({ isLive }),
  syncGuardianBackdrops: vi.fn(async (identity: unknown, deps: { isLive: () => boolean }) => { sync.calls.push({ identity, isLive: deps.isLive }); }),
}));

import { useGuardianBackdrops } from './useGuardianBackdrops';

const PK = 'a'.repeat(64);
const ident = (hash?: string) => ({
  id: PK, naturalPerson: { publicKey: '' },
  persona: { publicKey: PK, ...(hash ? { backdropHash: hash, backdropBlossomUrl: 'https://x.example', backdropKey: 'k'.repeat(64) } : {}) },
});

beforeEach(() => { sync.calls.length = 0; });

describe('useGuardianBackdrops', () => {
  it('never runs when disabled (a guardian\'s install, or locked)', () => {
    renderHook(() => useGuardianBackdrops({ enabled: false, identity: ident('1'.repeat(64)) }));
    expect(sync.calls).toHaveLength(0);
  });

  it('runs once when enabled, and not on a re-render with the same pointers', () => {
    const { rerender } = renderHook(({ id }) => useGuardianBackdrops({ enabled: true, identity: id }), { initialProps: { id: ident('1'.repeat(64)) } });
    expect(sync.calls).toHaveLength(1);
    rerender({ id: ident('1'.repeat(64)) });
    expect(sync.calls).toHaveLength(1);
  });

  it('runs again when a pointer changes, and when an inventory merge lands with nothing changed (retry)', () => {
    const { rerender } = renderHook(({ id, n }) => useGuardianBackdrops({ enabled: true, identity: id, mergeCount: n }), { initialProps: { id: ident('1'.repeat(64)), n: 0 } });
    rerender({ id: ident('2'.repeat(64)), n: 0 });
    expect(sync.calls).toHaveLength(2);
    rerender({ id: ident('2'.repeat(64)), n: 1 });
    expect(sync.calls).toHaveLength(3);
  });

  it('cancels the run at lock or unmount', () => {
    const { rerender, unmount } = renderHook(({ on }) => useGuardianBackdrops({ enabled: on, identity: ident('1'.repeat(64)) }), { initialProps: { on: true } });
    const first = sync.calls[0];
    expect(first.isLive()).toBe(true);
    rerender({ on: false });
    expect(first.isLive()).toBe(false);
    rerender({ on: true });
    const second = sync.calls[1];
    unmount();
    expect(second.isLive()).toBe(false);
  });
});
