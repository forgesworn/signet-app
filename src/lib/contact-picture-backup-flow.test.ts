import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { BackupRecordRef, PicturePointer } from './contact-picture-backup';
import {
  backupPossible, consentNeeded, saveOwnPicture, turnBackupOn, declineBackup, removeOwnPicture,
  createPictureBackupRunner, backupRefOf, type BackupEnv, type RunnerContext, type RunnerDeps,
} from './contact-picture-backup-flow';

const KEY = 'unlock-key-for-tests';
const SERVER = 'https://nostr.download';
const POINTER: PicturePointer = { server: SERVER, hash: 'a'.repeat(64), key: 'b'.repeat(64), plainHash: 'c'.repeat(64) };
const ID = (n: number) => n.toString(16).padStart(32, '0');
const file = () => new File([new Uint8Array([1])], 'x.png');
const ref = (contactId = ID(1), extra: Partial<BackupRecordRef> = {}): BackupRecordRef => ({ directoryId: 'owner', contactId, lifecycle: 'active', ...extra });

function env(over: Partial<BackupEnv> = {}): BackupEnv {
  return { encryptionKey: KEY, pairedChild: false, server: SERVER, pref: 'on', ...over };
}

describe('policy predicates', () => {
  it('backup is possible only when not paired-child, a server exists and the preference is on', () => {
    expect(backupPossible(env())).toBe(true);
    expect(backupPossible(env({ pref: undefined }))).toBe(false);
    expect(backupPossible(env({ pref: 'off' }))).toBe(false);
    expect(backupPossible(env({ server: null }))).toBe(false);
    expect(backupPossible(env({ pairedChild: true }))).toBe(false);
  });

  it('the ask is due only when never asked and a backup could be offered', () => {
    expect(consentNeeded(env({ pref: undefined }))).toBe(true);
    expect(consentNeeded(env({ pref: 'on' }))).toBe(false);
    expect(consentNeeded(env({ pref: 'off' }))).toBe(false);
    expect(consentNeeded(env({ pref: undefined, server: null }))).toBe(false);
    expect(consentNeeded(env({ pref: undefined, pairedChild: true }))).toBe(false);
  });
});

describe('saveOwnPicture', () => {
  const setOwn = vi.fn();
  const backupPending = vi.fn();
  beforeEach(() => {
    setOwn.mockReset().mockResolvedValue('saved');
    backupPending.mockReset().mockResolvedValue({ uploaded: 1, failed: 0 });
  });
  const writePointer = vi.fn(async () => {});
  const run = (e: BackupEnv, record = ref()) =>
    saveOwnPicture({ env: e, directoryId: 'owner', contactId: ID(1), file: file(), record, writePointer }, { setOwn: setOwn as never, backupPending: backupPending as never });

  it('pref on: stores pending and uploads just this contact in the background', async () => {
    const pointerBefore = ref(ID(1), { picture: POINTER });
    const r = await run(env(), pointerBefore);
    expect(setOwn).toHaveBeenCalledWith(KEY, 'owner', ID(1), expect.any(File), undefined, { backup: 'pending' });
    expect(r).toMatchObject({ outcome: 'saved', askConsent: false });
    await r.background;
    expect(backupPending).toHaveBeenCalledWith(KEY, { records: [pointerBefore], server: SERVER, writePointer });
  });

  it('returns before the upload settles', async () => {
    let release!: () => void;
    backupPending.mockReturnValue(new Promise(res => { release = () => res({ uploaded: 1, failed: 0 }); }));
    let settled = false;
    const r = await run(env());
    void r.background.then(() => { settled = true; });
    await Promise.resolve();
    expect(r.outcome).toBe('saved');
    expect(settled).toBe(false);
    release();
    await r.background;
  });

  it('an upload that throws never rejects the save', async () => {
    backupPending.mockRejectedValue(new Error('offline'));
    const r = await run(env());
    expect(r.outcome).toBe('saved');
    await expect(r.background).resolves.toBeUndefined();
  });

  it('pref undefined: stores local, asks, no network', async () => {
    const r = await run(env({ pref: undefined }));
    expect(setOwn.mock.calls[0][5]).toEqual({ backup: 'local' });
    expect(r.askConsent).toBe(true);
    expect(backupPending).not.toHaveBeenCalled();
  });

  it('pref off: stores local, no ask, no network', async () => {
    const r = await run(env({ pref: 'off' }));
    expect(setOwn.mock.calls[0][5]).toEqual({ backup: 'local' });
    expect(r.askConsent).toBe(false);
    expect(backupPending).not.toHaveBeenCalled();
  });

  it('paired-child: stores local, nothing else', async () => {
    const r = await run(env({ pairedChild: true, pref: undefined }));
    expect(setOwn.mock.calls[0][5]).toEqual({ backup: 'local' });
    expect(r.askConsent).toBe(false);
    expect(backupPending).not.toHaveBeenCalled();
  });

  it("server '' (uploads off): stores local, no ask, no network", async () => {
    const r = await run(env({ server: null, pref: undefined }));
    expect(setOwn.mock.calls[0][5]).toEqual({ backup: 'local' });
    expect(r.askConsent).toBe(false);
    expect(backupPending).not.toHaveBeenCalled();
  });

  it('a refused picture neither uploads nor asks', async () => {
    setOwn.mockResolvedValue('refused');
    const a = await run(env());
    const b = await run(env({ pref: undefined }));
    expect(a.outcome).toBe('refused');
    expect(b.askConsent).toBe(false);
    expect(backupPending).not.toHaveBeenCalled();
  });
});

