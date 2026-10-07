import { describe, it, expect, vi } from 'vitest';
import { runFollowsImport, type FollowsImportDeps } from './follows-import-flow';
import type { FollowList } from './nostr-follows';
import type { ContactRecord } from '../types';

const PERSONA = '1'.repeat(64);
const hex = (i: number) => 'f' + i.toString(16).padStart(63, '0');

function list(n: number, over: Partial<FollowList> = {}): FollowList {
  return {
    eventId: 'e'.repeat(64), createdAt: 1_700_000_000,
    follows: Array.from({ length: n }, (_, i) => ({ pubkey: hex(i + 1) })),
    total: n, truncated: false, ...over,
  };
}

function deps(over: Partial<FollowsImportDeps> = {}) {
  const recogniseContacts = vi.fn(async (entries: { pubkey: string }[], _owner?: string, _method?: string, _caption?: string) => ({
    added: entries.length, linked: 0, unchanged: 0, skippedRemoved: 0, covered: entries.length, trimmed: false, requested: entries.length,
  }));
  const recordImport = vi.fn(async () => undefined);
  const base: FollowsImportDeps = {
    personaPubkey: PERSONA, personaName: 'Alex', records: [],
    fetchList: async () => list(3),
    fetchNames: async () => new Map(),
    recogniseContacts, recordImport, now: () => 1_800_000_000_000,
  };
  return { d: { ...base, ...over }, recogniseContacts, recordImport };
}

function record(i: number, over: Partial<ContactRecord> = {}): ContactRecord {
  return {
    directoryId: 'owner', contactId: i.toString(16).padStart(32, '0'), type: 'person', displayName: `Gone ${i}`, tier: 'ken', roles: [],
    identities: [{ itemId: (i + 100).toString(16).padStart(32, '0'), pubkey: hex(i), provenance: 'direct', verification: 'unverified', addedAt: 1 }],
    contactMethods: [], accessGrants: [], lifecycle: 'active', createdAt: 1, updatedAt: 1, createdByActorRole: 'owner',
    createdByOperationId: 'a'.repeat(32), vouches: [], ceilings: [], blocks: [],
    listMemberships: [{ ownerIdentityPubkey: PERSONA, addedAt: 1 }, { ownerIdentityPubkey: '2'.repeat(64), addedAt: 1 }], primaryIdentityPubkey: PERSONA,
    origins: [{ id: (i + 200).toString(16).padStart(32, '0'), ownerIdentityPubkey: PERSONA, method: 'import', addedAt: 1, caption: 'Nostr follows' }],
    ...over,
  } as ContactRecord;
}

