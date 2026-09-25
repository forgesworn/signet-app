import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { classifyFetchOutcome } from './sync-seen';

// Give each test a fully isolated IndexedDB instance, same pattern as
// db.test.ts — the db module holds a singleton connection promise, so it
// must be re-imported fresh after swapping the global.
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
});

async function freshSyncSeen() {
  return await import('./sync-seen');
}

describe('getSyncSeen / setSyncSeen', () => {
  it('returns null when nothing has been seen for a d-tag', async () => {
    const { getSyncSeen } = await freshSyncSeen();
    expect(await getSyncSeen('a'.repeat(64), 'signet:personas')).toBeNull();
  });

  it('round-trips a seen marker for a d-tag', async () => {
    const { getSyncSeen, setSyncSeen } = await freshSyncSeen();
    await setSyncSeen('a'.repeat(64), 'signet:personas', { eventId: 'e'.repeat(64), createdAt: 1000 });
    expect(await getSyncSeen('a'.repeat(64), 'signet:personas')).toEqual({ eventId: 'e'.repeat(64), createdAt: 1000 });
  });

  it('keeps separate markers per d-tag', async () => {
    const { getSyncSeen, setSyncSeen } = await freshSyncSeen();
    await setSyncSeen('a'.repeat(64), 'signet:personas', { eventId: 'a'.repeat(64), createdAt: 1000 });
    await setSyncSeen('a'.repeat(64), 'signet:dependants', { eventId: 'b'.repeat(64), createdAt: 2000 });
    expect(await getSyncSeen('a'.repeat(64), 'signet:personas')).toEqual({ eventId: 'a'.repeat(64), createdAt: 1000 });
    expect(await getSyncSeen('a'.repeat(64), 'signet:dependants')).toEqual({ eventId: 'b'.repeat(64), createdAt: 2000 });
  });

  it('overwrites the marker for the same d-tag on a later call', async () => {
    const { getSyncSeen, setSyncSeen } = await freshSyncSeen();
    await setSyncSeen('a'.repeat(64), 'signet:personas', { eventId: 'a'.repeat(64), createdAt: 1000 });
    await setSyncSeen('a'.repeat(64), 'signet:personas', { eventId: 'c'.repeat(64), createdAt: 3000 });
    expect(await getSyncSeen('a'.repeat(64), 'signet:personas')).toEqual({ eventId: 'c'.repeat(64), createdAt: 3000 });
  });

  it('lives in its own store — never touches encrypted preferences', async () => {
    const { getSyncSeen, setSyncSeen } = await freshSyncSeen();
    const db = await import('./db');
    const KEY = 'k'.repeat(64);
    await db.savePreferences({ id: 'current', theme: 'dark', relayUrl: 'wss://relay.example' }, KEY);

    await setSyncSeen('a'.repeat(64), 'signet:personas', { eventId: 'a'.repeat(64), createdAt: 1000 });

    const prefs = await db.getPreferences(KEY);
    expect(prefs.theme).toBe('dark');
    expect(prefs.relayUrl).toBe('wss://relay.example');
    // The marker is readable with no key at all — that's the point of the
    // dedicated store (a rail can classify its fetch before unlock).
    expect(await getSyncSeen('a'.repeat(64), 'signet:personas')).toEqual({ eventId: 'a'.repeat(64), createdAt: 1000 });
    expect(await db.getSyncSeen(JSON.stringify(['a'.repeat(64), 'signet:personas']))).toEqual({
      dTag: JSON.stringify(['a'.repeat(64), 'signet:personas']), eventId: 'a'.repeat(64), createdAt: 1000,
    });
  });

  it('is cleared by purgeAllUserData', async () => {
    const { getSyncSeen, setSyncSeen } = await freshSyncSeen();
    const db = await import('./db');
    await setSyncSeen('a'.repeat(64), 'signet:personas', { eventId: 'a'.repeat(64), createdAt: 1000 });
    await db.purgeAllUserData();
    expect(await getSyncSeen('a'.repeat(64), 'signet:personas')).toBeNull();
  });
});

describe('classifyFetchOutcome', () => {
  it('present when found is true, regardless of reachability/seen', () => {
    expect(classifyFetchOutcome({ found: true, reachableRelays: 1, seenBefore: true })).toBe('present');
    expect(classifyFetchOutcome({ found: true, reachableRelays: 0, seenBefore: false })).toBe('present');
  });

  it('unreachable when nothing found and no relay was reachable', () => {
    expect(classifyFetchOutcome({ found: false, reachableRelays: 0, seenBefore: true })).toBe('unreachable');
    expect(classifyFetchOutcome({ found: false, reachableRelays: 0, seenBefore: false })).toBe('unreachable');
  });

  it('never-seen when nothing found, relays reachable, never seen before', () => {
    expect(classifyFetchOutcome({ found: false, reachableRelays: 2, seenBefore: false })).toBe('never-seen');
  });

  it('missing-after-seen when nothing found, relays reachable, but we had seen it before', () => {
    expect(classifyFetchOutcome({ found: false, reachableRelays: 2, seenBefore: true })).toBe('missing-after-seen');
  });
});


describe('author isolation and upgrade', () => {
  const alice = 'a'.repeat(64);
  const bob = 'b'.repeat(64);
  it('never mistakes another author’s backup for a missing backup, including after reload', async () => {
    let api = await freshSyncSeen();
    await api.setSyncSeen(alice, 'signet:personas', { eventId: 'alice-event', createdAt: 7 });
    expect(await api.getSyncSeen(bob, 'signet:personas')).toBeNull();
    await api.setSyncSeen(bob, 'signet:personas', { eventId: 'bob-event', createdAt: 8 });
    vi.resetModules();
    api = await freshSyncSeen();
    expect(await api.getSyncSeen(alice.toUpperCase(), 'signet:personas')).toEqual({ eventId: 'alice-event', createdAt: 7 });
    expect(await api.getSyncSeen(bob, 'signet:personas')).toEqual({ eventId: 'bob-event', createdAt: 8 });
  });

  it('does not guess who owns a legacy bare-tag marker', async () => {
    const db = await import('./db');
    await db.putSyncSeen({ dTag: 'signet:personas', eventId: 'unknown-owner', createdAt: 99 });
    const api = await freshSyncSeen();
    expect(await api.getSyncSeen(alice, 'signet:personas')).toBeNull();
    expect(await api.getSyncSeen(bob, 'signet:personas')).toBeNull();
  });

  it('preserves an author-derived v2 checkpoint’s sequence during upgrade', async () => {
    const { tagFor } = await import('./contacts-v2-sync');
    const tag = tagFor(alice, 'checkpoint');
    const db = await import('./db');
    await db.putSyncSeen({ dTag: tag, eventId: 'checkpoint', createdAt: 99, seq: 42 });
    const api = await freshSyncSeen();
    expect(await api.getSyncSeen(alice, tag, { legacyAuthorScopedTag: true }))
      .toEqual({ eventId: 'checkpoint', createdAt: 99, seq: 42 });
    // Migration persists the scoped row; ordinary reads retain the guard too.
    expect((await api.getSyncSeen(alice, tag))?.seq).toBe(42);
    expect(await api.getSyncSeen(bob, tagFor(bob, 'checkpoint'), { legacyAuthorScopedTag: true })).toBeNull();
  });
});
