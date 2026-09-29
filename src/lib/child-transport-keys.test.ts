import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
});

const KEY = 'k'.repeat(64);
const P1 = 'ab'.repeat(32), P2 = 'cd'.repeat(32);

describe('loadOrCreateTransportKeys', () => {
  it('mints one keypair per persona, persists it, and returns the same keys next time', async () => {
    const { loadOrCreateTransportKeys } = await import('./child-transport-keys');
    const first = await loadOrCreateTransportKeys([P1, P2], KEY);
    expect(Object.keys(first).sort()).toEqual([P1, P2].sort());
    for (const [persona, kp] of Object.entries(first)) {
      expect(kp.publicKey).toBe(getPublicKey(hexToBytes(kp.privateKey)));
      expect(kp.publicKey).not.toBe(persona);
    }
    expect(first[P1].publicKey).not.toBe(first[P2].publicKey);
    const again = await loadOrCreateTransportKeys([P2, P1], KEY);
    expect(again).toEqual(first);
  });

  it('keeps existing keys when a persona is added, and only returns the requested personas', async () => {
    const { loadOrCreateTransportKeys } = await import('./child-transport-keys');
    const a = await loadOrCreateTransportKeys([P1], KEY);
    const b = await loadOrCreateTransportKeys([P1, P2], KEY);
    expect(b[P1]).toEqual(a[P1]);
    const c = await loadOrCreateTransportKeys([P2], KEY);
    expect(Object.keys(c)).toEqual([P2]);
    expect(c[P2]).toEqual(b[P2]);
  });

  it('is stored encrypted — the private key never appears in the row', async () => {
    const { loadOrCreateTransportKeys } = await import('./child-transport-keys');
    const keys = await loadOrCreateTransportKeys([P1], KEY);
    const raw = await new Promise<unknown[]>((resolve) => {
      const req = indexedDB.open('my-signet');
      req.onsuccess = () => {
        const all = req.result.transaction('identity', 'readonly').objectStore('identity').getAll();
        all.onsuccess = () => resolve(all.result);
      };
    });
    expect(JSON.stringify(raw)).not.toContain(keys[P1].privateKey);
    expect(JSON.stringify(raw)).toContain('childDirect:transportKeys');
  });

  it('concurrent calls agree on one key per persona', async () => {
    const { loadOrCreateTransportKeys } = await import('./child-transport-keys');
    const [a, b] = await Promise.all([loadOrCreateTransportKeys([P1], KEY), loadOrCreateTransportKeys([P1], KEY)]);
    expect(a[P1]).toEqual(b[P1]);
  });

  it('ignores malformed persona ids', async () => {
    const { loadOrCreateTransportKeys } = await import('./child-transport-keys');
    const out = await loadOrCreateTransportKeys(['nope', P1.toUpperCase()], KEY);
    expect(Object.keys(out)).toEqual([P1]);
  });

  it('A45: a stored row that will not decrypt is an error — nothing is minted over it', async () => {
    const { loadOrCreateTransportKeys, ChildTransportKeysUnreadableError } = await import('./child-transport-keys');
    const first = await loadOrCreateTransportKeys([P1], KEY);
    const rowBefore = await readRow();
    await expect(loadOrCreateTransportKeys([P1, P2], 'z'.repeat(64))).rejects.toBeInstanceOf(ChildTransportKeysUnreadableError);
    expect(await readRow()).toEqual(rowBefore);
    // The right key still reads the original keys.
    expect((await loadOrCreateTransportKeys([P1], KEY))[P1]).toEqual(first[P1]);
  });
});

async function readRow(): Promise<unknown> {
  return new Promise((resolve) => {
    const req = indexedDB.open('my-signet');
    req.onsuccess = () => {
      const get = req.result.transaction('identity', 'readonly').objectStore('identity').get('childDirect:transportKeys');
      get.onsuccess = () => { const v = get.result; req.result.close(); resolve(v); };
    };
  });
}
