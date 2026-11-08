import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { DependantIdentity } from '../types';
import { validEditTime, MAX_EDIT_TIME_SKEW_MS } from './dependant-edit-time';
import { toSyncWire, fromSyncWire, mergeDependantWithLocal, isDependantsRicherThan, parsePayload } from './dependants-sync';

const KEY = 'k'.repeat(64);
const PUB = 'c'.repeat(64);

function viewOnly(overrides?: Partial<DependantIdentity>): DependantIdentity {
  return {
    id: PUB, guardianPubkey: 'f'.repeat(64), displayName: 'Kid',
    naturalPerson: { publicKey: PUB, privateKey: '', displayName: 'Kid' },
    persona: { publicKey: '', privateKey: '', displayName: '' },
    derivationPath: 'imported-view-' + PUB.slice(0, 8), createdAt: 1000,
    autonomyStage: 'full-control', primaryKeypair: 'natural-person', ...overrides,
  };
}
const roundTrip = (dep: DependantIdentity) => fromSyncWire(toSyncWire(dep)!, '')!;

describe('saveDependant stamps the edit time (#199)', () => {
  beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); vi.resetModules(); });
  const load = async () => (await (await import('./db')).getDependants('f'.repeat(64), KEY))[0];

  it('stamps a scalar change, not a first save or a device-local change', async () => {
    const db = await import('./db');
    await db.saveDependant(viewOnly(), KEY);
    expect((await load()).updatedAt).toBeUndefined();
    await db.saveDependant({ ...await load(), auditVisibility: 'force-visible' }, KEY);
    expect((await load()).updatedAt).toBeUndefined();
    const before = Date.now();
    await db.saveDependant({ ...await load(), autonomyStage: 'request-approve' }, KEY);
    expect((await load()).updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('a second edit from a stale copy still advances the time', async () => {
    const db = await import('./db');
    await db.saveDependant(viewOnly(), KEY);
    const stale = await load();
    await db.saveDependant({ ...stale, displayName: 'Renamed' }, KEY);
    const first = (await load()).updatedAt!;
    expect(first).toBeGreaterThan(0);
    await db.saveDependant({ ...stale, displayName: 'Renamed', autonomyStage: 'request-approve' }, KEY);
    expect((await load()).updatedAt).toBeGreaterThan(first);
  });

  it('keeps a time the caller set, as a merge carrying the remote edit does', async () => {
    const db = await import('./db');
    await db.saveDependant(viewOnly(), KEY);
    await db.saveDependant({ ...await load(), autonomyStage: 'request-approve', updatedAt: 5000 }, KEY);
    expect((await load()).updatedAt).toBe(5000);
  });
});

describe('merge by edit time (#199)', () => {
  it('a newer local edit keeps its stage over an older remote record', () => {
    const local = viewOnly({ autonomyStage: 'request-approve', updatedAt: 2_000_000 });
    const remote = roundTrip(viewOnly({ autonomyStage: 'full-control', updatedAt: 1_000_000 }));
    const merged = mergeDependantWithLocal(remote, local, 9_999);
    expect(merged.autonomyStage).toBe('request-approve');
    expect(merged.updatedAt).toBe(2_000_000);
  });

  it('a newer remote edit wins', () => {
    const local = viewOnly({ autonomyStage: 'request-approve', updatedAt: 1_000_000 });
    const remote = roundTrip(viewOnly({ autonomyStage: 'full-autonomy', displayName: 'Renamed', updatedAt: 2_000_000 }));
    const merged = mergeDependantWithLocal(remote, local);
    expect(merged.autonomyStage).toBe('full-autonomy');
    expect(merged.displayName).toBe('Renamed');
    expect(merged.updatedAt).toBe(2_000_000);
  });

  it('dates an older build\'s record by its event time', () => {
    const local = viewOnly({ autonomyStage: 'request-approve', updatedAt: 2_000_000 });
    const remote = roundTrip(viewOnly({ autonomyStage: 'full-control' }));
    expect(mergeDependantWithLocal(remote, local, 1_000).autonomyStage).toBe('request-approve');
    const newer = mergeDependantWithLocal(remote, local, 3_000);
    expect(newer.autonomyStage).toBe('full-control');
    expect(newer.updatedAt).toBe(3_000_000);
  });

  it('leaves the record alone when an older build\'s copy changes nothing', () => {
    expect(mergeDependantWithLocal(roundTrip(viewOnly()), viewOnly(), 3_000).updatedAt).toBeUndefined();
    expect(mergeDependantWithLocal(roundTrip(viewOnly()), viewOnly({ updatedAt: 7 }), 3_000).updatedAt).toBe(7);
  });

  it('without a local edit time the remote record wins, as before', () => {
    const remote = roundTrip(viewOnly({ autonomyStage: 'full-autonomy' }));
    expect(mergeDependantWithLocal(remote, viewOnly({ autonomyStage: 'request-approve' }), 1).autonomyStage).toBe('full-autonomy');
  });
});

describe('the edit time on the wire (#199)', () => {
  it('round-trips and is dropped when far in the future or malformed', () => {
    const now = Date.now();
    const wire = (updatedAt: unknown) => JSON.stringify({ v: 1, dependants: [{ ...toSyncWire(viewOnly())!, updatedAt }] });
    expect(parsePayload(wire(now))![0].updatedAt).toBe(now);
    expect(parsePayload(wire(now + MAX_EDIT_TIME_SKEW_MS + 60_000))![0].updatedAt).toBeUndefined();
    expect(parsePayload(wire('soon'))![0].updatedAt).toBeUndefined();
    expect(validEditTime(-1)).toBeUndefined();
  });

  it('republishes a local win, but not an edit time alone', () => {
    const remote = toSyncWire(viewOnly({ autonomyStage: 'full-control' }))!;
    expect(isDependantsRicherThan([viewOnly({ autonomyStage: 'request-approve', updatedAt: 5 })], [remote])).toBe(true);
    expect(isDependantsRicherThan([viewOnly({ updatedAt: 5 })], [remote])).toBe(false);
  });
});
