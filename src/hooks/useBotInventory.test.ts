// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useBotInventory } from './useBotInventory';
import type { BotRegistry } from '../lib/bot-registry';
const load = vi.hoisted(() => vi.fn());
vi.mock('../lib/bot-registry', async importOriginal => ({ ...await importOriginal<typeof import('../lib/bot-registry')>(), loadBotRegistry: load }));
const registry: BotRegistry = { v: 1, ownerRoot: 'a'.repeat(64), allocated: [], showNew: true, preferenceUpdatedAt: 0,
  bots: [{ publicKey: 'b'.repeat(64), ownerPersona: 'c'.repeat(64), label: 'Helper', source: 'generated', privateKey: 'sensitive', hidden: false, createdAt: 1, updatedAt: 1 }] };
it('strips signing keys and hides inventory immediately on lock or account change', async () => {
  load.mockResolvedValue(registry);
  const { result, rerender, unmount } = renderHook(({ root, key }) => useBotInventory(root, key, 0), { initialProps: { root: registry.ownerRoot, key: 'unlock' as string | null } });
  await waitFor(() => expect(result.current).toHaveLength(1));
  expect(result.current[0]).not.toHaveProperty('privateKey');
  expect(JSON.stringify(result.current)).not.toContain('sensitive');
  let release!: (value: BotRegistry) => void;
  load.mockReturnValue(new Promise<BotRegistry>(resolve => { release = resolve; }));
  rerender({ root: 'd'.repeat(64), key: 'unlock' });
  expect(result.current).toEqual([]);
  rerender({ root: 'd'.repeat(64), key: null });
  await act(async () => { release(registry); });
  expect(result.current).toEqual([]);
  unmount();
});
it('uses creation order for cards rather than random public-key order', async () => {
  load.mockResolvedValue({ ...registry, bots: [{ ...registry.bots[0], publicKey: 'a'.repeat(64), createdAt: 2, updatedAt: 2 },
    { ...registry.bots[0], publicKey: 'f'.repeat(64), createdAt: 1 }] });
  const { result, unmount } = renderHook(() => useBotInventory(registry.ownerRoot, 'unlock', 0));
  await waitFor(() => expect(result.current).toHaveLength(2));
  expect(result.current.map(bot => bot.publicKey)).toEqual(['f'.repeat(64), 'a'.repeat(64)]);
  unmount();
});
