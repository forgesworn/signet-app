import { describe, it, expect, vi, beforeEach } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { buildContactAvatarPointer, parseContactAvatarPointer, selectLatestPointerByAuthor, selectPointerLookup, contactAvatarCoordinate, CONTACT_AVATAR_KIND, CONTACT_AVATAR_D_TAG } from './contact-avatar';

const fetchEvents = vi.hoisted(() => vi.fn());
vi.mock('./relay-service', () => ({ fetchEvents, publishEvent: vi.fn() }));

const PK = 'c'.repeat(64);
const OTHER_PK = 'e'.repeat(64);
const HASH = 'd'.repeat(64);
const HASH2 = 'f'.repeat(64);
const URL = 'https://blossom.example/upload';
const URL2 = 'https://blossom.example/other';

/** Minimal event shape selectLatestPointerByAuthor consumes. */
function ev(pubkey: string, created_at: number, content: object | string) {
  return { pubkey, created_at, content: typeof content === 'string' ? content : JSON.stringify(content) };
}

describe('buildContactAvatarPointer', () => {
  it('builds a kind-30078 replaceable event with the right d-tag + content', () => {
    const ev = buildContactAvatarPointer({ hash: HASH, blossomUrl: URL }, PK);
    expect(ev.kind).toBe(CONTACT_AVATAR_KIND);
    expect(ev.pubkey).toBe(PK);
    expect(ev.tags).toContainEqual(['d', CONTACT_AVATAR_D_TAG]);
    expect(JSON.parse(ev.content)).toEqual({ hash: HASH, blossomUrl: URL });
  });
});

describe('parseContactAvatarPointer', () => {
  it('round-trips a built pointer', () => {
    const ev = buildContactAvatarPointer({ hash: HASH, blossomUrl: URL }, PK);
    expect(parseContactAvatarPointer(ev)).toEqual({ hash: HASH, blossomUrl: URL });
  });
  it('rejects malformed JSON', () => expect(parseContactAvatarPointer({ content: 'nope' })).toBeNull());
  it('rejects a bad hash', () =>
    expect(parseContactAvatarPointer({ content: JSON.stringify({ hash: 'zz', blossomUrl: URL }) })).toBeNull());
  it('rejects a non-https blossom url', () =>
    expect(parseContactAvatarPointer({ content: JSON.stringify({ hash: HASH, blossomUrl: 'http://evil.example' }) })).toBeNull());
  it('rejects an over-long blossom url (anti-IDB-stuffing)', () =>
    expect(parseContactAvatarPointer({ content: JSON.stringify({ hash: HASH, blossomUrl: 'https://b.example/' + 'a'.repeat(600) }) })).toBeNull());
  // G1: the retraction tombstone is a replaceable kind-30078 with content "{}".
  // Resolution must return null so the latest replaceable neutralizes the
  // pointer even on relays that ignore the kind-5 deletion.
  it('rejects the empty-object tombstone content (retraction neutralizes resolution)', () =>
    expect(parseContactAvatarPointer({ content: '{}' })).toBeNull());
});

describe('selectLatestPointerByAuthor', () => {
  it('picks the newest event authored by the requested pubkey', () => {
    const events = [
      ev(PK, 100, { hash: HASH, blossomUrl: URL }),
      ev(PK, 300, { hash: HASH2, blossomUrl: URL2 }),
      ev(PK, 200, { hash: HASH, blossomUrl: URL }),
    ];
    expect(selectLatestPointerByAuthor(events, PK)).toEqual({ hash: HASH2, blossomUrl: URL2 });
  });

  it('ignores events authored by a different pubkey (relay-forged author)', () => {
    const events = [
      ev(OTHER_PK, 500, { hash: HASH2, blossomUrl: URL2 }), // newer but wrong author
      ev(PK, 100, { hash: HASH, blossomUrl: URL }),
    ];
    expect(selectLatestPointerByAuthor(events, PK)).toEqual({ hash: HASH, blossomUrl: URL });
  });

  it('matches the author case-insensitively', () => {
    const events = [ev(PK.toUpperCase(), 100, { hash: HASH, blossomUrl: URL })];
    expect(selectLatestPointerByAuthor(events, PK)).toEqual({ hash: HASH, blossomUrl: URL });
  });

  it('returns null when no event matches the author', () => {
    const events = [ev(OTHER_PK, 100, { hash: HASH, blossomUrl: URL })];
    expect(selectLatestPointerByAuthor(events, PK)).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(selectLatestPointerByAuthor([], PK)).toBeNull();
  });

  it('returns null when the newest matching event is malformed', () => {
    const events = [
      ev(PK, 100, { hash: HASH, blossomUrl: URL }),
      ev(PK, 300, 'not-json'), // newest but unparseable → null (no silent older fallback)
    ];
    expect(selectLatestPointerByAuthor(events, PK)).toBeNull();
  });
});


