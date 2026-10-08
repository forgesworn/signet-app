import { describe, it, expect, vi, beforeEach } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'signet-protocol';
import type { ContactRecord } from '../types';

// Per-relay transport mock (same shape as existing-profile.test.ts). Events
// are REAL signed events, so the signature check runs unmocked.
const relayMock = vi.hoisted(() => ({
  fetchReturns: {} as Record<string, unknown[]>,
  connectThrows: new Set<string>(),
  hangs: new Set<string>(),
  queried: [] as string[],
  filters: [] as unknown[][],
}));
vi.mock('./lookup-relay', () => ({
  fetchFromRelay: async (url: string, filters: unknown[], timeoutMs: number): Promise<unknown[] | null> => {
    relayMock.queried.push(url);
    relayMock.filters.push(filters);
    if (relayMock.connectThrows.has(url)) return null;
    if (relayMock.hangs.has(url)) return new Promise(resolve => setTimeout(() => resolve(null), timeoutMs));
    return relayMock.fetchReturns[url] ?? [];
  },
}));

import {
  parseFollowList,
  fetchFollowList,
  fetchFollowNames,
  fetchKind0Profiles,
  nameFollows,
  takeMostRecent,
  computeUnfollows,
  shortNpub,
  followsTrimmedCopy,
  MAX_FOLLOW_TAGS,
  MAX_FOLLOWS_PER_IMPORT,
  FOLLOWS_ORIGIN_CAPTION,
} from './nostr-follows';
import { PROFILE_LOOKUP_RELAYS } from './existing-profile';

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const A = 'wss://a.example';
const B = 'wss://b.example';

function hex(i: number): string { return 'f' + i.toString(16).padStart(63, '0'); }

function kind3(tags: string[][], createdAt: number, key = sk): NostrEvent {
  return finalizeEvent({ kind: 3, created_at: createdAt, tags, content: '' }, key) as unknown as NostrEvent;
}
/** What a relay would hand us: plain JSON, with a signature that does not match. */
function forge<T extends object>(event: T): T {
  return JSON.parse(JSON.stringify({ ...event, sig: '0'.repeat(128) })) as T;
}
function kind0(content: object, createdAt: number, key: Uint8Array): NostrEvent {
  return finalizeEvent({ kind: 0, created_at: createdAt, tags: [], content: JSON.stringify(content) }, key) as unknown as NostrEvent;
}

beforeEach(() => {
  relayMock.fetchReturns = {};
  relayMock.connectThrows = new Set();
  relayMock.hangs = new Set();
  relayMock.queried = [];
  relayMock.filters = [];
});

describe('parseFollowList', () => {
  const ev = (tags: string[][]) => ({ id: 'i'.repeat(64), pubkey: pk, created_at: 77, tags });

  it('keeps lowercase 64-hex p tags only, drops self, dedupes, in tag order', () => {
    const list = parseFollowList(ev([
      ['p', hex(1)],
      ['e', hex(9)],
      ['p', 'not hex'],
      ['p', hex(2).toUpperCase()],
      ['p', pk],
      ['p', hex(3)],
      ['p', hex(1)],
      ['p'],
    ]));
    expect(list.follows.map(f => f.pubkey)).toEqual([hex(3), hex(1)]);
    expect(list.eventId).toBe('i'.repeat(64));
    expect(list.createdAt).toBe(77);
    expect(list.truncated).toBe(false);
    expect(list.total).toBe(2);
  });

  it('a duplicate keeps its LAST position (most recent = latest in tag order)', () => {
    const list = parseFollowList(ev([['p', hex(1)], ['p', hex(2)], ['p', hex(1)], ['p', hex(3)]]));
    expect(list.follows.map(f => f.pubkey)).toEqual([hex(2), hex(1), hex(3)]);
  });

  it('sanitises the petname (control and bidi stripped, capped at 100) and validates the relay hint', () => {
    const list = parseFollowList(ev([
      ['p', hex(1), 'wss://hint.example', 'Pal‮\u0007 One'],
      ['p', hex(2), 'ws://evil.example', 'x'.repeat(300)],
      ['p', hex(3), '', '   '],
    ]));
    expect(list.follows[0]).toEqual({ pubkey: hex(1), relay: 'wss://hint.example', petname: 'Pal One' });
    expect(list.follows[1].petname).toHaveLength(100);
    expect(list.follows[1].relay).toBeUndefined();
    expect(list.follows[2]).toEqual({ pubkey: hex(3) });
  });

  it('reads at most 5000 p tags, from the END, and reports the raw count', () => {
    const tags = Array.from({ length: MAX_FOLLOW_TAGS + 250 }, (_, i) => ['p', hex(i + 1)]);
    const list = parseFollowList(ev(tags));
    expect(list.truncated).toBe(true);
    expect(list.follows).toHaveLength(MAX_FOLLOW_TAGS);
    expect(list.follows[0].pubkey).toBe(hex(251));
    expect(list.follows[list.follows.length - 1].pubkey).toBe(hex(MAX_FOLLOW_TAGS + 250));
    expect(list.total).toBe(MAX_FOLLOW_TAGS + 250);
  });

  it('survives a malformed tag array', () => {
    expect(parseFollowList({ id: 'i', pubkey: pk, created_at: 1, tags: 'nope' as unknown as string[][] }).follows).toEqual([]);
    expect(parseFollowList(ev([null as unknown as string[], 'p' as unknown as string[], ['p', hex(1)]])).follows).toHaveLength(1);
  });
});

