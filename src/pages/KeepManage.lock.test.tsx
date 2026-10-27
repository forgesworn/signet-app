// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { StoredKeep } from '../lib/keep-store';

const secret = { keep: 'ab'.repeat(32), name: 'Secret kitchen', relays: ['wss://r.example'], claimedBy: 'cd'.repeat(32), personas: ['cd'.repeat(32)] } as unknown as StoredKeep;
const watcher = vi.hoisted(() => ({ onChange: null as null | ((list: unknown[]) => void), stop: vi.fn() }));
vi.mock('../lib/keep-service', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/keep-service')>(),
  loadStoredKeeps: async () => [secret],
  catchUp: async () => [secret],
  watchAcks: (_deps: unknown, _keeps: unknown, onChange: (list: unknown[]) => void) => { watcher.onChange = onChange; return watcher.stop; },
}));

import { useStoredKeeps, type KeepHost } from './KeepManage';

let seen: StoredKeep[] = [];
function Probe({ host }: { host?: KeepHost }) {
  seen = useStoredKeeps(host).keeps;
  return null;
}
const host = { deps: { encryptionKey: 'key', backendFor: () => null } } as unknown as KeepHost;

afterEach(cleanup);

describe('useStoredKeeps and the lock', () => {
  it('clears the Keeps when the key goes, and ignores an ack list that arrives after that', async () => {
    const { rerender } = render(<Probe host={host} />);
    await waitFor(() => expect(seen).toHaveLength(1));
    await waitFor(() => expect(watcher.onChange).not.toBeNull());
    const late = watcher.onChange!;
    rerender(<Probe />);
    await waitFor(() => expect(seen).toHaveLength(0));
    expect(watcher.stop).toHaveBeenCalled();
    act(() => { late([secret]); });
    expect(seen).toHaveLength(0);
  });
});
