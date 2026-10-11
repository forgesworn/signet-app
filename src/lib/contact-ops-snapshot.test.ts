import { beforeEach, expect, it, vi } from 'vitest';
import { buildOperation } from './contacts-v2-mutations';

// A phone runs Web Crypto's PBKDF2 one derivation at a time, a quarter of a
// second each. Model that: every derivation waits for the previous one, then
// `derive.delayMs`. The key is one SHA-256 of passphrase and salt, so it is
// still bound to both, and AES-GCM stays real.
const derive = vi.hoisted(() => ({ calls: 0, delayMs: 0, chain: Promise.resolve() as Promise<unknown> }));
vi.mock('./aes-crypto', async importOriginal => {
  const real = await importOriginal<typeof import('./aes-crypto')>();
  const { sha256 } = await import('@noble/hashes/sha2.js');
  return { ...real, deriveAesKey: (passphrase: string, salt: Uint8Array) => {
    derive.calls += 1;
    const run = derive.chain.then(async () => {
      await new Promise(resolve => setTimeout(resolve, derive.delayMs));
      return real.importAesKeyRaw(sha256(new Uint8Array([...new TextEncoder().encode(passphrase), ...salt])));
    });
    derive.chain = run.catch(() => {});
    return run;
  } };
});
// Count real log decrypts: one batch call per uncached read of the log.
const batch = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('./crypto-store', async importOriginal => {
  const original = await importOriginal<typeof import('./crypto-store')>();
  batch.fn.mockImplementation(original.decryptSecretsBatch);
  return { ...original, decryptSecretsBatch: batch.fn };
});
import { forgetDerivedKeys, rememberDerivedKeysFor } from './crypto-store';
import { forgetSyncCacheKeys } from './sync-decrypt-cache';
import { forgetContactOperationsCache, getDb, getSyncCacheEntry, listContactOperationsV2, listContactOperationsV2Cached, purgeAllUserData,
  putSyncCacheEntry, saveContactOperationsV2 } from './db';
import { contactPeerAllowed } from './contact-exchange-record';

const KEY = 'k'.repeat(64), OTHER_KEY = 'o'.repeat(64);
const peer = '2'.repeat(64), stranger = '5'.repeat(64);
const DEP = `dependant:${'d'.repeat(64)}`;
const actor = { actorPubkey: '1'.repeat(64), actorRole: 'owner' as const, actorDeviceId: '3'.repeat(32) };
const opId = (n: number) => n.toString(16).padStart(32, '0');
const make = (action: Parameters<typeof buildOperation>[0]['action'], value: unknown, clock: number, contactId = '9'.repeat(32), directoryId = 'owner') =>
  buildOperation({ directoryId, contactId, action, value, clock, actor, now: 1000, operationId: opId(clock) });
const SALTS = 20, DELAY = 50;

/** What App.tsx does on lock, then on the next unlock with the same key. */
function relock(key = KEY) {
  forgetDerivedKeys(); forgetSyncCacheKeys(); forgetContactOperationsCache();
  rememberDerivedKeysFor(key);
}
/** A friend with the peer's key, then `SALTS - 2` renames: each its own save, so its own salt. */
async function seedLog(extra: ReturnType<typeof make>[] = []) {
  const ops = [make('add', { type: 'person', displayName: 'Friend', tier: 'kith' }, 1),
    make('add-identity', { itemId: 'a'.repeat(32), pubkey: peer, provenance: 'direct', verification: 'unverified' }, 2),
    ...Array.from({ length: SALTS - 2 }, (_, i) => make('rename', { displayName: `Friend ${i}` }, 3 + i)), ...extra];
  for (const op of ops) await saveContactOperationsV2([op], KEY);
}
const snapshot = () => getSyncCacheEntry('contact-ops:owner');
async function timed<T>(run: () => Promise<T>) {
  const before = derive.calls, start = performance.now();
  const value = await run();
  return { value, ms: performance.now() - start, derivations: derive.calls - before };
}

