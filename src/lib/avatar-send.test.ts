import { describe, it, expect, vi } from 'vitest';
import { setSlotAvatar, clearSlotAvatar, avatarChangeOutcome, type AvatarSetDeps, type AvatarClearDeps, type AvatarMeta } from './avatar-send';
import { AVATAR_UPLOADER_DOMAIN } from './blossom-uploader';
import { listBlobOrphanRows, purgeAllUserData } from './db';

const SERVER = 'https://nostr.download';
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const metaN = (n: string): AvatarMeta => ({ hash: n.repeat(64), blossomUrl: SERVER, keyHex: '3'.repeat(64), updatedAt: 5 });
const META = metaN('2');

let slotCounter = 0;
function deps(over: Partial<AvatarSetDeps> = {}) {
  const order: string[] = [];
  const d: AvatarSetDeps = {
    slotKey: `avatar-slot-${++slotCounter}`,
    encryptionKey: 'unlock-key',
    getKey: () => 'unlock-key',
    upload: vi.fn(async () => { order.push('upload'); return META; }),
    saveSlot: vi.fn(async () => { order.push('save'); return { previous: { hash: H1, server: SERVER } }; }),
    deleteBlob: vi.fn(async () => { order.push('delete'); return 'deleted' as const; }),
    recordOrphan: vi.fn(async () => undefined),
    ...over,
  };
  return { d, order };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('setSlotAvatar', () => {
  it('uploads, saves, THEN deletes the replaced avatar under the avatar domain', async () => {
    const { d, order } = deps();
    const res = await setSlotAvatar(d);
    expect(res.ok).toBe(true);
    if (res.ok) await res.deletion;
    expect(order).toEqual(['upload', 'save', 'delete']);
    expect(d.saveSlot).toHaveBeenCalledWith(META);
    expect(d.deleteBlob).toHaveBeenCalledWith(AVATAR_UPLOADER_DOMAIN, H1, SERVER);
  });

  it('re-uploading identical bytes deletes nothing', async () => {
    const { d } = deps({ saveSlot: vi.fn(async () => ({ previous: { hash: H2, server: SERVER } })) });
    const res = await setSlotAvatar(d);
    if (res.ok) await res.deletion;
    expect(d.deleteBlob).not.toHaveBeenCalled();
  });

  it('an upload error is thrown for the picker, and nothing is saved', async () => {
    const { d } = deps({ upload: vi.fn(async () => { throw new Error('That photo is too large.'); }) });
    await expect(setSlotAvatar(d)).rejects.toThrow('That photo is too large.');
    expect(d.saveSlot).not.toHaveBeenCalled();
  });
});

describe('an avatar upload that spans a lock', () => {
  it('saves nothing, records the uploaded blob as an orphan, and sends no delete', async () => {
    let key: string | null = 'unlock-key';
    const { d } = deps({ getKey: () => key, upload: vi.fn(async () => { key = null; return META; }) });
    expect(await setSlotAvatar(d)).toEqual({ ok: false, reason: 'locked' });
    expect(d.saveSlot).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(d.recordOrphan).toHaveBeenCalledWith({ domain: AVATAR_UPLOADER_DOMAIN, hash: H2, url: SERVER }));
    expect(d.deleteBlob).not.toHaveBeenCalled();
  });

  it('records the orphan as a durable row by default', async () => {
    await purgeAllUserData();
    let key: string | null = 'unlock-key';
    const { d } = deps({ getKey: () => key, recordOrphan: undefined, upload: vi.fn(async () => { key = null; return META; }) });
    await setSlotAvatar(d);
    await vi.waitFor(async () => expect(await listBlobOrphanRows()).toEqual([
      expect.objectContaining({ domain: AVATAR_UPLOADER_DOMAIN, hash: H2, url: SERVER, attempts: 0 }),
    ]));
  });

  it('a different key after the upload counts as a lock too', async () => {
    let key: string | null = 'unlock-key';
    const { d } = deps({ getKey: () => key, upload: vi.fn(async () => { key = 'other-key'; return META; }) });
    expect(await setSlotAvatar(d)).toEqual({ ok: false, reason: 'locked' });
    expect(d.saveSlot).not.toHaveBeenCalled();
  });

  it('a lock during the save (it refuses) records the orphan and deletes nothing', async () => {
    let key: string | null = 'unlock-key';
    const { d } = deps({ getKey: () => key, saveSlot: vi.fn(async () => { key = null; throw new Error('Encryption key required'); }) });
    expect(await setSlotAvatar(d)).toMatchObject({ ok: false, reason: 'locked' });
    await vi.waitFor(() => expect(d.recordOrphan).toHaveBeenCalledTimes(1));
    expect(d.deleteBlob).not.toHaveBeenCalled();
  });

  it('a slot gone by save time (live key) discards the new blob', async () => {
    const { d } = deps({ saveSlot: vi.fn(async () => { throw new Error('Persona not found'); }) });
    const res = await setSlotAvatar(d);
    expect(res).toMatchObject({ ok: false, reason: 'failed' });
    expect(d.deleteBlob).toHaveBeenCalledWith(AVATAR_UPLOADER_DOMAIN, H2, SERVER);
    expect(d.recordOrphan).not.toHaveBeenCalled();
    expect(() => avatarChangeOutcome(res as Extract<typeof res, { ok: false }>)).toThrow('Persona not found');
  });
});