describe('takeMostRecent', () => {
  it('keeps the LAST n, in order', () => {
    expect(takeMostRecent([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
    expect(takeMostRecent([1, 2], 3)).toEqual([1, 2]);
    expect(MAX_FOLLOWS_PER_IMPORT).toBe(1000);
    expect(takeMostRecent(Array.from({ length: 1500 }, (_, i) => i))[0]).toBe(500);
  });
});

describe('fetchFollowList', () => {
  it('queries the caller relays plus the lookup relays, kind 3, author pinned', async () => {
    await fetchFollowList(pk, [A]);
    expect(relayMock.queried.sort()).toEqual([A, ...PROFILE_LOOKUP_RELAYS].sort());
    expect(relayMock.filters[0]).toEqual([{ kinds: [3], authors: [pk], limit: 5 }]);
  });

  it('newest kind 3 wins across relays', async () => {
    relayMock.fetchReturns[A] = [kind3([['p', hex(1)]], 100)];
    relayMock.fetchReturns[B] = [kind3([['p', hex(1)], ['p', hex(2)]], 200)];
    const r = await fetchFollowList(pk, [A, B]);
    expect(r).not.toBeNull();
    expect(r).not.toBe('unreachable');
    if (r && r !== 'unreachable') {
      expect(r.createdAt).toBe(200);
      expect(r.follows.map(f => f.pubkey)).toEqual([hex(1), hex(2)]);
    }
  });

  it('drops an event authored by someone else, however new', async () => {
    const stranger = generateSecretKey();
    relayMock.fetchReturns[A] = [kind3([['p', hex(9)]], 900, stranger), kind3([['p', hex(1)]], 100)];
    const r = await fetchFollowList(pk, [A]);
    expect(r && r !== 'unreachable' && r.follows.map(f => f.pubkey)).toEqual([hex(1)]);
  });

  it('drops a bad signature, however new, and falls back to the genuine older one', async () => {
    const forged = forge(kind3([['p', hex(9)]], 900));
    relayMock.fetchReturns[A] = [forged, kind3([['p', hex(1)]], 100)];
    const r = await fetchFollowList(pk, [A]);
    expect(r && r !== 'unreachable' && r.follows.map(f => f.pubkey)).toEqual([hex(1)]);
  });

  it('null when relays answered with no follow list, unreachable when none answered', async () => {
    expect(await fetchFollowList(pk, [A])).toBeNull();
    relayMock.connectThrows = new Set([A, ...PROFILE_LOOKUP_RELAYS]);
    expect(await fetchFollowList(pk, [A])).toBe('unreachable');
  });

  it('rejects a malformed pubkey without touching a relay', async () => {
    expect(await fetchFollowList('nope', [A])).toBeNull();
    expect(relayMock.queried).toEqual([]);
  });
});

describe('fetchFollowNames', () => {
  it('batches authors in chunks of 200 and returns display_name, then name', async () => {
    const keys = Array.from({ length: 3 }, () => generateSecretKey());
    const pubs = keys.map(k => getPublicKey(k));
    relayMock.fetchReturns[A] = [
      kind0({ display_name: 'First Display', name: 'first' }, 10, keys[0]),
      kind0({ name: 'second' }, 10, keys[1]),
      kind0({ about: 'no name here' }, 10, keys[2]),
    ];
    const names = await fetchFollowNames(pubs, [A], 500);
    expect(names.get(pubs[0])).toBe('First Display');
    expect(names.get(pubs[1])).toBe('second');
    expect(names.has(pubs[2])).toBe(false);
  });

  it('sends 450 authors as three filters of at most 200, in one request per relay', async () => {
    const pubs = Array.from({ length: 450 }, (_, i) => hex(i + 1));
    await fetchFollowNames(pubs, [A], 500);
    const requestToA = relayMock.filters[relayMock.queried.indexOf(A)] as { authors: string[]; kinds: number[] }[];
    expect(requestToA.map(f => f.authors.length)).toEqual([200, 200, 50]);
    expect(requestToA.every(f => f.kinds[0] === 0)).toBe(true);
  });

  it('newest signed profile wins, a forged newer one and a stranger are ignored', async () => {
    const k = generateSecretKey();
    const pub = getPublicKey(k);
    const stranger = generateSecretKey();
    relayMock.fetchReturns[A] = [
      kind0({ name: 'old' }, 10, k),
      kind0({ name: 'newer' }, 20, k),
      forge(kind0({ name: 'forged' }, 30, k)),
      kind0({ name: 'impostor' }, 40, stranger),
    ];
    const names = await fetchFollowNames([pub], [A], 500);
    expect(names.get(pub)).toBe('newer');
    expect(names.size).toBe(1);
  });

  it('a relay that never answers does not hold the names past the budget', async () => {
    const k = generateSecretKey();
    relayMock.hangs = new Set([A]);
    relayMock.fetchReturns[B] = [kind0({ name: 'from b' }, 10, k)];
    const started = Date.now();
    const names = await fetchFollowNames([getPublicKey(k)], [A, B], 150);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(names.get(getPublicKey(k))).toBe('from b');
  });

  it('leaves out a profile whose content does not parse (so a refresh keeps the stored picture)', async () => {
    const broken = generateSecretKey();
    const plain = generateSecretKey();
    relayMock.fetchReturns[A] = [
      finalizeEvent({ kind: 0, created_at: 10, tags: [], content: 'not json {' }, broken) as unknown as NostrEvent,
      kind0({ about: 'no picture' }, 10, plain),
    ];
    const profiles = await fetchKind0Profiles([getPublicKey(broken), getPublicKey(plain)], [A], 500);
    if (profiles === 'unreachable') throw new Error('relay was reachable');
    expect(profiles.has(getPublicKey(broken))).toBe(false);
    // A parsed profile with no picture is still present: that one means "no picture now".
    expect(profiles.get(getPublicKey(plain))).toEqual({});
  });

  it('says "unreachable" only when every relay was unreachable', async () => {
    const k = generateSecretKey();
    relayMock.connectThrows = new Set([A, B, ...PROFILE_LOOKUP_RELAYS]);
    expect(await fetchKind0Profiles([getPublicKey(k)], [A, B], 500)).toBe('unreachable');
  });

  it('one relay answering with nothing is an empty map, not "unreachable"', async () => {
    const k = generateSecretKey();
    relayMock.connectThrows = new Set([B, ...PROFILE_LOOKUP_RELAYS]);
    relayMock.fetchReturns[A] = [];
    const out = await fetchKind0Profiles([getPublicKey(k)], [A, B], 500);
    expect(out).toBeInstanceOf(Map);
    expect((out as Map<string, unknown>).size).toBe(0);
  });

  it('an empty pubkey list is an empty map, even with every relay down', async () => {
    relayMock.connectThrows = new Set([A, ...PROFILE_LOOKUP_RELAYS]);
    const out = await fetchKind0Profiles([], [A]);
    expect(out).toBeInstanceOf(Map);
    expect((out as Map<string, unknown>).size).toBe(0);
  });

  it('fetchFollowNames with every relay unreachable is an empty map', async () => {
    const k = generateSecretKey();
    relayMock.connectThrows = new Set([A, ...PROFILE_LOOKUP_RELAYS]);
    const names = await fetchFollowNames([getPublicKey(k)], [A], 500);
    expect(names).toBeInstanceOf(Map);
    expect(names.size).toBe(0);
  });

  it('nothing to look up costs no relay call', async () => {
    expect((await fetchFollowNames([], [A])).size).toBe(0);
    expect(relayMock.queried).toEqual([]);
  });
});

describe('nameFollows', () => {
  it('petname first, then the profile name, then a short npub', () => {
    const out = nameFollows(
      [{ pubkey: hex(1), petname: 'Mine' }, { pubkey: hex(2) }, { pubkey: hex(3) }],
      new Map([[hex(1), 'Theirs'], [hex(2), 'Theirs Two']]),
    );
    expect(out[0].displayName).toBe('Mine');
    expect(out[1].displayName).toBe('Theirs Two');
    expect(out[2].displayName).toBe(shortNpub(hex(3)));
    expect(out[2].displayName).toMatch(/^npub1[a-z0-9]{5}…[a-z0-9]{6}$/);
  });
});

describe('computeUnfollows', () => {
  const PERSONA = '1'.repeat(64);
  const OTHER = '2'.repeat(64);

  function rec(i: number, over: Partial<ContactRecord> = {}): ContactRecord {
    return {
      directoryId: 'owner', contactId: i.toString(16).padStart(32, '0'), type: 'person', displayName: `Contact ${i}`, tier: 'ken',
      roles: [], identities: [{ itemId: (i + 100).toString(16).padStart(32, '0'), pubkey: hex(i), provenance: 'direct', verification: 'unverified', addedAt: 1 }],
      contactMethods: [], accessGrants: [], lifecycle: 'active', createdAt: 1, updatedAt: 1, createdByActorRole: 'owner',
      createdByOperationId: 'a'.repeat(32), vouches: [], ceilings: [], blocks: [],
      listMemberships: [{ ownerIdentityPubkey: PERSONA, addedAt: 1 }], primaryIdentityPubkey: PERSONA,
      origins: [{ id: (i + 200).toString(16).padStart(32, '0'), ownerIdentityPubkey: PERSONA, method: 'import', addedAt: 1, caption: FOLLOWS_ORIGIN_CAPTION }],
      ...over,
    } as ContactRecord;
  }

  it('lists imported contacts no longer in the newest kind 3; leaves those still followed', () => {
    const records = [rec(1), rec(2), rec(3)];
    const out = computeUnfollows(records, PERSONA, new Set([hex(2)]));
    expect(out.removable.concat(out.onlyOnThisList).map(r => r.contactId)).toEqual([records[0].contactId, records[2].contactId]);
  });

  it('splits those whose list membership is their only one (unlinking would remove the contact)', () => {
    const shared = rec(1, {
      listMemberships: [{ ownerIdentityPubkey: PERSONA, addedAt: 1 }, { ownerIdentityPubkey: OTHER, addedAt: 1 }],
    });
    const solo = rec(2);
    const out = computeUnfollows([shared, solo], PERSONA, new Set());
    expect(out.removable.map(r => r.contactId)).toEqual([shared.contactId]);
    expect(out.onlyOnThisList.map(r => r.contactId)).toEqual([solo.contactId]);
  });

  it('ignores contacts that did not come from a follows import for THIS persona', () => {
    const manual = rec(1, { origins: [{ id: 'a'.repeat(32), ownerIdentityPubkey: PERSONA, method: 'manual', addedAt: 1 }] });
    const otherCaption = rec(2, { origins: [{ id: 'b'.repeat(32), ownerIdentityPubkey: PERSONA, method: 'import', addedAt: 1, caption: 'Something else' }] });
    const otherPersona = rec(3, { origins: [{ id: 'c'.repeat(32), ownerIdentityPubkey: OTHER, method: 'import', addedAt: 1, caption: FOLLOWS_ORIGIN_CAPTION }] });
    const noOrigins = rec(4, { origins: undefined });
    const out = computeUnfollows([manual, otherCaption, otherPersona, noOrigins], PERSONA, new Set());
    expect(out.removable).toEqual([]);
    expect(out.onlyOnThisList).toEqual([]);
  });

  it('ignores removed contacts and contacts no longer in this persona\'s list', () => {
    const removed = rec(1, { lifecycle: 'removed' });
    const unlinked = rec(2, { listMemberships: [{ ownerIdentityPubkey: PERSONA, addedAt: 1, removedAt: 2 }], primaryIdentityPubkey: undefined });
    const out = computeUnfollows([removed, unlinked], PERSONA, new Set());
    expect(out.removable.length + out.onlyOnThisList.length).toBe(0);
  });

  it('a contact with several keys is still followed if ANY key is in the new list', () => {
    const two = rec(1);
    two.identities.push({ itemId: 'd'.repeat(32), pubkey: hex(50), provenance: 'direct', verification: 'unverified', addedAt: 1 });
    const out = computeUnfollows([two], PERSONA, new Set([hex(50)]));
    expect(out.removable.length + out.onlyOnThisList.length).toBe(0);
  });
});

describe('followsTrimmedCopy', () => {
  it('says plainly how many it follows and how many were imported', () => {
    expect(followsTrimmedCopy('Alex', 1500, 940)).toBe(
      "Alex follows 1500 accounts. Signet imported the 940 most recent — that's all it can back up alongside your other contacts.",
    );
  });
});