beforeEach(async () => {
  derive.delayMs = 0;
  await purgeAllUserData();
  forgetSyncCacheKeys(); forgetContactOperationsCache();
  rememberDerivedKeysFor(KEY);
  batch.fn.mockClear();
});

it('after an unlock, the first block check costs one derivation instead of one per saved batch', async () => {
  await seedLog();
  relock();
  derive.delayMs = DELAY;
  const cold = await timed(() => contactPeerAllowed('owner', KEY, peer));
  expect(cold.value).toBe(true);
  // One per saved batch, plus the snapshot's key for writing what it decrypted.
  expect(cold.derivations).toBe(SALTS + 1);
  expect(cold.ms).toBeGreaterThanOrEqual(SALTS * DELAY * 0.9);
  await vi.waitFor(async () => expect(await snapshot()).toBeDefined());

  relock();
  const warm = await timed(() => contactPeerAllowed('owner', KEY, peer));
  expect(warm.value).toBe(true);
  // The snapshot's own key (shared with the sync-rail caches), nothing per row.
  expect(warm.derivations).toBe(1);
  expect(warm.ms).toBeLessThan(SALTS * DELAY / 2);
  // And it reads back exactly what a full decrypt does.
  derive.delayMs = 0;
  forgetDerivedKeys();
  expect(await listContactOperationsV2Cached('owner', KEY)).toEqual(await listContactOperationsV2('owner', KEY));
});

it('a check made while the warm-up runs joins it instead of decrypting the log again', async () => {
  await seedLog();
  relock();
  derive.delayMs = DELAY;
  batch.fn.mockClear();
  const warm = listContactOperationsV2Cached('owner', KEY);
  const check = contactPeerAllowed('owner', KEY, peer);
  expect(await check).toBe(true);
  expect(await warm).toHaveLength(SALTS);
  expect(batch.fn).toHaveBeenCalledTimes(1);
});

it('still refuses a blocked peer when the log comes from the snapshot', async () => {
  await seedLog([make('block', { scope: { kind: 'contact' } }, 100)]);
  expect(await contactPeerAllowed('owner', KEY, peer)).toBe(false);
  await vi.waitFor(async () => expect(await snapshot()).toBeDefined());
  relock();
  const hit = await timed(() => contactPeerAllowed('owner', KEY, peer));
  expect(hit.value).toBe(false);
  expect(hit.derivations).toBe(1);
  expect(await contactPeerAllowed('owner', KEY, stranger)).toBe(true);
});

it('applies a block saved after the snapshot was written, at once', async () => {
  await seedLog();
  expect(await contactPeerAllowed('owner', KEY, peer)).toBe(true);
  await vi.waitFor(async () => expect(await snapshot()).toBeDefined());
  relock();
  await saveContactOperationsV2([make('block', { scope: { kind: 'contact' } }, 100)], KEY);
  expect(await contactPeerAllowed('owner', KEY, peer)).toBe(false);
});

it('a tampered snapshot is a miss: the log is decrypted in full and the block holds', async () => {
  await seedLog([make('block', { scope: { kind: 'contact' } }, 100)]);
  await contactPeerAllowed('owner', KEY, peer);
  await vi.waitFor(async () => expect(await snapshot()).toBeDefined());
  const row = (await snapshot())!;
  const bytes = Uint8Array.from(atob(row.ciphertext), c => c.charCodeAt(0));
  bytes[5] ^= 1;
  await putSyncCacheEntry({ ...row, ciphertext: btoa(String.fromCharCode(...bytes)) });
  relock();
  const read = await timed(() => contactPeerAllowed('owner', KEY, peer));
  expect(read.value).toBe(false);
  expect(read.derivations).toBe(SALTS + 2);
});