describe('overlapping avatar changes on one slot', () => {
  it('a superseded set discards its blob, even when the older upload finishes last', async () => {
    const first = deferred<AvatarMeta>();
    const second = deferred<AvatarMeta>();
    const { d } = deps();
    const older = setSlotAvatar({ ...d, upload: () => first.promise });
    const newer = setSlotAvatar({ ...d, upload: () => second.promise });
    second.resolve(metaN('b'));
    expect((await newer).ok).toBe(true);
    first.resolve(metaN('a'));
    const res = await older;
    expect(res).toEqual({ ok: false, reason: 'superseded' });
    expect(avatarChangeOutcome(res as Extract<typeof res, { ok: false }>)).toBeUndefined();
    expect(d.saveSlot).toHaveBeenCalledTimes(1);
    expect(d.saveSlot).toHaveBeenCalledWith(metaN('b'));
    expect(d.deleteBlob).toHaveBeenCalledWith(AVATAR_UPLOADER_DOMAIN, 'a'.repeat(64), SERVER);
  });

  it('B fails before saving: A (older, uploaded first) saves after all', async () => {
    const first = deferred<AvatarMeta>();
    const second = deferred<AvatarMeta>();
    const { d } = deps();
    const a = setSlotAvatar({ ...d, upload: () => first.promise });
    const b = setSlotAvatar({ ...d, upload: async () => { await second.promise; throw new Error('refused'); } });
    first.resolve(metaN('a'));
    second.resolve(metaN('b'));
    await expect(b).rejects.toThrow('refused');
    const res = await a;
    expect(res.ok).toBe(true);
    expect(d.saveSlot).toHaveBeenCalledTimes(1);
    expect(d.saveSlot).toHaveBeenCalledWith(metaN('a'));
  });

  it('B still in flight when A is ready, then B saves: A waits, then is discarded', async () => {
    const first = deferred<AvatarMeta>();
    const second = deferred<AvatarMeta>();
    const { d } = deps();
    const a = setSlotAvatar({ ...d, upload: () => first.promise });
    const b = setSlotAvatar({ ...d, upload: () => second.promise });
    let aDone = false;
    void a.then(() => { aDone = true; });
    first.resolve(metaN('a'));
    await new Promise(r => setTimeout(r, 20));
    expect(aDone).toBe(false);
    second.resolve(metaN('b'));
    expect((await b).ok).toBe(true);
    expect(await a).toEqual({ ok: false, reason: 'superseded' });
    expect(d.saveSlot).toHaveBeenCalledTimes(1);
    expect(d.saveSlot).toHaveBeenCalledWith(metaN('b'));
    expect(d.deleteBlob).toHaveBeenCalledWith(AVATAR_UPLOADER_DOMAIN, 'a'.repeat(64), SERVER);
  });

  it('B fails but C saves: A is discarded', async () => {
    const up = { a: deferred<AvatarMeta>(), b: deferred<AvatarMeta>(), c: deferred<AvatarMeta>() };
    const { d } = deps();
    const a = setSlotAvatar({ ...d, upload: () => up.a.promise });
    const b = setSlotAvatar({ ...d, upload: async () => { await up.b.promise; throw new Error('network'); } });
    const c = setSlotAvatar({ ...d, upload: () => up.c.promise });
    up.a.resolve(metaN('a'));
    up.b.resolve(metaN('b'));
    await expect(b).rejects.toThrow('network');
    up.c.resolve(metaN('c'));
    expect((await c).ok).toBe(true);
    expect(await a).toEqual({ ok: false, reason: 'superseded' });
    expect(d.saveSlot).toHaveBeenCalledTimes(1);
    expect(d.saveSlot).toHaveBeenCalledWith(metaN('c'));
  });

  it('B fails, but a clear came after A: A is discarded', async () => {
    const up = { a: deferred<AvatarMeta>(), b: deferred<AvatarMeta>() };
    const { d } = deps();
    const clearSlot = vi.fn(async () => ({}));
    const a = setSlotAvatar({ ...d, upload: () => up.a.promise });
    const clear = clearSlotAvatar({ ...d, clearSlot } as AvatarClearDeps);
    const b = setSlotAvatar({ ...d, upload: async () => { await up.b.promise; throw new Error('network'); } });
    up.b.resolve(metaN('b'));
    await expect(b).rejects.toThrow('network');
    up.a.resolve(metaN('a'));
    expect(await a).toEqual({ ok: false, reason: 'superseded' });
    expect((await clear).ok).toBe(true);
    expect(d.saveSlot).not.toHaveBeenCalled();
  });

  it('a clear after a set wins: the set still uploading saves nothing and its blob is deleted', async () => {
    const upload = deferred<AvatarMeta>();
    const { d } = deps();
    const clearSlot = vi.fn(async () => ({ previous: { hash: H1, server: SERVER } }));
    const set = setSlotAvatar({ ...d, upload: () => upload.promise });
    const clear = clearSlotAvatar({ ...d, clearSlot } as AvatarClearDeps);
    const cleared = await clear;
    expect(cleared.ok).toBe(true);
    if (cleared.ok) await cleared.deletion;
    upload.resolve(META);
    expect(await set).toEqual({ ok: false, reason: 'superseded' });
    expect(clearSlot).toHaveBeenCalledTimes(1);
    expect(d.saveSlot).not.toHaveBeenCalled();
    expect(d.deleteBlob).toHaveBeenCalledWith(AVATAR_UPLOADER_DOMAIN, H1, SERVER);
    expect(d.deleteBlob).toHaveBeenCalledWith(AVATAR_UPLOADER_DOMAIN, H2, SERVER);
  });

  it('an avatar set never supersedes a backdrop send on the same slot key (separate sequencers)', async () => {
    const { sendBackdropToChild } = await import('./backdrop-send');
    const upload = deferred<AvatarMeta>();
    const { d } = deps();
    const backdropSave = vi.fn(async () => ({}));
    const backdrop = sendBackdropToChild(new Blob(['x']), {
      slotKey: d.slotKey, encryptionKey: 'unlock-key', getKey: () => 'unlock-key', blossomUrl: SERVER, blossomConsent: true,
      upload: async () => { await upload.promise; return metaN('c'); }, saveSlot: backdropSave, deleteBlob: d.deleteBlob,
    });
    const avatar = setSlotAvatar(d);
    expect((await avatar).ok).toBe(true);
    upload.resolve(META);
    expect((await backdrop).ok).toBe(true);
    expect(backdropSave).toHaveBeenCalledTimes(1);
  });
});

describe('clearSlotAvatar', () => {
  it('locked: clears nothing', async () => {
    const clearSlot = vi.fn(async () => ({}));
    const { d } = deps({ getKey: () => null });
    expect(await clearSlotAvatar({ ...d, clearSlot })).toEqual({ ok: false, reason: 'locked' });
    expect(clearSlot).not.toHaveBeenCalled();
  });

  it('a clear with nothing set deletes nothing', async () => {
    const { d } = deps();
    const res = await clearSlotAvatar({ ...d, clearSlot: async () => ({}) });
    if (res.ok) await res.deletion;
    expect(d.deleteBlob).not.toHaveBeenCalled();
  });

  it('a lock is thrown for the picker', () => {
    expect(() => avatarChangeOutcome({ ok: false, reason: 'locked' })).toThrow('Unlock');
  });
});
