// Durable orphan-blob list (gap 5): `blob-orphan:<hash>` rows in `preferences`.
// Real IndexedDB (fake-indexeddb).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDB } from 'idb';
import {
  recordOrphanBlob, sweepOrphanBlobs, parseOrphanBlob, discardUpload, BLOB_ORPHAN_CAP, BLOB_ORPHAN_MAX_ATTEMPTS,
} from './blob-deletion';
import { listBlobOrphanRows, putBlobOrphanRow, purgeAllUserData, getPreferences } from './db';
import { AVATAR_UPLOADER_DOMAIN, BACKDROP_UPLOADER_DOMAIN } from './blossom-uploader';

const SERVER = 'https://nostr.download';
const h = (n: number) => n.toString(16).padStart(64, '0');

async function rawPut(row: Record<string, unknown>) {
  // Junk straight into the store, as a corrupted or foreign row would be.
  await getPreferences(); // make sure the DB exists at its current version
  const db = await openDB('my-signet');
  await db.put('preferences', row);
  db.close();
}

const hashes = async () => (await listBlobOrphanRows()).map(r => (r as { hash: string }).hash).sort();

describe('recordOrphanBlob', () => {
  beforeEach(async () => { await purgeAllUserData(); });

  it('stores one plaintext row per blob, needing no key', async () => {
    await recordOrphanBlob({ domain: BACKDROP_UPLOADER_DOMAIN, hash: h(1).toUpperCase(), url: SERVER }, 100);
    const rows = await listBlobOrphanRows();
    expect(rows).toEqual([{ id: `blob-orphan:${h(1)}`, domain: BACKDROP_UPLOADER_DOMAIN, hash: h(1), url: SERVER, addedAt: 100, attempts: 0 }]);
  });

  it('recording the same hash again keeps the earlier row and its attempts', async () => {
    await putBlobOrphanRow({ domain: AVATAR_UPLOADER_DOMAIN, hash: h(1), url: SERVER, addedAt: 5, attempts: 2 });
    await recordOrphanBlob({ domain: AVATAR_UPLOADER_DOMAIN, hash: h(1), url: SERVER }, 900);
    expect(await listBlobOrphanRows()).toEqual([expect.objectContaining({ addedAt: 5, attempts: 2 })]);
  });

  it('refuses a malformed entry (bad hash, non-https server, unknown domain)', async () => {
    await recordOrphanBlob({ domain: AVATAR_UPLOADER_DOMAIN, hash: 'xyz', url: SERVER });
    await recordOrphanBlob({ domain: AVATAR_UPLOADER_DOMAIN, hash: h(2), url: 'http://nostr.download' });
    await recordOrphanBlob({ domain: 'nope', hash: h(3), url: SERVER });
    expect(await listBlobOrphanRows()).toEqual([]);
  });

  it(`keeps at most ${BLOB_ORPHAN_CAP}: recording one more drops the oldest`, async () => {
    for (let i = 1; i <= BLOB_ORPHAN_CAP; i++) {
      await putBlobOrphanRow({ domain: AVATAR_UPLOADER_DOMAIN, hash: h(i), url: SERVER, addedAt: 1000 + i, attempts: 0 });
    }
    await recordOrphanBlob({ domain: AVATAR_UPLOADER_DOMAIN, hash: h(999), url: SERVER }, 5000);
    const after = await hashes();
    expect(after).toHaveLength(BLOB_ORPHAN_CAP);
    expect(after).not.toContain(h(1));
    expect(after).toContain(h(2));
    expect(after).toContain(h(999));
  });

  it('is wiped with the rest of the user data', async () => {
    await recordOrphanBlob({ domain: AVATAR_UPLOADER_DOMAIN, hash: h(1), url: SERVER });
    await purgeAllUserData();
    expect(await listBlobOrphanRows()).toEqual([]);
  });
});

