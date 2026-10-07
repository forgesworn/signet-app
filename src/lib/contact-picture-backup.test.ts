import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { verifyEvent } from 'nostr-tools/pure';
import type { PicturePointer, BackupRecordRef } from './contact-picture-backup';

const KEY = 'unlock-key-for-tests';
const JPEG = (n: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, 0xff, 0xd9]);
const SERVER = 'https://nostr.download';
const ID = (n: number) => n.toString(16).padStart(32, '0');
const hash = (b: Uint8Array) => bytesToHex(sha256(b));

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
});

async function load() {
  const backup = await import('./contact-picture-backup');
  const pictures = await import('./contact-pictures');
  const crypto = await import('./contact-picture-crypto');
  const db = await import('./db');
  const photo = await import('./photo-crypto');
  return { ...backup, pictures, crypto, db, photo };
}
type M = Awaited<ReturnType<typeof load>>;

function lock(m: M): void {
  m.crypto.forgetContactPictureKeys();
  m.pictures.forgetContactPictureCache();
}

function ref(directoryId: string, contactId: string, extra: Partial<BackupRecordRef> = {}): BackupRecordRef {
  return { directoryId, contactId, lifecycle: 'active', ...extra };
}

/** Store an own row directly with the given state. */
async function ownRow(m: M, contactId: string, n: number, backup: 'pending' | 'synced' | 'local', directoryId = 'owner'): Promise<string> {
  const jpeg = JPEG(n);
  await m.pictures.setOwnContactPicture(KEY, directoryId, contactId, new Blob([new Uint8Array([1, 2, 3])]), undefined, {
    thumbnail: async () => new Uint8Array(jpeg), backup,
  });
  return hash(jpeg);
}

const state = (m: M, contactId: string, directoryId = 'owner') => m.pictures.cachedOwnPictureState(KEY, directoryId, contactId);

describe('resolveBackupServer', () => {
  it('undefined => default, empty => off, else the URL', async () => {
    const m = await load();
    expect(m.CONTACT_PICTURE_BACKUP_DEFAULT_URL).toBe('https://nostr.download');
    expect(m.resolveBackupServer(undefined)).toBe('https://nostr.download');
    expect(m.resolveBackupServer('')).toBeNull();
    expect(m.resolveBackupServer('https://blossom.example')).toBe('https://blossom.example');
  });
});

describe('deriveUploaderKey', () => {
  const K1 = 'a1'.repeat(32);
  const K2 = 'b2'.repeat(32);
  it('is deterministic, a valid scalar, 32 bytes', async () => {
    const m = await load();
    const a = m.deriveUploaderKey(K1);
    const b = m.deriveUploaderKey(K1);
    expect(a).toHaveLength(32);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(() => schnorr.getPublicKey(a)).not.toThrow();
  });
  it('different content keys give different keys, and the key is not the content key', async () => {
    const m = await load();
    const a = m.deriveUploaderKey(K1);
    const b = m.deriveUploaderKey(K2);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
    expect(bytesToHex(a)).not.toBe(K1);
    expect(bytesToHex(schnorr.getPublicKey(a))).not.toBe(bytesToHex(schnorr.getPublicKey(Uint8Array.from(K1.match(/../g)!.map(h => parseInt(h, 16))))));
  });
  it('is the documented hash of domain || key', async () => {
    const m = await load();
    const input = new Uint8Array([...new TextEncoder().encode('signet:contact-picture-uploader:v1'), ...Uint8Array.from(K1.match(/../g)!.map(h => parseInt(h, 16)))]);
    expect(bytesToHex(m.deriveUploaderKey(K1))).toBe(hash(input));
  });
  it('rejects a malformed key', async () => {
    const m = await load();
    expect(() => m.deriveUploaderKey('zz')).toThrow();
    expect(() => m.deriveUploaderKey(K1.toUpperCase())).toThrow();
  });
});