describe('turnBackupOn / declineBackup', () => {
  it('"Back them up": preference on, row pending, this contact uploaded', async () => {
    const setPref = vi.fn(async () => {});
    const setBackupState = vi.fn(async () => true);
    const backupPending = vi.fn(async () => ({ uploaded: 1, failed: 0 }));
    const writePointer = vi.fn(async () => {});
    const { background } = await turnBackupOn(
      { env: env({ pref: undefined }), directoryId: 'owner', contactId: ID(1), record: ref(), setPref, writePointer },
      { setBackupState: setBackupState as never, backupPending: backupPending as never },
    );
    await background;
    expect(setPref).toHaveBeenCalledWith('on');
    expect(setBackupState).toHaveBeenCalledWith(KEY, 'owner', ID(1), 'pending');
    expect(backupPending).toHaveBeenCalledWith(KEY, { records: [ref()], server: SERVER, writePointer });
  });

  it('does not upload when the row is gone', async () => {
    const backupPending = vi.fn();
    const { background } = await turnBackupOn(
      { env: env({ pref: undefined }), directoryId: 'owner', contactId: ID(1), record: ref(), setPref: async () => {}, writePointer: async () => {} },
      { setBackupState: (async () => false) as never, backupPending: backupPending as never },
    );
    await background;
    expect(backupPending).not.toHaveBeenCalled();
  });

  it('"Only on this phone" sets the preference off and nothing else', async () => {
    const setPref = vi.fn(async () => {});
    await declineBackup(setPref);
    expect(setPref).toHaveBeenCalledWith('off');
  });
});

describe('removeOwnPicture', () => {
  const removeOwn = vi.fn();
  const deleteBlob = vi.fn();
  const clearPointer = vi.fn();
  beforeEach(() => {
    removeOwn.mockReset().mockResolvedValue(undefined);
    deleteBlob.mockReset().mockResolvedValue(true);
    clearPointer.mockReset().mockResolvedValue(undefined);
  });
  const run = (record: BackupRecordRef | undefined) =>
    removeOwnPicture({ encryptionKey: KEY, directoryId: 'owner', contactId: ID(1), record, clearPointer }, { removeOwn: removeOwn as never, deleteBlob });

  it('with a pointer: clears it, removes the row, then attempts the blob delete', async () => {
    await run(ref(ID(1), { picture: POINTER }));
    expect(clearPointer).toHaveBeenCalledWith(ID(1));
    expect(removeOwn).toHaveBeenCalledWith(KEY, 'owner', ID(1));
    expect(deleteBlob).toHaveBeenCalledWith(POINTER);
    expect(clearPointer.mock.invocationCallOrder[0]).toBeLessThan(removeOwn.mock.invocationCallOrder[0]);
  });

  it('without a pointer: just the row, no operation and no network', async () => {
    await run(ref());
    await run(undefined);
    expect(removeOwn).toHaveBeenCalledTimes(2);
    expect(clearPointer).not.toHaveBeenCalled();
    expect(deleteBlob).not.toHaveBeenCalled();
  });

  it('a failed clear changes nothing and surfaces the error', async () => {
    clearPointer.mockRejectedValue(new Error('scope not ready'));
    await expect(run(ref(ID(1), { picture: POINTER }))).rejects.toThrow('scope not ready');
    expect(removeOwn).not.toHaveBeenCalled();
    expect(deleteBlob).not.toHaveBeenCalled();
  });

  it('a failing blob delete is swallowed', async () => {
    deleteBlob.mockRejectedValue(new Error('offline'));
    await expect(run(ref(ID(1), { picture: POINTER }))).resolves.toBeUndefined();
  });
});

