// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
  localStorage.clear();
});

const freshDb = () => import('./db');
const PK_A = 'a'.repeat(64);
const PK_B = 'B'.repeat(64);

async function seedV27() {
  const v27 = await openDB('my-signet', 27, {
    upgrade(d) {
      d.createObjectStore('authorizedSites', { keyPath: 'id' }).createIndex('origin', 'origin');
    },
  });
  await v27.put('authorizedSites', {
    id: 's1', origin: 'https://one.example', name: 'One', keypairUsed: 'persona',
    pubkeyShared: PK_A, authorizedAt: 100, lastUsedAt: 300,
    shareHandle: true, consumerDisplayName: 'My one',
  });
  await v27.put('authorizedSites', {
    id: 's2', origin: 'https://two.example', name: 'Two', keypairUsed: 'persona',
    pubkeyShared: PK_B, authorizedAt: 200, lastUsedAt: 250,
  });
  await v27.put('authorizedSites', {
    id: 's3', origin: 'https://bad.example', name: 'Bad', keypairUsed: 'persona',
    pubkeyShared: 'nope', authorizedAt: 1, lastUsedAt: 1,
  });
  v27.close();
}

describe('DB v28 — knownPlaces', () => {
  it('survives bad legacy rows: skips them, migrates the good one, DB opens at 28', async () => {
    const v27 = await openDB('my-signet', 27, {
      upgrade(d) {
        d.createObjectStore('authorizedSites', { keyPath: 'id' }).createIndex('origin', 'origin');
      },
    });
    await v27.put('authorizedSites', {
      id: 'g', origin: 'https://good.example', name: 'Good', keypairUsed: 'persona',
      pubkeyShared: PK_A, authorizedAt: 1, lastUsedAt: 2,
    });
    await v27.put('authorizedSites', {
      id: 'n', origin: 'https://num.example', name: 42, keypairUsed: 'persona',
      pubkeyShared: PK_B, authorizedAt: 1, lastUsedAt: 2,
    });
    await v27.put('authorizedSites', {
      id: 'o', origin: 'https://obj.example', name: 'Obj', keypairUsed: 'persona',
      pubkeyShared: 'c'.repeat(64), authorizedAt: 1, lastUsedAt: 2, consumerDisplayName: { a: 1 },
    });
    v27.close();
    const db = await freshDb();
    const raw = await db.getDb();
    expect(raw.version).toBe(28);
    const places = await db.listKnownPlaces();
    expect(places.map((p) => p.placeKey)).toContain('https://good.example');
    expect(places.find((p) => p.placeKey === 'https://good.example')?.name).toBe('Good');
  });

  it('migrates every authorizedSites row from a v27 database and keeps authorizedSites', async () => {
    await seedV27();
    const db = await freshDb();
    const places = (await db.listKnownPlaces()).sort((a, b) => a.name.localeCompare(b.name));
    expect(places).toHaveLength(2);
    expect(places[0]).toMatchObject({
      id: `https://one.example:${PK_A}`,
      pubkey: PK_A,
      placeKey: 'https://one.example',
      kind: 'sign-in',
      name: 'One',
      alias: 'My one',
      origin: 'https://one.example',
      channel: 'unknown',
      signer: 'unknown',
      firstAt: 100,
      lastAt: 300,
      uses: 1,
      shared: { handle: true },
    });
    expect(places[1].pubkey).toBe('b'.repeat(64));
    expect(places[1].alias).toBeUndefined();
    expect(await db.getAuthorizedSites()).toHaveLength(3);
  });

  it('creates the store with its two indexes', async () => {
    const db = await freshDb();
    const raw = await db.getDb();
    expect(raw.version).toBe(28);
    const tx = raw.transaction('knownPlaces', 'readonly');
    expect(tx.store.keyPath).toBe('id');
    expect(Array.from(tx.store.indexNames).sort()).toEqual(['by-place', 'by-pubkey']);
  });

  it('upsert is one merge: keeps firstAt, alias and pinned, bumps uses and lastAt', async () => {
    const db = await freshDb();
    const input = {
      placeKey: 'https://x.example', pubkey: PK_A, kind: 'sign-in' as const, name: 'X',
      alias: 'First alias', origin: 'https://x.example',
      channel: 'browser' as const, signer: 'local' as const, shared: { handle: false },
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1_000_000));
    const first = await db.upsertKnownPlace(input);
    expect(first).toMatchObject({ uses: 1, firstAt: 1000, lastAt: 1000, alias: 'First alias' });
    await db.setKnownPlaceAlias(first!.id, 'Mine');
    await db.setKnownPlacePinned(first!.id, true);
    vi.setSystemTime(new Date(2_000_000));
    const second = await db.upsertKnownPlace({ ...input, alias: 'Consumer rename', channel: 'phone-app', shared: { handle: true, picture: true } });
    vi.useRealTimers();
    expect(second).toMatchObject({
      uses: 2, firstAt: 1000, lastAt: 2000, alias: 'Mine', pinned: true,
      channel: 'phone-app', shared: { handle: true, picture: true },
    });
    expect(await db.listKnownPlaces()).toHaveLength(1);
  });

  it('concurrent upserts for one id never lose a use', async () => {
    const db = await freshDb();
    const input = {
      placeKey: 'pkg:com.x', pubkey: PK_A, kind: 'nip55' as const, name: 'X',
      channel: 'nip55' as const, signer: 'local' as const, shared: {},
    };
    await Promise.all([db.upsertKnownPlace(input), db.upsertKnownPlace(input), db.upsertKnownPlace(input)]);
    const [row] = await db.listKnownPlaces();
    expect(row.uses).toBe(3);
  });

  it('rejects a bad pubkey, lowercases a good one, caps and sanitises names', async () => {
    const db = await freshDb();
    expect(await db.upsertKnownPlace({
      placeKey: 'https://x.example', pubkey: 'zz', kind: 'sign-in', name: 'X',
      channel: 'unknown', signer: 'unknown', shared: {},
    })).toBeNull();
    const row = await db.upsertKnownPlace({
      placeKey: 'https://x.example', pubkey: PK_B, kind: 'sign-in', name: `A‮B${'z'.repeat(100)}`,
      channel: 'unknown', signer: 'unknown', shared: {},
    });
    expect(row!.pubkey).toBe('b'.repeat(64));
    expect(row!.name).not.toContain('‮');
    expect(row!.name.length).toBeLessThanOrEqual(64);
  });

  it('queries by pubkey and deletes one row, or every row for a place', async () => {
    const db = await freshDb();
    const base = { kind: 'sign-in' as const, name: 'X', channel: 'unknown' as const, signer: 'unknown' as const, shared: {} };
    await db.upsertKnownPlace({ ...base, placeKey: 'https://x.example', pubkey: PK_A });
    await db.upsertKnownPlace({ ...base, placeKey: 'https://x.example', pubkey: PK_B });
    await db.upsertKnownPlace({ ...base, placeKey: 'https://y.example', pubkey: PK_A });
    expect(await db.listKnownPlacesForPubkey(PK_A.toUpperCase())).toHaveLength(2);
    await db.deleteKnownPlace(`https://y.example:${PK_A}`);
    expect(await db.listKnownPlaces()).toHaveLength(2);
    await db.deleteKnownPlacesForPlace('https://x.example');
    expect(await db.listKnownPlaces()).toHaveLength(0);
  });

  it('notifies subscribers on write and delete', async () => {
    const db = await freshDb();
    const seen = vi.fn();
    const off = db.subscribeKnownPlaces(seen);
    await db.upsertKnownPlace({
      placeKey: 'https://x.example', pubkey: PK_A, kind: 'sign-in', name: 'X',
      channel: 'unknown', signer: 'unknown', shared: {},
    });
    await db.deleteKnownPlace(`https://x.example:${PK_A}`);
    off();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('purgeAllUserData clears the store and the NIP-55 grants key', async () => {
    const db = await freshDb();
    await db.upsertKnownPlace({
      placeKey: 'https://x.example', pubkey: PK_A, kind: 'sign-in', name: 'X',
      channel: 'unknown', signer: 'unknown', shared: {},
    });
    localStorage.setItem('signet.nip55.grants', '{"com.x":{}}');
    const purged = vi.fn();
    db.subscribePurge(purged);
    await db.purgeAllUserData();
    expect(await db.listKnownPlaces()).toEqual([]);
    expect(localStorage.getItem('signet.nip55.grants')).toBeNull();
    expect(purged).toHaveBeenCalledTimes(1);
  });
});