describe('selectPointerLookup: a retraction is not "nothing found" (S4)', () => {
  const del = (pubkey: string, created_at: number, author = PK) => ({
    pubkey, created_at, kind: 5, content: 'contact-avatar retracted', tags: [['a', contactAvatarCoordinate(author)]],
  });
  const ptr = (created_at: number) => ({ ...ev(PK, created_at, { hash: HASH, blossomUrl: URL }), kind: CONTACT_AVATAR_KIND });

  it('no event at all is null, the only case the stored fallback may serve', () => {
    expect(selectPointerLookup([], PK)).toBeNull();
    expect(selectPointerLookup([ev(OTHER_PK, 100, { hash: HASH, blossomUrl: URL })], PK)).toBeNull();
  });
  it('a live pointer is returned', () => {
    expect(selectPointerLookup([ptr(100)], PK)).toEqual({ hash: HASH, blossomUrl: URL });
  });
  it('the {} tombstone as the newest event is retracted, never an older pointer', () => {
    expect(selectPointerLookup([ptr(100), { ...ev(PK, 300, {}), kind: CONTACT_AVATAR_KIND }], PK)).toBe('retracted');
    expect(selectPointerLookup([{ ...ev(PK, 300, {}), kind: CONTACT_AVATAR_KIND }], PK)).toBe('retracted');
  });
  it('a kind-5 deletion of the pointer coordinate is retracted, alone or newer than the pointer', () => {
    expect(selectPointerLookup([del(PK, 200)], PK)).toBe('retracted');
    expect(selectPointerLookup([ptr(100), del(PK, 200)], PK)).toBe('retracted');
  });
  it('a pointer re-published after a deletion is live again', () => {
    expect(selectPointerLookup([del(PK, 100), ptr(200)], PK)).toEqual({ hash: HASH, blossomUrl: URL });
  });
  it('ignores a deletion by someone else and a deletion of another coordinate', () => {
    expect(selectPointerLookup([del(OTHER_PK, 200, OTHER_PK), ptr(100)], PK)).toEqual({ hash: HASH, blossomUrl: URL });
    expect(selectPointerLookup([{ ...del(PK, 200), tags: [['a', `30078:${PK}:something-else`]] }, ptr(100)], PK)).toEqual({ hash: HASH, blossomUrl: URL });
    expect(selectPointerLookup([{ ...del(PK, 200), tags: [['e', 'f'.repeat(64)]] }], PK)).toBeNull();
  });
});

describe('fetchContactAvatarPointer asks for the deletion too and reports a retraction', () => {
  beforeEach(() => fetchEvents.mockReset());

  function signed(kind: number, created_at: number, tags: string[][], content: string, sk: Uint8Array) {
    // A real signed event: verifiedAuthoredEvents checks the signature.
    return import('nostr-tools/pure').then(({ finalizeEvent }) => finalizeEvent({ kind, created_at, tags, content }, sk));
  }

  it('a kind-5 returned with no pointer reads retracted, and the query carries both filters', async () => {
    const { fetchContactAvatarPointer } = await import('./contact-avatar');
    const sk = schnorr.utils.randomSecretKey();
    const pk = Buffer.from(schnorr.getPublicKey(sk)).toString('hex');
    fetchEvents.mockResolvedValue([await signed(5, 200, [['a', contactAvatarCoordinate(pk)]], 'contact-avatar retracted', sk)]);
    expect(await fetchContactAvatarPointer(pk, 'wss://relay.example')).toBe('retracted');
    const filters = fetchEvents.mock.calls[0][0];
    expect(filters).toHaveLength(2);
    expect(filters[1]).toMatchObject({ kinds: [5], authors: [pk], '#a': [contactAvatarCoordinate(pk)] });
    fetchEvents.mockResolvedValue([]);
    expect(await fetchContactAvatarPointer(pk, 'wss://relay.example')).toBeNull();
  });
});