describe('uploadOwnPicture', () => {
  it('encrypts, uploads under the derived key, and returns the pointer', async () => {
    const m = await load();
    const jpeg = JPEG(7);
    let uploaded: Uint8Array | null = null;
    let uploadedTo = '';
    let signer = '';
    const upload = vi.fn(async (blob: Blob, server: string, backend: { activePublicKeyHex: string }, consent: boolean) => {
      expect(consent).toBe(true);
      uploaded = new Uint8Array(await blob.arrayBuffer());
      uploadedTo = server;
      signer = backend.activePublicKeyHex;
      return hash(uploaded);
    });
    const p = await m.uploadOwnPicture(jpeg, SERVER + '/', { upload: upload as never });
    expect(p.server).toBe(SERVER);
    expect(uploadedTo).toBe(SERVER);
    expect(p.hash).toBe(hash(uploaded!));
    expect(p.plainHash).toBe(hash(jpeg));
    expect(p.key).toMatch(/^[0-9a-f]{64}$/);
    // The blob is ciphertext; the key opens it.
    expect(Array.from(uploaded!)).not.toEqual(Array.from(jpeg));
    expect(Array.from(await m.photo.decryptPhoto(uploaded!, p.key))).toEqual(Array.from(jpeg));
    // Signed by the derived key, not tied to the content key itself.
    expect(signer).toBe(bytesToHex(schnorr.getPublicKey(m.deriveUploaderKey(p.key))));
  });

  it('mints a fresh key each time', async () => {
    const m = await load();
    const upload = vi.fn(async (blob: Blob) => hash(new Uint8Array(await blob.arrayBuffer())));
    const a = await m.uploadOwnPicture(JPEG(1), SERVER, { upload: upload as never });
    const b = await m.uploadOwnPicture(JPEG(1), SERVER, { upload: upload as never });
    expect(a.key).not.toBe(b.key);
  });

  it('refuses an unsafe server before uploading anything', async () => {
    const m = await load();
    const upload = vi.fn();
    for (const s of ['http://nostr.download', 'https://localhost', 'https://10.0.0.1']) {
      await expect(m.uploadOwnPicture(JPEG(1), s, { upload: upload as never })).rejects.toThrow();
    }
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('downloadOwnPicture', () => {
  async function fixture(m: M, jpeg = JPEG(3)) {
    const key = 'c3'.repeat(32);
    const ct = await m.photo.encryptPhotoWithKey(jpeg, key);
    const pointer: PicturePointer = { server: SERVER, hash: hash(ct), key, plainHash: hash(jpeg) };
    return { ct, pointer, jpeg };
  }
  const ok = (body: Uint8Array, headers: Record<string, string> = {}) => vi.fn(async () => new Response(body as BodyInit, { status: 200, headers }));

  it('returns the JPEG for a good blob, from {server}/{hash}', async () => {
    const m = await load();
    const { ct, pointer, jpeg } = await fixture(m);
    const fetch = ok(ct);
    const out = await m.downloadOwnPicture(pointer, { fetch: fetch as never });
    expect(Array.from(out!)).toEqual(Array.from(jpeg));
    expect((fetch.mock.calls[0] as unknown[])[0]).toBe(`${SERVER}/${pointer.hash}`);
  });

  it('rejects a ciphertext hash mismatch', async () => {
    const m = await load();
    const { ct, pointer } = await fixture(m);
    const tampered = new Uint8Array(ct);
    tampered[20] ^= 1;
    expect(await m.downloadOwnPicture(pointer, { fetch: ok(tampered) as never })).toBeNull();
  });

  it('rejects a plainHash mismatch', async () => {
    const m = await load();
    const { ct, pointer } = await fixture(m);
    expect(await m.downloadOwnPicture({ ...pointer, plainHash: 'ee'.repeat(32) }, { fetch: ok(ct) as never })).toBeNull();
  });

  it('rejects non-JPEG plaintext even when both hashes match', async () => {
    const m = await load();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const { ct, pointer } = await fixture(m, png);
    expect(await m.downloadOwnPicture(pointer, { fetch: ok(ct) as never })).toBeNull();
  });

  it('rejects an oversize body (declared and streamed)', async () => {
    const m = await load();
    const big = new Uint8Array(m.CONTACT_PICTURE_DOWNLOAD_MAX_BYTES + 1);
    const { pointer } = await fixture(m);
    expect(await m.downloadOwnPicture({ ...pointer, hash: hash(big) }, { fetch: ok(big) as never })).toBeNull();
    expect(await m.downloadOwnPicture(pointer, { fetch: ok(new Uint8Array(10), { 'content-length': String(m.CONTACT_PICTURE_DOWNLOAD_MAX_BYTES + 1) }) as never })).toBeNull();
  });

  it('is null on a non-2xx, a thrown fetch, and an unsafe server (without fetching)', async () => {
    const m = await load();
    const { ct, pointer } = await fixture(m);
    expect(await m.downloadOwnPicture(pointer, { fetch: vi.fn(async () => new Response('x', { status: 404 })) as never })).toBeNull();
    expect(await m.downloadOwnPicture(pointer, { fetch: vi.fn(async () => { throw new Error('offline'); }) as never })).toBeNull();
    const fetch = ok(ct);
    expect(await m.downloadOwnPicture({ ...pointer, server: 'https://127.0.0.1' }, { fetch: fetch as never })).toBeNull();
    expect(await m.downloadOwnPicture({ ...pointer, server: 'http://nostr.download' }, { fetch: fetch as never })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('deleteOwnPictureBlob', () => {
  const pointer: PicturePointer = { server: SERVER, hash: 'ab'.repeat(32), key: 'd4'.repeat(32), plainHash: 'cd'.repeat(32) };

  it('DELETEs {server}/{hash} with a t=delete auth signed by the derived key', async () => {
    const m = await load();
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await m.deleteOwnPictureBlob(pointer, { fetch: fetch as never })).toBe(true);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SERVER}/${pointer.hash}`);
    expect(init.method).toBe('DELETE');
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth.startsWith('Nostr ')).toBe(true);
    const event = JSON.parse(atob(auth.slice(6)));
    expect(event.kind).toBe(24242);
    expect(event.tags).toContainEqual(['t', 'delete']);
    expect(event.tags).toContainEqual(['x', pointer.hash]);
    const exp = event.tags.find((t: string[]) => t[0] === 'expiration');
    expect(Number(exp[1]) - event.created_at).toBe(300);
    expect(event.pubkey).toBe(bytesToHex(schnorr.getPublicKey(m.deriveUploaderKey(pointer.key))));
    expect(verifyEvent(event)).toBe(true);
  });

  it('never throws: a non-2xx, a network error and an unsafe pointer are all false', async () => {
    const m = await load();
    expect(await m.deleteOwnPictureBlob(pointer, { fetch: vi.fn(async () => new Response('no', { status: 500 })) as never })).toBe(false);
    expect(await m.deleteOwnPictureBlob(pointer, { fetch: vi.fn(async () => { throw new Error('offline'); }) as never })).toBe(false);
    expect(await m.deleteOwnPictureBlob({ ...pointer, server: 'https://localhost' }, { fetch: vi.fn() as never })).toBe(false);
    expect(await m.deleteOwnPictureBlob({ ...pointer, key: 'zz' }, { fetch: vi.fn() as never })).toBe(false);
  });
});

describe('own row state', () => {
  it('setOwnContactPicture stores plainHash and defaults to local', async () => {
    const m = await load();
    const h = await ownRow(m, ID(1), 1, 'local');
    await m.pictures.loadContactPictures(KEY);
    expect(state(m, ID(1))).toEqual({ plainHash: h, backup: 'local' });
    const id = ID(2);
    await m.pictures.setOwnContactPicture(KEY, 'owner', id, new Blob([new Uint8Array([1])]), undefined, { thumbnail: async () => JPEG(2) });
    expect(state(m, id)?.backup).toBe('local');
  });

  it('round-trips through the sealed row, and an old row (neither field) reads as local', async () => {
    const m = await load();
    const jpeg = JPEG(4);
    const id = m.crypto.ownPictureId('owner', ID(4));
    const row = await m.crypto.sealContactPicture({ id, jpeg, plainHash: hash(jpeg), backup: 'pending', fetchedAt: 1, updatedAt: 1 }, KEY);
    const opened = await m.crypto.openContactPicture(row, KEY);
    expect(opened?.backup).toBe('pending');
    expect(opened?.plainHash).toBe(hash(jpeg));
    const old = await m.crypto.sealContactPicture({ id, jpeg, fetchedAt: 1, updatedAt: 1 }, KEY);
    const openedOld = await m.crypto.openContactPicture(old, KEY);
    expect(openedOld).not.toBeNull();
    expect(openedOld?.backup).toBeUndefined();
    await m.db.saveContactPicture({ id, jpeg, fetchedAt: 1, updatedAt: 1 }, KEY);
    await m.pictures.loadContactPictures(KEY);
    expect(state(m, ID(4))).toEqual({ backup: 'local' });
  });

  it('refuses a malformed plainHash or backup when sealing', async () => {
    const m = await load();
    const id = m.crypto.ownPictureId('owner', ID(5));
    await expect(m.crypto.sealContactPicture({ id, jpeg: JPEG(5), plainHash: 'XYZ', fetchedAt: 1, updatedAt: 1 }, KEY)).rejects.toThrow();
    await expect(m.crypto.sealContactPicture({ id, jpeg: JPEG(5), backup: 'bogus' as never, fetchedAt: 1, updatedAt: 1 }, KEY)).rejects.toThrow();
  });

  it('setOwnPictureBackupState changes the state, guards on plainHash, and no-ops after lock', async () => {
    const m = await load();
    await m.pictures.loadContactPictures(KEY);
    const h = await ownRow(m, ID(6), 6, 'pending');
    expect(await m.pictures.setOwnPictureBackupState(KEY, 'owner', ID(6), 'synced', 'ee'.repeat(32))).toBe(false);
    expect(state(m, ID(6))?.backup).toBe('pending');
    expect(await m.pictures.setOwnPictureBackupState(KEY, 'owner', ID(6), 'synced', h)).toBe(true);
    expect(state(m, ID(6))).toEqual({ plainHash: h, backup: 'synced' });
    expect((await m.db.getContactPicture(`own:owner:${ID(6)}`, KEY))?.backup).toBe('synced');
    expect(await m.pictures.setOwnPictureBackupState(KEY, 'owner', ID(99), 'synced')).toBe(false);

    const gen = m.crypto.contactPictureGeneration();
    lock(m);
    expect(await m.pictures.setOwnPictureBackupState(KEY, 'owner', ID(6), 'local', undefined, gen)).toBe(false);
    expect((await m.db.getContactPicture(`own:owner:${ID(6)}`, KEY))?.backup).toBe('synced');
  });

  it('storeRestoredOwnPicture stores synced, refuses a hash mismatch, and no-ops on a stale generation', async () => {
    const m = await load();
    await m.pictures.loadContactPictures(KEY);
    const jpeg = JPEG(8);
    expect(await m.pictures.storeRestoredOwnPicture(KEY, 'owner', ID(8), new Uint8Array(jpeg), 'ee'.repeat(32))).toBe(false);
    expect(await m.pictures.storeRestoredOwnPicture(KEY, 'owner', ID(8), new Uint8Array(jpeg), hash(jpeg))).toBe(true);
    expect(state(m, ID(8))).toEqual({ plainHash: hash(jpeg), backup: 'synced' });
    const gen = m.crypto.contactPictureGeneration();
    lock(m);
    expect(await m.pictures.storeRestoredOwnPicture(KEY, 'owner', ID(9), new Uint8Array(jpeg), hash(jpeg), gen)).toBe(false);
    expect(await m.db.getContactPicture(`own:owner:${ID(9)}`, KEY)).toBeNull();
  });
});

describe('backupPendingPictures', () => {
  const pointerFor = (n: number): PicturePointer => ({ server: SERVER, hash: hash(new Uint8Array([n])), key: 'a5'.repeat(32), plainHash: hash(new Uint8Array([n, n])) });

  it('uploads a pending row, writes the pointer, marks it synced', async () => {
    const m = await load();
    const h = await ownRow(m, ID(1), 1, 'pending');
    let seen: number[] = [];
    const upload = vi.fn(async (j: Uint8Array, _s: string) => { seen = Array.from(j); return pointerFor(1); });
    const writePointer = vi.fn(async () => {});
    const result = await m.backupPendingPictures(KEY, { records: [ref('owner', ID(1))], server: SERVER, upload, writePointer, deleteBlob: vi.fn(async () => true) });
    expect(result).toEqual({ uploaded: 1, failed: 0 });
    expect(upload).toHaveBeenCalledOnce();
    expect(seen).toEqual(Array.from(JPEG(1)));
    expect(upload.mock.calls[0][1]).toBe(SERVER);
    expect(writePointer).toHaveBeenCalledWith('owner', ID(1), pointerFor(1));
    await m.pictures.loadContactPictures(KEY);
    expect(state(m, ID(1))).toEqual({ plainHash: h, backup: 'synced' });
  });

  it('leaves the row pending on an upload failure or a write failure', async () => {
    const m = await load();
    await ownRow(m, ID(1), 1, 'pending');
    await ownRow(m, ID(2), 2, 'pending');
    const deleteBlob = vi.fn(async () => true);
    const result = await m.backupPendingPictures(KEY, {
      records: [ref('owner', ID(1)), ref('owner', ID(2))], server: SERVER, deleteBlob,
      upload: async () => pointerFor(1),
      writePointer: async (_d, c) => { if (c === ID(2)) throw new Error('write failed'); },
    });
    expect(result).toEqual({ uploaded: 1, failed: 1 });
    await m.pictures.loadContactPictures(KEY);
    expect(state(m, ID(1))?.backup).toBe('synced');
    expect(state(m, ID(2))?.backup).toBe('pending');
    // A failed write must not delete a blob a saved-then-threw operation might point at.
    expect(deleteBlob).not.toHaveBeenCalled();

    const m2 = await load();
    await ownRow(m2, ID(3), 3, 'pending');
    const r2 = await m2.backupPendingPictures(KEY, { records: [ref('owner', ID(3))], server: SERVER, upload: async () => { throw new Error('offline'); }, writePointer: vi.fn() });
    expect(r2).toEqual({ uploaded: 0, failed: 1 });
    await m2.pictures.loadContactPictures(KEY);
    expect(state(m2, ID(3))?.backup).toBe('pending');
  });

  it('caps a run at 20 uploads', async () => {
    const m = await load();
    const ids: string[] = [];
    for (let i = 1; i <= 25; i += 1) { ids.push(ID(i)); await ownRow(m, ID(i), i, 'pending'); }
    const upload = vi.fn(async () => pointerFor(1));
    const result = await m.backupPendingPictures(KEY, { records: ids.map(c => ref('owner', c)), server: SERVER, upload, writePointer: async () => {}, deleteBlob: async () => true });
    expect(m.CONTACT_PICTURE_SWEEP_CAP).toBe(20);
    expect(result).toEqual({ uploaded: 20, failed: 0 });
    expect(upload).toHaveBeenCalledTimes(20);
    await m.pictures.loadContactPictures(KEY);
    expect(ids.filter(c => state(m, c)?.backup === 'pending')).toHaveLength(5);
  }, 30_000);

  it('runs at most 4 uploads at once', async () => {
    const m = await load();
    const ids: string[] = [];
    for (let i = 1; i <= 9; i += 1) { ids.push(ID(i)); await ownRow(m, ID(i), i, 'pending'); }
    let active = 0;
    let peak = 0;
    const upload = async () => { active += 1; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active -= 1; return pointerFor(1); };
    await m.backupPendingPictures(KEY, { records: ids.map(c => ref('owner', c)), server: SERVER, upload, writePointer: async () => {}, deleteBlob: async () => true });
    expect(peak).toBe(4);
  }, 30_000);

  it('skips a removed record, a missing record, and non-pending rows', async () => {
    const m = await load();
    await ownRow(m, ID(1), 1, 'pending');   // record removed
    await ownRow(m, ID(2), 2, 'pending');   // no record
    await ownRow(m, ID(3), 3, 'local');
    await ownRow(m, ID(4), 4, 'synced');
    const upload = vi.fn(async () => pointerFor(1));
    const result = await m.backupPendingPictures(KEY, {
      records: [ref('owner', ID(1), { lifecycle: 'removed' }), ref('owner', ID(3)), ref('owner', ID(4))],
      server: SERVER, upload, writePointer: async () => {},
    });
    expect(result).toEqual({ uploaded: 0, failed: 0 });
    expect(upload).not.toHaveBeenCalled();
    await m.pictures.loadContactPictures(KEY);
    expect(state(m, ID(1))?.backup).toBe('pending');
    expect(state(m, ID(2))?.backup).toBe('pending');
  });

  it('works across directories', async () => {
    const m = await load();
    const dep = 'dependant:' + '7'.repeat(64);
    await ownRow(m, ID(1), 1, 'pending', dep);
    const writePointer = vi.fn(async () => {});
    await m.backupPendingPictures(KEY, { records: [ref(dep, ID(1))], server: SERVER, upload: async () => pointerFor(1), writePointer, deleteBlob: async () => true });
    expect(writePointer).toHaveBeenCalledWith(dep, ID(1), pointerFor(1));
  });

  it('stops when the app locks mid-run: no later upload starts, nothing is written, the orphan blob is deleted', async () => {
    const m = await load();
    const ids: string[] = [];
    for (let i = 1; i <= 8; i += 1) { ids.push(ID(i)); await ownRow(m, ID(i), i, 'pending'); }
    const upload = vi.fn(async () => { lock(m); return pointerFor(1); });
    const writePointer = vi.fn(async () => {});
    const deleteBlob = vi.fn(async () => true);
    const result = await m.backupPendingPictures(KEY, { records: ids.map(c => ref('owner', c)), server: SERVER, upload, writePointer, deleteBlob });
    expect(upload.mock.calls.length).toBeLessThanOrEqual(4);
    expect(writePointer).not.toHaveBeenCalled();
    expect(deleteBlob).toHaveBeenCalledTimes(upload.mock.calls.length);
    expect(result).toEqual({ uploaded: 0, failed: 0 });
  }, 30_000);

  it('does nothing when started under a stale generation', async () => {
    const m = await load();
    await ownRow(m, ID(1), 1, 'pending');
    const gen = m.crypto.contactPictureGeneration();
    lock(m);
    const upload = vi.fn();
    expect(await m.backupPendingPictures(KEY, { records: [ref('owner', ID(1))], server: SERVER, upload, writePointer: vi.fn(), generation: gen })).toEqual({ uploaded: 0, failed: 0 });
    expect(upload).not.toHaveBeenCalled();
  });

  it('deletes the old pointer\'s blob after the new pointer is written, and not when unchanged', async () => {
    const m = await load();
    await ownRow(m, ID(1), 1, 'pending');
    await ownRow(m, ID(2), 2, 'pending');
    const calls: string[] = [];
    const old = pointerFor(9);
    const same = pointerFor(1);
    await m.backupPendingPictures(KEY, {
      records: [ref('owner', ID(1), { picture: old }), ref('owner', ID(2), { picture: same })],
      server: SERVER,
      upload: async () => pointerFor(1),
      writePointer: async (_d, c) => { calls.push('write:' + c); },
      deleteBlob: async p => { calls.push('delete:' + p.hash.slice(0, 4)); return true; },
    });
    expect(calls.filter(c => c.startsWith('delete'))).toEqual(['delete:' + old.hash.slice(0, 4)]);
    expect(calls.indexOf('write:' + ID(1))).toBeLessThan(calls.indexOf('delete:' + old.hash.slice(0, 4)));
  });

  it('leaves the row pending when the picture was swapped during the upload', async () => {
    const m = await load();
    await ownRow(m, ID(1), 1, 'pending');
    const upload = async () => { await ownRow(m, ID(1), 2, 'pending'); return pointerFor(1); };
    await m.backupPendingPictures(KEY, { records: [ref('owner', ID(1))], server: SERVER, upload, writePointer: async () => {}, deleteBlob: async () => true });
    await m.pictures.loadContactPictures(KEY);
    expect(state(m, ID(1))?.backup).toBe('pending');
  });
});

describe('restorePictures', () => {
  const jpegPointer = (n: number): PicturePointer => ({ server: SERVER, hash: 'ab'.repeat(32), key: 'a5'.repeat(32), plainHash: hash(JPEG(n)) });
  const dl = (n: number) => vi.fn(async () => new Uint8Array(JPEG(n)));

  it('pointer + no row => downloads and stores as synced', async () => {
    const m = await load();
    const download = dl(1);
    const result = await m.restorePictures(KEY, { records: [ref('owner', ID(1), { picture: jpegPointer(1) })], download });
    expect(result).toEqual({ restored: 1, removed: 0, failed: 0 });
    expect(download).toHaveBeenCalledWith(jpegPointer(1));
    expect(state(m, ID(1))).toEqual({ plainHash: hash(JPEG(1)), backup: 'synced' });
    expect(Array.from((await m.db.getContactPicture(`own:owner:${ID(1)}`, KEY))!.jpeg)).toEqual(Array.from(JPEG(1)));
  });

  it('pointer + synced row with a different plainHash => replaced', async () => {
    const m = await load();
    await ownRow(m, ID(1), 1, 'synced');
    const result = await m.restorePictures(KEY, { records: [ref('owner', ID(1), { picture: jpegPointer(2) })], download: dl(2) });
    expect(result).toEqual({ restored: 1, removed: 0, failed: 0 });
    expect(state(m, ID(1))).toEqual({ plainHash: hash(JPEG(2)), backup: 'synced' });
  });

  it('pointer + synced row with the same plainHash => untouched, nothing downloaded', async () => {
    const m = await load();
    await ownRow(m, ID(1), 1, 'synced');
    const download = dl(1);
    expect(await m.restorePictures(KEY, { records: [ref('owner', ID(1), { picture: jpegPointer(1) })], download })).toEqual({ restored: 0, removed: 0, failed: 0 });
    expect(download).not.toHaveBeenCalled();
  });

  it('pointer + pending or local row => the local choice stands', async () => {
    const m = await load();
    await ownRow(m, ID(1), 1, 'pending');
    await ownRow(m, ID(2), 2, 'local');
    const download = dl(3);
    const result = await m.restorePictures(KEY, {
      records: [ref('owner', ID(1), { picture: jpegPointer(3) }), ref('owner', ID(2), { picture: jpegPointer(3) })], download,
    });
    expect(result).toEqual({ restored: 0, removed: 0, failed: 0 });
    expect(download).not.toHaveBeenCalled();
    expect(state(m, ID(1))).toEqual({ plainHash: hash(JPEG(1)), backup: 'pending' });
    expect(state(m, ID(2))).toEqual({ plainHash: hash(JPEG(2)), backup: 'local' });
  });

  it('no pointer + synced row => row deleted; pending/local rows without a pointer are kept', async () => {
    const m = await load();
    await ownRow(m, ID(1), 1, 'synced');
    await ownRow(m, ID(2), 2, 'pending');
    await ownRow(m, ID(3), 3, 'local');
    const result = await m.restorePictures(KEY, { records: [ref('owner', ID(1)), ref('owner', ID(2)), ref('owner', ID(3))], download: dl(1) });
    expect(result).toEqual({ restored: 0, removed: 1, failed: 0 });
    expect(state(m, ID(1))).toBeNull();
    expect(await m.db.getContactPicture(`own:owner:${ID(1)}`, KEY)).toBeNull();
    expect(state(m, ID(2))?.backup).toBe('pending');
    expect(state(m, ID(3))?.backup).toBe('local');
  });

  it('a removed record is not restored, and its synced row is deleted', async () => {
    const m = await load();
    await ownRow(m, ID(1), 1, 'synced');
    const download = dl(2);
    const result = await m.restorePictures(KEY, {
      records: [ref('owner', ID(1), { lifecycle: 'removed', picture: jpegPointer(2) }), ref('owner', ID(2), { lifecycle: 'removed', picture: jpegPointer(2) })], download,
    });
    expect(result).toEqual({ restored: 0, removed: 1, failed: 0 });
    expect(download).not.toHaveBeenCalled();
    expect(state(m, ID(1))).toBeNull();
  });

  it('a failed download changes nothing', async () => {
    const m = await load();
    await ownRow(m, ID(1), 1, 'synced');
    const result = await m.restorePictures(KEY, {
      records: [ref('owner', ID(1), { picture: jpegPointer(2) }), ref('owner', ID(2), { picture: jpegPointer(2) })],
      download: async () => null,
    });
    expect(result).toEqual({ restored: 0, removed: 0, failed: 2 });
    expect(state(m, ID(1))).toEqual({ plainHash: hash(JPEG(1)), backup: 'synced' });
    expect(state(m, ID(2))).toBeNull();
  });

  it('counts a download whose bytes do not match the pointer as failed', async () => {
    const m = await load();
    const result = await m.restorePictures(KEY, { records: [ref('owner', ID(1), { picture: jpegPointer(2) })], download: dl(5) });
    expect(result).toEqual({ restored: 0, removed: 0, failed: 1 });
    expect(state(m, ID(1))).toBeNull();
  });

  it('runs at most 4 downloads at once', async () => {
    const m = await load();
    let active = 0;
    let peak = 0;
    const download = async () => { active += 1; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active -= 1; return new Uint8Array(JPEG(1)); };
    const records = Array.from({ length: 9 }, (_, i) => ref('owner', ID(i + 1), { picture: jpegPointer(1) }));
    expect(await m.restorePictures(KEY, { records, download })).toEqual({ restored: 9, removed: 0, failed: 0 });
    expect(peak).toBe(4);
  }, 30_000);

  it('stops on lock: nothing is stored once the generation is stale', async () => {
    const m = await load();
    const records = Array.from({ length: 8 }, (_, i) => ref('owner', ID(i + 1), { picture: jpegPointer(1) }));
    const download = vi.fn(async () => { lock(m); return new Uint8Array(JPEG(1)); });
    const result = await m.restorePictures(KEY, { records, download });
    expect(download.mock.calls.length).toBeLessThanOrEqual(4);
    expect(result.restored).toBe(0);
    expect((await m.db.listContactPictures(KEY)).filter(p => p.id.startsWith('own:'))).toHaveLength(0);
  }, 30_000);
});

describe('writeContactPictureOp', () => {
  const ACTOR = { actorPubkey: '1'.repeat(64), actorRole: 'owner' as const, actorDeviceId: 'd'.repeat(32) };
  const POINTER: PicturePointer = { server: SERVER, hash: 'ab'.repeat(32), key: 'c0'.repeat(32), plainHash: 'cd'.repeat(32) };

  async function seed(m: M, clock: number, directoryId = 'owner') {
    await m.db.saveContactOperationV2({
      operationId: 'a'.repeat(32), directoryId, contactId: ID(1), actorPubkey: ACTOR.actorPubkey, actorRole: 'owner', actorDeviceId: ACTOR.actorDeviceId,
      logicalClock: clock, action: 'add', value: { type: 'person', displayName: 'Dave', tier: 'kith' }, createdAt: 1,
    }, KEY);
  }

  it('writes a valid operation with a clock above the directory frontier', async () => {
    const m = await load();
    await seed(m, 41);
    await m.writeContactPictureOp(KEY, { directoryId: 'owner', contactId: ID(1), action: 'set-picture', value: POINTER, actor: ACTOR });
    const ops = await m.db.listContactOperationsV2('owner', KEY);
    const written = ops.find(o => o.action === 'set-picture')!;
    expect(written.logicalClock).toBe(42);
    expect(written.value).toEqual(POINTER);
    expect(written.actorPubkey).toBe(ACTOR.actorPubkey);
    const { applyOperations } = await import('./contacts-v2-reducer');
    expect(applyOperations(ops).get(`owner/${ID(1)}`)?.picture).toEqual(POINTER);
  });

  it('two concurrent calls get distinct, increasing clocks', async () => {
    const m = await load();
    await seed(m, 10);
    await Promise.all([
      m.writeContactPictureOp(KEY, { directoryId: 'owner', contactId: ID(1), action: 'set-picture', value: POINTER, actor: ACTOR }),
      m.writeContactPictureOp(KEY, { directoryId: 'owner', contactId: ID(1), action: 'clear-picture', value: {}, actor: ACTOR }),
    ]);
    const clocks = (await m.db.listContactOperationsV2('owner', KEY)).filter(o => o.action !== 'add').map(o => o.logicalClock).sort((a, b) => a - b);
    expect(clocks).toEqual([11, 12]);
  });

  it('works for a dependant directory with the guardian role, and refuses an invalid pointer', async () => {
    const m = await load();
    const dep = 'dependant:' + '7'.repeat(64);
    await seed(m, 3, dep);
    await m.writeContactPictureOp(KEY, { directoryId: dep, contactId: ID(1), action: 'set-picture', value: POINTER, actor: { ...ACTOR, actorRole: 'guardian' } });
    expect((await m.db.listContactOperationsV2(dep, KEY)).some(o => o.action === 'set-picture' && o.actorRole === 'guardian')).toBe(true);
    await expect(m.writeContactPictureOp(KEY, { directoryId: dep, contactId: ID(1), action: 'set-picture', value: { ...POINTER, server: 'http://x.example' }, actor: ACTOR })).rejects.toThrow();
  });

  it('a failed write does not wedge the queue', async () => {
    const m = await load();
    await seed(m, 1);
    await expect(m.writeContactPictureOp(KEY, { directoryId: 'owner', contactId: 'bad', action: 'clear-picture', value: {}, actor: ACTOR })).rejects.toThrow();
    await m.writeContactPictureOp(KEY, { directoryId: 'owner', contactId: ID(1), action: 'clear-picture', value: {}, actor: ACTOR });
    expect((await m.db.listContactOperationsV2('owner', KEY)).some(o => o.action === 'clear-picture')).toBe(true);
  });
});