describe('sweepOrphanBlobs', () => {
  beforeEach(async () => { await purgeAllUserData(); });

  const live = () => true;
  const noRows = async () => [] as unknown[];

  it('deletes each orphan under its own domain and drops the deleted ones (404 counts as deleted upstream)', async () => {
    await recordOrphanBlob({ domain: AVATAR_UPLOADER_DOMAIN, hash: h(1), url: SERVER });
    await recordOrphanBlob({ domain: BACKDROP_UPLOADER_DOMAIN, hash: h(2), url: 'https://blossom.example' });
    const deleter = vi.fn(async () => 'deleted' as const);
    const res = await sweepOrphanBlobs({ deleter, isLive: live, loadRows: noRows });
    expect(res).toMatchObject({ deleted: 2, stopped: false });
    expect(deleter).toHaveBeenCalledWith(AVATAR_UPLOADER_DOMAIN, h(1), SERVER);
    expect(deleter).toHaveBeenCalledWith(BACKDROP_UPLOADER_DOMAIN, h(2), 'https://blossom.example');
    expect(await listBlobOrphanRows()).toEqual([]);
  });

  it('R1: a blob a stored row references again is kept, never deleted, and its entry dropped', async () => {
    await recordOrphanBlob({ domain: AVATAR_UPLOADER_DOMAIN, hash: h(1), url: SERVER });
    const deleter = vi.fn(async () => 'deleted' as const);
    const res = await sweepOrphanBlobs({ deleter, isLive: live, loadRows: async () => [{ id: 'x', persona: { avatarHash: h(1) } }] });
    expect(deleter).not.toHaveBeenCalled();
    expect(res.dropped).toBe(1);
    expect(await listBlobOrphanRows()).toEqual([]);
  });

  it(`a failed delete counts an attempt, and the entry is given up after ${BLOB_ORPHAN_MAX_ATTEMPTS}`, async () => {
    await recordOrphanBlob({ domain: AVATAR_UPLOADER_DOMAIN, hash: h(1), url: SERVER });
    const deleter = vi.fn(async () => 'failed' as const);
    for (let i = 1; i < BLOB_ORPHAN_MAX_ATTEMPTS; i++) {
      await sweepOrphanBlobs({ deleter, isLive: live, loadRows: noRows });
      expect(await listBlobOrphanRows()).toEqual([expect.objectContaining({ attempts: i })]);
    }
    await sweepOrphanBlobs({ deleter, isLive: live, loadRows: noRows });
    expect(await listBlobOrphanRows()).toEqual([]);
    expect(deleter).toHaveBeenCalledTimes(BLOB_ORPHAN_MAX_ATTEMPTS);
  });

  it('drops junk rows without trying them', async () => {
    await rawPut({ id: `blob-orphan:${h(1)}`, domain: AVATAR_UPLOADER_DOMAIN, hash: 'not-hex', url: SERVER, addedAt: 1, attempts: 0 });
    await rawPut({ id: `blob-orphan:${h(2)}`, domain: AVATAR_UPLOADER_DOMAIN, hash: h(2), url: 'javascript:alert(1)', addedAt: 1, attempts: 0 });
    await rawPut({ id: `blob-orphan:${h(3)}`, domain: AVATAR_UPLOADER_DOMAIN, hash: h(4), url: SERVER, addedAt: 1, attempts: 0 });
    await rawPut({ id: `blob-orphan:${h(5)}`, domain: AVATAR_UPLOADER_DOMAIN, hash: h(5), url: SERVER, addedAt: 'soon', attempts: 0 });
    await rawPut({ id: `blob-orphan:${h(6)}`, hash: h(6), url: SERVER, addedAt: 1, attempts: 0 });
    const deleter = vi.fn(async () => 'deleted' as const);
    const res = await sweepOrphanBlobs({ deleter, isLive: live, loadRows: noRows });
    expect(deleter).not.toHaveBeenCalled();
    expect(res.dropped).toBe(5);
    expect(await listBlobOrphanRows()).toEqual([]);
  });

  it('stops, leaving the rest as they were, once the key is no longer live', async () => {
    await recordOrphanBlob({ domain: AVATAR_UPLOADER_DOMAIN, hash: h(1), url: SERVER }, 1);
    await recordOrphanBlob({ domain: AVATAR_UPLOADER_DOMAIN, hash: h(2), url: SERVER }, 2);
    let unlocked = true;
    const deleter = vi.fn(async () => { unlocked = false; return 'kept' as const; });
    const res = await sweepOrphanBlobs({ deleter, isLive: () => unlocked, loadRows: noRows });
    expect(res.stopped).toBe(true);
    expect(deleter).toHaveBeenCalledTimes(1);
    expect(await hashes()).toEqual([h(1), h(2)]);
  });

  it('a deleter that cannot act (kept, though nothing references it) stops the pass without dropping', async () => {
    await recordOrphanBlob({ domain: AVATAR_UPLOADER_DOMAIN, hash: h(1), url: SERVER });
    const res = await sweepOrphanBlobs({ deleter: async () => 'kept', isLive: live, loadRows: noRows });
    expect(res.stopped).toBe(true);
    expect(await hashes()).toEqual([h(1)]);
  });

  it('an unreadable reference check stops the pass without dropping', async () => {
    await recordOrphanBlob({ domain: AVATAR_UPLOADER_DOMAIN, hash: h(1), url: SERVER });
    const deleter = vi.fn(async () => 'deleted' as const);
    const res = await sweepOrphanBlobs({ deleter, isLive: live, loadRows: async () => { throw new Error('idb'); } });
    expect(res.stopped).toBe(true);
    expect(deleter).not.toHaveBeenCalled();
    expect(await hashes()).toEqual([h(1)]);
  });
});

describe('parseOrphanBlob / discardUpload', () => {
  it('accepts a well-formed row and rejects an id that does not match its hash', () => {
    const row = { id: `blob-orphan:${h(1)}`, domain: AVATAR_UPLOADER_DOMAIN, hash: h(1), url: SERVER, addedAt: 1, attempts: 0 };
    expect(parseOrphanBlob(row)).toEqual({ domain: AVATAR_UPLOADER_DOMAIN, hash: h(1), url: SERVER, addedAt: 1, attempts: 0 });
    expect(parseOrphanBlob({ ...row, id: `blob-orphan:${h(2)}` })).toBeNull();
    expect(parseOrphanBlob(null)).toBeNull();
  });

  it('deletes at once while live, records while locked or when the delete fails', async () => {
    const record = vi.fn(async () => undefined);
    const del = vi.fn(async () => 'deleted' as const);
    await discardUpload({ domain: AVATAR_UPLOADER_DOMAIN, hash: h(1), server: SERVER, live: true, deleteBlob: del, recordOrphan: record });
    expect(del).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
    await discardUpload({ domain: AVATAR_UPLOADER_DOMAIN, hash: h(1), server: SERVER, live: false, deleteBlob: del, recordOrphan: record });
    expect(del).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ domain: AVATAR_UPLOADER_DOMAIN, hash: h(1), url: SERVER });
    await discardUpload({ domain: AVATAR_UPLOADER_DOMAIN, hash: h(1), server: SERVER, live: true, deleteBlob: async () => 'failed', recordOrphan: record });
    expect(record).toHaveBeenCalledTimes(2);
  });
});
