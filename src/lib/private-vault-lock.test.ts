import { afterEach, expect, it, vi } from 'vitest';
import { supportsPrivateVaultRotationLock, withPrivateVaultLock } from './private-vault-lock';
const owner = '1'.repeat(64);
afterEach(() => vi.unstubAllGlobals());
it('serialises same-dataset work, lets unrelated datasets proceed, and releases on failure', async () => {
  vi.stubGlobal('navigator', {});
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const order: string[] = [];
  const first = withPrivateVaultLock(owner, 'profiles', async () => { order.push('first'); await gate; throw new Error('interrupted'); });
  const failed = expect(first).rejects.toThrow('interrupted');
  const second = withPrivateVaultLock(owner, 'profiles', async () => { order.push('second'); return 42; });
  await withPrivateVaultLock(owner, 'settings', async () => { order.push('other'); });
  expect(order).toEqual(['first', 'other']);
  finish(); await failed;
  expect(await second).toBe(42);
  expect(order).toEqual(['first', 'other', 'second']);
  expect(supportsPrivateVaultRotationLock()).toBe(false);
});
it('holds the browser lock around the complete asynchronous job', async () => {
  let held = false;
  const request = vi.fn(async (_name: string, _options: unknown, task: () => Promise<unknown>) => {
    held = true; try { return await task(); } finally { held = false; }
  });
  vi.stubGlobal('navigator', { locks: { request } });
  expect(supportsPrivateVaultRotationLock()).toBe(true);
  await withPrivateVaultLock(owner, 'profiles', async () => { expect(held).toBe(true); await Promise.resolve(); expect(held).toBe(true); });
  expect(held).toBe(false);
  expect(request).toHaveBeenCalledWith(`signet:private-vault:${owner}:signet:vault:profiles`, { mode: 'exclusive' }, expect.any(Function));
});