it('a snapshot moved to another directory\'s slot supplies nothing there', async () => {
  // The dependant directory holds the peer, unblocked; the owner's snapshot holds a block.
  await seedLog([make('block', { scope: { kind: 'contact' } }, 100)]);
  await saveContactOperationsV2([make('add', { type: 'person', displayName: 'Pal', tier: 'kith' }, 200, '8'.repeat(32), DEP),
    make('add-identity', { itemId: 'b'.repeat(32), pubkey: peer, provenance: 'direct', verification: 'unverified' }, 201, '8'.repeat(32), DEP)], KEY);
  await contactPeerAllowed('owner', KEY, peer);
  await vi.waitFor(async () => expect(await snapshot()).toBeDefined());
  await putSyncCacheEntry({ ...(await snapshot())!, id: `contact-ops:${DEP}` });
  relock();
  const ops = await listContactOperationsV2Cached(DEP, KEY);
  expect(ops.map(op => op.action).sort()).toEqual(['add', 'add-identity']);
});

it('never hands a row\'s cached plaintext to a rewritten row: it is decrypted afresh, as before', async () => {
  await seedLog([make('block', { scope: { kind: 'contact' } }, 100)]);
  expect(await contactPeerAllowed('owner', KEY, peer)).toBe(false);
  await vi.waitFor(async () => expect(await snapshot()).toBeDefined());
  // Swap the block row's ciphertext for the first rename's: its digest changes.
  const db = await getDb();
  const block = await db.get('contactOpsV2', opId(100)), rename = await db.get('contactOpsV2', opId(3));
  await db.put('contactOpsV2', { ...block, encryptedData: rename.encryptedData });
  relock();
  const viaSnapshot = await listContactOperationsV2Cached('owner', KEY);
  forgetDerivedKeys();
  expect(viaSnapshot).toEqual(await listContactOperationsV2('owner', KEY));
  expect(viaSnapshot.find(op => op.operationId === opId(100))?.action).toBe('rename');
});

it('another unlock key reads nothing from the snapshot', async () => {
  await seedLog();
  await contactPeerAllowed('owner', KEY, peer);
  await vi.waitFor(async () => expect(await snapshot()).toBeDefined());
  relock(OTHER_KEY);
  expect(await listContactOperationsV2Cached('owner', OTHER_KEY)).toEqual([]);
});

it('locked, the snapshot is neither read nor written, and a read running at lock writes nothing', async () => {
  await seedLog();
  forgetDerivedKeys(); forgetSyncCacheKeys();
  const locked = await timed(() => listContactOperationsV2('owner', KEY));
  expect(locked.value).toHaveLength(SALTS);
  expect(locked.derivations).toBe(SALTS);
  expect(await snapshot()).toBeUndefined();

  relock();
  derive.delayMs = 5;
  const base = derive.calls;
  const running = listContactOperationsV2('owner', KEY);
  await vi.waitFor(() => expect(derive.calls - base).toBeGreaterThan(2));
  forgetDerivedKeys(); forgetSyncCacheKeys();
  expect(await running).toHaveLength(SALTS);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(await snapshot()).toBeUndefined();
});

it('is cleared by a purge', async () => {
  await seedLog();
  await contactPeerAllowed('owner', KEY, peer);
  await vi.waitFor(async () => expect(await snapshot()).toBeDefined());
  await purgeAllUserData();
  expect(await snapshot()).toBeUndefined();
});

it('a row whose clear fields will not serialise skips the snapshot instead of throwing', async () => {
  await seedLog([make('block', { scope: { kind: 'contact' } }, 100)]);
  const db = await getDb();
  const row = await db.get('contactOpsV2', opId(3));
  await db.put('contactOpsV2', { ...row, createdAt: 1n });
  relock();
  // The plain read (the cached one fingerprints rows the same way, as before).
  const unlocked = await listContactOperationsV2('owner', KEY);
  forgetDerivedKeys();
  expect(unlocked).toEqual(await listContactOperationsV2('owner', KEY));
  expect(unlocked.some(op => op.operationId === opId(100))).toBe(true);
});