describe('runFollowsImport', () => {
  it('reports unreachable and a missing or empty list without writing anything', async () => {
    for (const [fetched, expected] of [
      ['unreachable', { status: 'unreachable' }],
      [null, { status: 'empty', found: false }],
      [list(0), { status: 'empty', found: true }],
    ] as const) {
      const { d, recogniseContacts, recordImport } = deps({ fetchList: async () => fetched });
      expect(await runFollowsImport(d)).toEqual(expected);
      expect(recogniseContacts).not.toHaveBeenCalled();
      expect(recordImport).not.toHaveBeenCalled();
    }
  });

  it('imports with the persona list, names (petname first) and the Nostr follows caption, then records it', async () => {
    const { d, recogniseContacts, recordImport } = deps({
      fetchList: async () => list(3, { follows: [{ pubkey: hex(1), petname: 'Mine' }, { pubkey: hex(2) }, { pubkey: hex(3) }] }),
      fetchNames: async () => new Map([[hex(1), 'Theirs'], [hex(2), 'Named Two']]),
    });
    const out = await runFollowsImport(d);
    expect(recogniseContacts).toHaveBeenCalledTimes(1);
    const [entries, owner, method, caption] = recogniseContacts.mock.calls[0] as unknown as [{ pubkey: string; displayName: string }[], string, string, string];
    expect(entries.map(e => e.displayName).slice(0, 2)).toEqual(['Mine', 'Named Two']);
    expect(entries[2].displayName).toMatch(/^npub1/);
    expect([owner, method, caption]).toEqual([PERSONA, 'import', 'Nostr follows']);
    expect(recordImport).toHaveBeenCalledWith({ eventId: 'e'.repeat(64), createdAt: 1_700_000_000, importedAt: 1_800_000_000_000, count: 3 });
    expect(out).toMatchObject({ status: 'done', total: 3, added: 3, covered: 3, trimmedNotice: null });
  });

  it('takes only the 1000 MOST RECENT follows and says so', async () => {
    const fetchNames = vi.fn(async (_pubkeys: string[]) => new Map<string, string>());
    const { d, recogniseContacts } = deps({ fetchList: async () => list(1500), fetchNames });
    const out = await runFollowsImport(d);
    const entries = recogniseContacts.mock.calls[0][0] as { pubkey: string }[];
    expect(entries).toHaveLength(1000);
    expect(entries[0].pubkey).toBe(hex(501));
    expect(entries[999].pubkey).toBe(hex(1500));
    expect(fetchNames.mock.calls[0][0]).toHaveLength(1000);
    expect(out).toMatchObject({
      status: 'done', total: 1500, covered: 1000,
      trimmedNotice: "Alex follows 1500 accounts. Signet imported the 1000 most recent — that's all it can back up alongside your other contacts.",
    });
  });

  it('reports the size-line trim the hook applied', async () => {
    const { d, recordImport } = deps({
      fetchList: async () => list(1000),
      recogniseContacts: async () => ({ added: 930, linked: 0, unchanged: 0, skippedRemoved: 0, covered: 930, trimmed: true, requested: 1000 }),
    });
    const out = await runFollowsImport(d);
    expect(out).toMatchObject({ covered: 930, trimmedNotice: expect.stringContaining('Signet imported the 930 most recent') });
    expect(recordImport).toHaveBeenCalledTimes(1);
  });

  it('records nothing when the backup had no room for even one', async () => {
    const { d, recordImport } = deps({
      fetchList: async () => list(50),
      recogniseContacts: async () => ({ added: 0, linked: 0, unchanged: 0, skippedRemoved: 0, covered: 0, trimmed: true, requested: 50 }),
    });
    const out = await runFollowsImport(d);
    expect(recordImport).not.toHaveBeenCalled();
    expect(out).toMatchObject({ status: 'done', covered: 0, trimmedNotice: "Alex follows 50 accounts, but there's no room left in your contacts backup to add them." });
  });

  it('offers to take unfollowed contacts off the list, comparing against the WHOLE newest list', async () => {
    const records = [record(1), record(2), record(3)];
    const { d } = deps({ records, fetchList: async () => list(1500, { follows: Array.from({ length: 1500 }, (_, i) => ({ pubkey: hex(i + 1000) })) }) });
    const out = await runFollowsImport(d);
    // hex(1..3) are not among hex(1000..2499): all three are unfollowed.
    expect(out).toMatchObject({ status: 'done', unfollowed: [{ name: 'Gone 1' }, { name: 'Gone 2' }, { name: 'Gone 3' }], unfollowedKept: 0 });
    // A follow cut off by the 1000 cap (hex(1000)..hex(1499)) is still followed, so not offered.
    const { d: d2 } = deps({ records: [record(1000), record(1400)], fetchList: async () => list(1500, { follows: Array.from({ length: 1500 }, (_, i) => ({ pubkey: hex(i + 1000) })) }) });
    expect(await runFollowsImport(d2)).toMatchObject({ unfollowed: [] });
  });

  it('never offers unfollows when part of the kind 3 was not read', async () => {
    const { d } = deps({ records: [record(1)], fetchList: async () => list(3, { truncated: true, total: 6000 }) });
    expect(await runFollowsImport(d)).toMatchObject({ unfollowed: [], unfollowedKept: 0 });
  });

  it('counts unfollowed contacts whose only list this is as kept, not removable', async () => {
    const solo = record(1, { listMemberships: [{ ownerIdentityPubkey: PERSONA, addedAt: 1 }] });
    const { d } = deps({ records: [solo], fetchList: async () => list(2, { follows: [{ pubkey: hex(50) }, { pubkey: hex(51) }] }) });
    expect(await runFollowsImport(d)).toMatchObject({ unfollowed: [], unfollowedKept: 1 });
  });
});

