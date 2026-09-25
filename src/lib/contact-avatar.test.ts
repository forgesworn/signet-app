import { describe, it, expect } from 'vitest';
import { buildContactAvatarPointer, parseContactAvatarPointer, selectLatestPointerByAuthor, CONTACT_AVATAR_KIND, CONTACT_AVATAR_D_TAG } from './contact-avatar';

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
