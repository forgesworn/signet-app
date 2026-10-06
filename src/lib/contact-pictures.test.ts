import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { ContactRecord } from '../types';
import type { Kind0Profile } from './nostr-follows';

const KEY = 'unlock-key-for-tests';
const JPEG = (n: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, 0xff, 0xd9]);
const PK = (c: string) => c.repeat(64);

// Pass-through spy: counts every picture-key derivation (and any other).
const derive = vi.hoisted(() => ({ calls: 0 }));
vi.mock('./aes-crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('./aes-crypto')>();
  return {
    ...real,
    deriveAesKey: (...args: Parameters<typeof real.deriveAesKey>) => { derive.calls += 1; return real.deriveAesKey(...args); },
  };
});

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  derive.calls = 0;
});

async function load() {
  const pictures = await import('./contact-pictures');
  const db = await import('./db');
  const crypto = await import('./contact-picture-crypto');
  return { ...pictures, db, crypto };
}

/** What App.tsx does on lock. */
function lock(m: Awaited<ReturnType<typeof load>>): void {
  m.crypto.forgetContactPictureKeys();
  m.forgetContactPictureCache();
}

function record(directoryId: string, contactId: string, pubkey: string | null, extra: Partial<ContactRecord> = {}): ContactRecord {
  return {
    directoryId, contactId, type: 'person', displayName: 'X', tier: 'ken', roles: [],
    identities: pubkey ? [{ itemId: '0'.repeat(32), pubkey, verification: 'unverified', addedAt: 1 }] : [],
    contactMethods: [], accessGrants: [], lifecycle: 'active', createdAt: 1, updatedAt: 1,
    createdByActorRole: 'owner', createdByOperationId: '0'.repeat(32), vouches: [], ceilings: [], blocks: [],
    ...extra,
  } as unknown as ContactRecord;
}