describe('createPictureBackupRunner', () => {
  const ACTOR = { actorPubkey: 'd'.repeat(64), actorDeviceId: 'e'.repeat(32) };
  let order: string[];
  let ctx: RunnerContext;
  let deps: RunnerDeps;
  const fold = vi.fn();
  const restore = vi.fn();
  const backupPending = vi.fn();
  const writeOp = vi.fn();
  const onSweepWrote = vi.fn();

  beforeEach(() => {
    order = [];
    fold.mockReset().mockImplementation(async () => { order.push('fold'); return [ref(), ref(ID(2))]; });
    restore.mockReset().mockImplementation(async () => { order.push('restore'); return { restored: 0, removed: 0, failed: 0 }; });
    backupPending.mockReset().mockImplementation(async () => { order.push('sweep'); return { uploaded: 0, failed: 0 }; });
    writeOp.mockReset().mockResolvedValue(undefined);
    onSweepWrote.mockReset();
    ctx = { encryptionKey: KEY, pairedChild: false, server: SERVER, pref: 'on', actor: ACTOR, onSweepWrote };
    deps = { fold, restore: restore as never, backupPending: backupPending as never, writeOp: writeOp as never };
  });
  const make = () => createPictureBackupRunner(() => ctx, deps);

  it('restores then sweeps, on a fresh fold of the log', async () => {
    await make().runOnUnlock();
    expect(order).toEqual(['fold', 'restore', 'sweep']);
    expect(restore).toHaveBeenCalledWith(KEY, { records: [ref(), ref(ID(2))] });
    expect(backupPending.mock.calls[0][1]).toMatchObject({ records: [ref(), ref(ID(2))], server: SERVER });
  });

  it('runs once per unlock key', async () => {
    const runner = make();
    await runner.runOnUnlock();
    await runner.runOnUnlock();
    expect(restore).toHaveBeenCalledTimes(1);
    ctx = { ...ctx, encryptionKey: 'next-unlock-key' };
    await runner.runOnUnlock();
    expect(restore).toHaveBeenCalledTimes(2);
  });

  it('never runs on a paired-child install, or while locked', async () => {
    ctx = { ...ctx, pairedChild: true };
    await make().runOnUnlock();
    ctx = { ...ctx, pairedChild: false, encryptionKey: null };
    await make().runOnUnlock();
    expect(fold).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it('never overlaps itself: a restore requested mid-run waits for it', async () => {
    let release!: () => void;
    restore.mockImplementationOnce(() => new Promise(res => { order.push('restore-1-start'); release = () => { order.push('restore-1-end'); res({ restored: 0, removed: 0, failed: 0 }); }; }));
    const runner = make();
    const first = runner.runOnUnlock();
    await vi.waitFor(() => expect(order).toContain('restore-1-start'));
    const second = runner.runRestore();
    await Promise.resolve();
    expect(restore).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(order.indexOf('restore-1-end')).toBeLessThan(order.lastIndexOf('restore'));
    expect(restore).toHaveBeenCalledTimes(2);
  });

  it('coalesces restores requested while one is waiting', async () => {
    let release!: () => void;
    restore.mockImplementationOnce(() => new Promise(res => { release = () => res({ restored: 0, removed: 0, failed: 0 }); }));
    const runner = make();
    const first = runner.runOnUnlock();
    await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    const a = runner.runRestore();
    const b = runner.runRestore();
    expect(a).toBe(b);
    release();
    await Promise.all([first, a, b]);
    expect(restore).toHaveBeenCalledTimes(2);
  });

  it('the sweep writes set-picture through the one serialised writer, with the role by directory', async () => {
    backupPending.mockImplementation(async (_k: string, d: { writePointer: (dir: string, cid: string, p: PicturePointer) => Promise<void> }) => {
      await d.writePointer('owner', ID(1), POINTER);
      await d.writePointer('dependant:' + 'f'.repeat(64), ID(2), POINTER);
      return { uploaded: 2, failed: 0 };
    });
    await make().runOnUnlock();
    expect(writeOp).toHaveBeenNthCalledWith(1, KEY, { directoryId: 'owner', contactId: ID(1), action: 'set-picture', value: POINTER, actor: { ...ACTOR, actorRole: 'owner' } });
    expect(writeOp.mock.calls[1][1]).toMatchObject({ directoryId: 'dependant:' + 'f'.repeat(64), actor: { ...ACTOR, actorRole: 'guardian' } });
  });

  it('reloads and bumps (once) only when the sweep wrote an operation', async () => {
    await make().runOnUnlock();
    expect(onSweepWrote).not.toHaveBeenCalled();

    backupPending.mockImplementation(async (_k: string, d: { writePointer: (dir: string, cid: string, p: PicturePointer) => Promise<void> }) => {
      await d.writePointer('owner', ID(1), POINTER);
      await d.writePointer('owner', ID(2), POINTER);
      return { uploaded: 2, failed: 0 };
    });
    ctx = { ...ctx, encryptionKey: 'second-unlock' };
    await make().runOnUnlock();
    expect(onSweepWrote).toHaveBeenCalledTimes(1);
  });

  it('an operation write that fails does not trigger the reload', async () => {
    writeOp.mockRejectedValue(new Error('invalid operation'));
    backupPending.mockImplementation(async (_k: string, d: { writePointer: (dir: string, cid: string, p: PicturePointer) => Promise<void> }) => {
      await d.writePointer('owner', ID(1), POINTER).catch(() => {});
      return { uploaded: 0, failed: 1 };
    });
    await make().runOnUnlock();
    expect(onSweepWrote).not.toHaveBeenCalled();
  });

  it("pref 'off': restore skipped, no sweep", async () => {
    ctx = { ...ctx, pref: 'off' };
    await make().runOnUnlock();
    expect(restore).not.toHaveBeenCalled();
    expect(backupPending).not.toHaveBeenCalled();
  });

  it('pref undefined: restores, but does not sweep', async () => {
    ctx = { ...ctx, pref: undefined };
    await make().runOnUnlock();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(backupPending).not.toHaveBeenCalled();
  });

  it('no sweep without an actor or with uploads off', async () => {
    ctx = { ...ctx, actor: null };
    await make().runOnUnlock();
    ctx = { ...ctx, actor: ACTOR, server: null, encryptionKey: 'again' };
    await make().runOnUnlock();
    expect(backupPending).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledTimes(2);
  });

  it('runRestore restores on a fresh fold and never sweeps; skipped on pref off and paired-child', async () => {
    const runner = make();
    await runner.runRestore();
    expect(order).toEqual(['fold', 'restore']);
    ctx = { ...ctx, pref: 'off' };
    await runner.runRestore();
    ctx = { ...ctx, pref: 'on', pairedChild: true };
    await runner.runRestore();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(backupPending).not.toHaveBeenCalled();
  });

  it('a failing step does not wedge later runs', async () => {
    restore.mockRejectedValueOnce(new Error('boom'));
    const runner = make();
    await runner.runOnUnlock();
    await runner.runRestore();
    expect(restore).toHaveBeenCalledTimes(2);
  });
});

describe('backupRefOf', () => {
  it('carries the pointer and lifecycle, nothing else', () => {
    const r = backupRefOf({ directoryId: 'owner', contactId: ID(1), lifecycle: 'active', picture: POINTER });
    expect(r).toEqual({ directoryId: 'owner', contactId: ID(1), lifecycle: 'active', picture: POINTER });
    expect(backupRefOf({ directoryId: 'owner', contactId: ID(1), lifecycle: 'removed' })).toEqual({ directoryId: 'owner', contactId: ID(1), lifecycle: 'removed' });
  });
});

describe('save with a real row store', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.resetModules();
  });

  it('pref on: row goes pending, the upload runs, setPicture is called and the row ends synced', async () => {
    const flow = await import('./contact-picture-backup-flow');
    const backup = await import('./contact-picture-backup');
    const pictures = await import('./contact-pictures');
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 0xff, 0xd9]);
    const writePointer = vi.fn(async () => {});
    const states: (string | undefined)[] = [];
    await pictures.loadContactPictures(KEY);
    const r = await flow.saveOwnPicture(
      { env: env(), directoryId: 'owner', contactId: ID(1), file: new File([new Uint8Array([1])], 'x.png'), record: ref(), writePointer },
      {
        setOwn: (k, d, c, f, crop, o) => pictures.setOwnContactPicture(k, d, c, f, crop, { ...o, thumbnail: async () => new Uint8Array(JPEG) }),
        backupPending: async (k, d) => {
          states.push(pictures.cachedOwnPictureState(k, 'owner', ID(1))?.backup);
          return backup.backupPendingPictures(k, { ...d, upload: async jpeg => ({ ...POINTER, plainHash: bytesToHex(sha256(jpeg)) }) });
        },
      },
    );
    expect(r.outcome).toBe('saved');
    await r.background;
    expect(states).toEqual(['pending']);
    expect(writePointer).toHaveBeenCalledWith('owner', ID(1), expect.objectContaining({ hash: POINTER.hash }));
    expect(pictures.cachedOwnPictureState(KEY, 'owner', ID(1))?.backup).toBe('synced');
  });
});
