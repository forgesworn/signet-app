import { beforeEach, expect, it } from 'vitest';
import { beginVaultRotation, advanceVaultRotation, loadVaultRotation, loadSeenVaultRotation, markVaultRotationSeen } from './private-vault-rotation-store';
import { getDb, purgeAllUserData } from './db';
const owner = '1'.repeat(64), key = 'rotation-storage-key';
beforeEach(async () => { await purgeAllUserData(); });
it('shares one durable active intent across concurrent tabs and only starts another after completion', async () => {
  const [a, b] = await Promise.all([beginVaultRotation(owner, 'profiles', key, 0, 100), beginVaultRotation(owner, 'profiles', key, 0, 101)]);
  expect(a.id).toBe(b.id);
  expect(await loadVaultRotation(owner, 'profiles', key)).toEqual(a);
  const raw = await (await getDb()).get('privateVaultState', `rotation:${owner}:signet:vault:profiles`);
  expect(raw.encrypted).not.toContain(a.id);
  await advanceVaultRotation(owner, 'profiles', key, a.id, { phase: 'forwarding' });
  await expect(advanceVaultRotation(owner, 'profiles', key, a.id, { phase: 'cancelled' })).rejects.toThrow('must finish');
  await advanceVaultRotation(owner, 'profiles', key, a.id, { phase: 'complete' });
  const next = await beginVaultRotation(owner, 'profiles', key, 1, 102);
  expect(next.id).not.toBe(a.id); expect(next.to).toBe(2);
  await expect(advanceVaultRotation(owner, 'profiles', key, a.id, { phase: 'complete' })).rejects.toThrow('changed');
});

it('records a rotation high-water mark that only ever increases and is never cleared by the intent lifecycle', async () => {
  expect(await loadSeenVaultRotation(owner, 'profiles', key)).toBe(0);
  expect(await markVaultRotationSeen(owner, 'profiles', key, 2)).toBe(2);
  expect(await loadSeenVaultRotation(owner, 'profiles', key)).toBe(2);
  // A later, lower reading never lowers the mark.
  expect(await markVaultRotationSeen(owner, 'profiles', key, 1)).toBe(2);
  expect(await loadSeenVaultRotation(owner, 'profiles', key)).toBe(2);
  expect(await markVaultRotationSeen(owner, 'profiles', key, 0)).toBe(2);
  expect(await loadSeenVaultRotation(owner, 'profiles', key)).toBe(2);
  // Stored in its own row, distinct from the rotation intent row.
  const raw = await (await getDb()).get('privateVaultState', `rotation-seen:${owner}:signet:vault:profiles`);
  expect(raw).toBeDefined();
  expect(await (await getDb()).get('privateVaultState', `rotation:${owner}:signet:vault:profiles`)).toBeUndefined();
  // Untouched by a rotation intent completing, or a fresh one starting and being cancelled.
  const a = await beginVaultRotation(owner, 'profiles', key, 0, 100);
  await advanceVaultRotation(owner, 'profiles', key, a.id, { phase: 'forwarding' });
  await advanceVaultRotation(owner, 'profiles', key, a.id, { phase: 'complete' });
  expect(await loadSeenVaultRotation(owner, 'profiles', key)).toBe(2);
  const b = await beginVaultRotation(owner, 'profiles', key, 1, 200);
  await advanceVaultRotation(owner, 'profiles', key, b.id, { phase: 'cancelled' });
  expect(await loadSeenVaultRotation(owner, 'profiles', key)).toBe(2);
});