describe('runFollowsImport — profile pictures', () => {
  it('without consent fetches names only and never touches pictures', async () => {
    const fetchProfiles = vi.fn(async () => new Map());
    const syncPictures = vi.fn();
    const fetchNames = vi.fn(async () => new Map([[hex(1), 'Ann']]));
    const { d, recogniseContacts } = deps({ pictures: false, fetchProfiles, syncPictures, fetchNames });
    const out = await runFollowsImport(d);
    expect(fetchProfiles).not.toHaveBeenCalled();
    expect(syncPictures).not.toHaveBeenCalled();
    expect(fetchNames).toHaveBeenCalled();
    expect(recogniseContacts.mock.calls[0][0][0]).toMatchObject({ pubkey: hex(1), displayName: 'Ann' });
    expect(out.status === 'done' && out.pictures).toBeFalsy();
  });

  it('with consent, one kind-0 fetch gives names and the pictures for the filed follows', async () => {
    const fetchProfiles = vi.fn(async () => new Map([[hex(1), { displayName: 'Ann', pictureUrl: 'https://x/a.jpg' }]]));
    const syncPictures = vi.fn(async () => ({ downloaded: 1, failed: 0, removed: 0, unchanged: 0 }));
    const fetchNames = vi.fn();
    const { d, recogniseContacts } = deps({ pictures: true, fetchProfiles, syncPictures, fetchNames });
    const out = await runFollowsImport(d);
    expect(fetchNames).not.toHaveBeenCalled();
    expect(recogniseContacts.mock.calls[0][0][0]).toMatchObject({ pubkey: hex(1), displayName: 'Ann' });
    expect(syncPictures).toHaveBeenCalledWith([hex(1), hex(2), hex(3)], expect.any(Map));
    expect(out.status === 'done' && out.pictures).toEqual({ downloaded: 1, failed: 0 });
  });

  it('pictures only for the most recent follows the backup could hold', async () => {
    const syncPictures = vi.fn(async () => ({ downloaded: 0, failed: 0, removed: 0, unchanged: 0 }));
    const { d } = deps({
      pictures: true, fetchProfiles: async () => new Map(), syncPictures,
      recogniseContacts: vi.fn(async () => ({ added: 1, linked: 0, unchanged: 0, skippedRemoved: 0, covered: 1, trimmed: true, requested: 3 })),
    });
    await runFollowsImport(d);
    expect(syncPictures).toHaveBeenCalledWith([hex(3)], expect.any(Map));
  });

  it('every relay unreachable: names import as short npubs, pictures are flagged and not synced', async () => {
    const syncPictures = vi.fn();
    const { d, recogniseContacts } = deps({ pictures: true, fetchProfiles: async () => 'unreachable' as const, syncPictures });
    const out = await runFollowsImport(d);
    expect(syncPictures).not.toHaveBeenCalled();
    expect(recogniseContacts).toHaveBeenCalled();
    expect(recogniseContacts.mock.calls[0][0][0].pubkey).toBe(hex(1));
    expect(out.status).toBe('done');
    expect(out.status === 'done' && out.pictures).toEqual({ downloaded: 0, failed: 0, unreachable: true });
  });

  it('a picture failure never fails the import', async () => {
    const { d } = deps({
      pictures: true,
      fetchProfiles: async () => new Map([[hex(1), { pictureUrl: 'https://x/a.jpg' }]]),
      syncPictures: async () => { throw new Error('boom'); },
    });
    const out = await runFollowsImport(d);
    expect(out.status).toBe('done');
    expect(out.status === 'done' && out.pictures).toEqual({ downloaded: 0, failed: 1 });
  });
});