describe('applyKind0Pictures', () => {
  it('leaves unfetched, deletes pictureless, skips unchanged, downloads changed', async () => {
    const { applyKind0Pictures } = await load();
    const stored = new Map<string, string | undefined>([
      [PK('a'), 'https://x/a.jpg'], // unchanged
      [PK('b'), 'https://x/b-old.jpg'], // changed
      [PK('c'), 'https://x/c.jpg'], // picture gone
      [PK('d'), 'https://x/d.jpg'], // not fetched
    ]);
    const profiles = new Map<string, Kind0Profile>([
      [PK('a'), { pictureUrl: 'https://x/a.jpg' }],
      [PK('b'), { pictureUrl: 'https://x/b-new.jpg' }],
      [PK('c'), { displayName: 'C' }],
      [PK('e'), { pictureUrl: 'https://x/e.jpg' }], // new
    ]);
    const download = vi.fn(async () => new Uint8Array([1]));
    const save = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const r = await applyKind0Pictures([PK('a'), PK('b'), PK('c'), PK('d'), PK('e')], profiles, {
      stored, download, thumbnail: async () => JPEG(1), save, remove,
    });
    expect(r).toEqual({ downloaded: 2, failed: 0, removed: 1, unchanged: 1 });
    expect(download.mock.calls.map(c => (c as unknown as [string])[0]).sort()).toEqual(['https://x/b-new.jpg', 'https://x/e.jpg']);
    expect(remove).toHaveBeenCalledWith(PK('c'));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('counts a failed download or refused image and keeps the old thumbnail', async () => {
    const { applyKind0Pictures } = await load();
    const save = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const r = await applyKind0Pictures([PK('a'), PK('b')], new Map([
      [PK('a'), { pictureUrl: 'https://x/a2.jpg' }],
      [PK('b'), { pictureUrl: 'https://x/b.jpg' }],
    ]), {
      stored: new Map([[PK('a'), 'https://x/a1.jpg']]),
      download: async (url) => url.includes('a2') ? null : new Uint8Array([1]),
      thumbnail: async () => null,
      save, remove,
    });
    expect(r).toEqual({ downloaded: 0, failed: 2, removed: 0, unchanged: 0 });
    expect(save).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('runs at most four downloads at once', async () => {
    const { applyKind0Pictures } = await load();
    let active = 0;
    let peak = 0;
    const pubkeys = Array.from({ length: 12 }, (_, i) => i.toString(16).padStart(64, '0'));
    const profiles = new Map(pubkeys.map(p => [p, { pictureUrl: `https://x/${p}.jpg` }]));
    await applyKind0Pictures(pubkeys, profiles, {
      stored: new Map(),
      download: async () => {
        active += 1; peak = Math.max(peak, active);
        await new Promise(r => setTimeout(r, 1));
        active -= 1;
        return new Uint8Array([1]);
      },
      thumbnail: async () => JPEG(1), save: async () => {}, remove: async () => {},
    });
    expect(peak).toBe(4);
  });
});

describe('contactPicturePubkeys', () => {
  it('takes each live contact primary key across directories, skipping removed, quarantined and keyless', async () => {
    const { contactPicturePubkeys } = await load();
    const dep = `dependant:${'9'.repeat(64)}`;
    expect(contactPicturePubkeys([
      record('owner', '1'.repeat(32), PK('a')),
      record(dep, '2'.repeat(32), PK('a')),
      record(dep, '3'.repeat(32), PK('b')),
      record('owner', '4'.repeat(32), PK('c'), { lifecycle: 'removed' } as Partial<ContactRecord>),
      record('quarantine', '5'.repeat(32), PK('d')),
      record('owner', '6'.repeat(32), null),
    ]).sort()).toEqual([PK('a'), PK('b')]);
  });
});

describe('refreshContactPictures (real store)', () => {
  it('only re-downloads changed URLs, deletes removed pictures, and never touches own pictures', async () => {
    const m = await load();
    const own = '7'.repeat(32);
    const records = [record('owner', own, PK('a')), record('owner', '8'.repeat(32), PK('b'))];
    const download = vi.fn(async () => new Uint8Array([1]));
    const thumbnail = vi.fn(async () => JPEG(2));

    await m.setOwnContactPicture(KEY, 'owner', own, new Blob([new Uint8Array([1])]), { thumbnail: async () => JPEG(9) });

    // First run: both pictures new.
    let fetchProfiles = vi.fn(async () => new Map<string, Kind0Profile>([
      [PK('a'), { pictureUrl: 'https://x/a.jpg' }],
      [PK('b'), { pictureUrl: 'https://x/b.jpg' }],
    ]));
    expect(await m.refreshContactPictures(KEY, { listRecords: async () => records, fetchProfiles, download, thumbnail }))
      .toEqual({ downloaded: 2, failed: 0, removed: 0, unchanged: 0 });
    expect(fetchProfiles).toHaveBeenCalledWith([PK('a'), PK('b')]);

    // Second run: a unchanged, b's picture removed from the profile.
    download.mockClear();
    fetchProfiles = vi.fn(async () => new Map<string, Kind0Profile>([
      [PK('a'), { pictureUrl: 'https://x/a.jpg' }],
      [PK('b'), {}],
    ]));
    expect(await m.refreshContactPictures(KEY, { listRecords: async () => records, fetchProfiles, download, thumbnail }))
      .toEqual({ downloaded: 0, failed: 0, removed: 1, unchanged: 1 });
    expect(download).not.toHaveBeenCalled();

    // Third run: nothing fetched at all — everything is left as it is.
    fetchProfiles = vi.fn(async () => new Map<string, Kind0Profile>());
    await m.refreshContactPictures(KEY, { listRecords: async () => records, fetchProfiles, download, thumbnail });

    const ids = (await m.db.listContactPictures(KEY)).map(p => p.id).sort();
    expect(ids).toEqual([`kind0:${PK('a')}`, `own:owner:${own}`]);
    const ownPic = await m.db.getContactPicture(`own:owner:${own}`, KEY);
    expect(Array.from(ownPic?.jpeg ?? [])).toEqual(Array.from(JPEG(9)));
  }, 30_000);

  it('makes no request at all when there are no contact keys', async () => {
    const m = await load();
    const fetchProfiles = vi.fn();
    await m.refreshContactPictures(KEY, { listRecords: async () => [record('owner', '1'.repeat(32), null)], fetchProfiles });
    expect(fetchProfiles).not.toHaveBeenCalled();
  });
});

describe('a lock while a refresh is running', () => {
  const records = Array.from({ length: 6 }, (_, i) =>
    record('owner', (i + 1).toString(16).repeat(32), (i + 1).toString(16).repeat(64)));
  const profiles = () => new Map<string, Kind0Profile>(records.map(r => {
    const pk = r.identities[0].pubkey;
    return [pk, { pictureUrl: `https://x/${pk.slice(0, 4)}.jpg` }];
  }));

  it('stops the downloads: nothing stored, no key re-derived, no cache rebuilt', async () => {
    const m = await load();
    await m.db.saveContactPicture({ id: `kind0:${PK('a')}`, jpeg: JPEG(4), sourceUrl: 'https://x/a.jpg', fetchedAt: 1, updatedAt: 1 }, KEY);
    await m.loadContactPictures(KEY);
    let downloads = 0;
    let derivedAtLock = -1;
    const thumbnail = vi.fn(async () => JPEG(2));
    const r = await m.refreshContactPictures(KEY, {
      listRecords: async () => records,
      fetchProfiles: async () => profiles(),
      download: async () => {
        downloads += 1;
        if (downloads === 1) { lock(m); derivedAtLock = derive.calls; }
        await new Promise(resolve => setTimeout(resolve, 5));
        return new Uint8Array([1]);
      },
      thumbnail,
    });
    expect(r.downloaded).toBe(0);
    // The lock landed inside the first download, before any other lane started one.
    expect(downloads).toBe(1);
    expect(thumbnail).not.toHaveBeenCalled();
    expect(derive.calls).toBe(derivedAtLock);
    expect(m.cachedContactPicture(KEY, `kind0:${PK('a')}`)).toBeNull();
    // Only the row written before the lock is in the store (read under a fresh unlock).
    expect((await m.db.listContactPictures(KEY)).map(p => p.id)).toEqual([`kind0:${PK('a')}`]);
  });

  it('a lock while the profiles are fetched loads and stores nothing', async () => {
    const m = await load();
    await m.db.saveContactPicture({ id: `kind0:${PK('a')}`, jpeg: JPEG(4), sourceUrl: 'https://x/a.jpg', fetchedAt: 1, updatedAt: 1 }, KEY);
    lock(m);
    derive.calls = 0;
    const download = vi.fn(async () => new Uint8Array([1]));
    const r = await m.refreshContactPictures(KEY, {
      listRecords: async () => records,
      fetchProfiles: async () => { lock(m); return profiles(); },
      download,
      thumbnail: async () => JPEG(2),
    });
    expect(r).toEqual({ downloaded: 0, failed: 0, removed: 0, unchanged: 0 });
    expect(download).not.toHaveBeenCalled();
    expect(derive.calls).toBe(0);
    expect(m.cachedContactPicture(KEY, `kind0:${PK('a')}`)).toBeNull();
  });

  it('a stale run cannot derive the key, save or list on its own', async () => {
    const m = await load();
    const gen = m.crypto.contactPictureGeneration();
    lock(m);
    derive.calls = 0;
    await expect(m.db.saveContactPicture({ id: `kind0:${PK('a')}`, jpeg: JPEG(4), fetchedAt: 1, updatedAt: 1 }, KEY, gen))
      .rejects.toBeInstanceOf(m.crypto.ContactPicturesLockedError);
    await m.loadContactPictures(KEY, gen);
    expect(derive.calls).toBe(0);
    expect(await m.db.listContactPictures(KEY)).toEqual([]);
  });
});

describe('own pictures and the cache', () => {
  it('own picture is cached, removable, and a refused file stores nothing', async () => {
    const m = await load();
    const id = '1'.repeat(32);
    expect(await m.setOwnContactPicture(KEY, 'owner', id, new Blob([new Uint8Array([1])]), { thumbnail: async () => null })).toBe(false);
    await m.loadContactPictures(KEY);
    expect(m.cachedContactPicture(KEY, `own:owner:${id}`)).toBeNull();
    expect(await m.setOwnContactPicture(KEY, 'owner', id, new Blob([new Uint8Array([1])]), { thumbnail: async () => JPEG(3) })).toBe(true);
    expect(m.cachedContactPicture(KEY, `own:owner:${id}`)).not.toBeNull();
    expect(m.cachedContactPicture('other-key', `own:owner:${id}`)).toBeNull();
    await m.removeOwnContactPicture(KEY, 'owner', id);
    expect(m.cachedContactPicture(KEY, `own:owner:${id}`)).toBeNull();
    expect(await m.db.listContactPictures(KEY)).toEqual([]);
  });

  it('a fresh unlock loads stored pictures once, and lock forgets them', async () => {
    const m = await load();
    await m.db.saveContactPicture({ id: `kind0:${PK('a')}`, jpeg: JPEG(4), sourceUrl: 'https://x/a.jpg', fetchedAt: 1, updatedAt: 1 }, KEY);
    await m.loadContactPictures(KEY);
    expect(m.cachedContactPicture(KEY, `kind0:${PK('a')}`)).not.toBeNull();
    m.forgetContactPictureCache();
    expect(m.cachedContactPicture(KEY, `kind0:${PK('a')}`)).toBeNull();
  });
});
