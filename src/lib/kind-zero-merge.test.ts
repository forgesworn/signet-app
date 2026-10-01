import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./relay-service', () => ({
  publishEvent: vi.fn().mockResolvedValue({ ok: true, message: '1/1 relays accepted' }),
  fetchEvents: vi.fn().mockResolvedValue([]),
  getRelayUrl: vi.fn(() => 'wss://relay.trotters.cc'),
}));
const existingMock = vi.hoisted(() => ({ result: null as unknown }));
vi.mock('./existing-profile', () => ({
  fetchExistingProfile: vi.fn(async () => existingMock.result),
}));

import { publishEvent } from './relay-service';
import { fetchExistingProfile } from './existing-profile';
import {
  adoptPublishedIntoCard,
  buildKindZeroContent,
  parseKindZeroContent,
  mergeKindZeroContent,
  toPublicProfileBase,
  publishPublicProfile,
} from './public-profile-publish';
import type { PublicProfileBase, PublicProfileConfig } from '../types';
import type { SigningBackend } from './signing-backend';

const cfg = (p: Partial<PublicProfileConfig> = {}): PublicProfileConfig => ({ displayName: 'Alice', ...p });
const LONG_ABOUT = 'First line.\nSecond line, with an emoji 👩🏽‍💻 and a ZWJ.\n\n' + 'x'.repeat(900);

/** What a rich client (Amethyst-style) published. */
const AMETHYST = {
  name: 'alice_handle',
  display_name: 'Alice',
  about: LONG_ABOUT,
  picture: 'https://img.example/a.png',
  nip05: 'alice@example.com',
  website: 'https://alice.example',
  lud06: 'lnurl1abc',
  bot: false,
  birthday: { year: 1990, month: 1, day: 2 },
  custom_thing: { nested: [1, 2, 3] },
};
const BASE_CONTENT = JSON.stringify(AMETHYST);
const BASE_TAGS = [['i', 'github:alice', 'proof'], ['client', 'amethyst']];

/** The card exactly as "Match it in Signet" seeds it. */
function matchedCard(over: Partial<PublicProfileConfig> = {}): PublicProfileConfig {
  const p = parseKindZeroContent(BASE_CONTENT)!;
  return { displayName: p.displayName!, about: p.about, pictureUrl: p.pictureUrl, nip05: p.nip05, website: p.website, ...over };
}

function merge(over: { config?: PublicProfileConfig; contentBase?: { content: string; tags: string[][] }; comparisonContent?: string | undefined } = {}) {
  return mergeKindZeroContent({
    comparisonContent: 'comparisonContent' in over ? over.comparisonContent : BASE_CONTENT,
    contentBase: over.contentBase ?? { content: BASE_CONTENT, tags: BASE_TAGS },
    config: over.config ?? matchedCard(),
    fallbackDisplayName: 'Alice',
  });
}

describe('mergeKindZeroContent — three-way, lossless', () => {
  it('returns the content base VERBATIM and its tags when nothing was edited', () => {
    const r = merge();
    expect(r.content).toBe(BASE_CONTENT);
    expect(r.tags).toEqual(BASE_TAGS);
    expect(r.merged).toBe(true);
    // Tags are copied, not shared.
    expect(r.tags).not.toBe(BASE_TAGS);
  });

  it('keeps an unchanged multi-line, emoji-bearing, over-500-char about raw', () => {
    const r = merge();
    const obj = JSON.parse(r.content);
    expect(obj.about).toBe(LONG_ABOUT);
    expect(obj.about.length).toBeGreaterThan(500);
    expect(obj.about).toContain('\n');
    expect(obj.about).toContain('‍');
  });

  it('keeps unknown keys (bot, birthday, lud06, nested) and tags when another field changes', () => {
    const r = merge({ config: matchedCard({ website: 'https://new.example' }) });
    const obj = JSON.parse(r.content);
    expect(obj.website).toBe('https://new.example');
    expect(obj.bot).toBe(false);
    expect(obj.birthday).toEqual({ year: 1990, month: 1, day: 2 });
    expect(obj.lud06).toBe('lnurl1abc');
    expect(obj.custom_thing).toEqual({ nested: [1, 2, 3] });
    expect(obj.about).toBe(LONG_ABOUT);
    expect(r.tags).toEqual(BASE_TAGS);
  });

  it('replaces a field edited in Signet', () => {
    const r = merge({ config: matchedCard({ about: 'Short new bio.\nTwo lines.' }) });
    expect(JSON.parse(r.content).about).toBe('Short new bio.\nTwo lines.');
  });

  it('deletes a field that was edited to empty', () => {
    const r = merge({ config: matchedCard({ nip05: undefined }) });
    const obj = JSON.parse(r.content);
    expect('nip05' in obj).toBe(false);
    expect(obj.website).toBe('https://alice.example');
  });

  it('keeps a distinct `name` handle when the display name is renamed', () => {
    const r = merge({ config: matchedCard({ displayName: 'Alice Cooper' }) });
    const obj = JSON.parse(r.content);
    expect(obj.display_name).toBe('Alice Cooper');
    expect(obj.name).toBe('alice_handle');
  });

  it('gives a base with no `name` one on rename (and keeps unknown keys)', () => {
    const noName = JSON.stringify({ display_name: 'Alice', bot: true });
    const r = mergeKindZeroContent({
      comparisonContent: noName,
      contentBase: { content: noName, tags: [] },
      config: cfg({ displayName: 'Alicia' }),
      fallbackDisplayName: 'Alice',
    });
    const obj = JSON.parse(r.content);
    expect(obj.display_name).toBe('Alicia');
    expect(obj.name).toBe('Alicia');
    expect(obj.bot).toBe(true);
  });

  it('treats an empty-string `name` as no handle', () => {
    const c = JSON.stringify({ name: '', display_name: 'Alice' });
    const r = mergeKindZeroContent({ comparisonContent: c, contentBase: { content: c, tags: [] }, config: cfg({ displayName: 'Bea' }), fallbackDisplayName: '' });
    expect(JSON.parse(r.content).name).toBe('Bea');
  });

  it('never touches deprecated displayName / username keys', () => {
    const c = JSON.stringify({ displayName: 'Old', username: 'old', display_name: 'Alice', name: 'a' });
    const r = mergeKindZeroContent({ comparisonContent: c, contentBase: { content: c, tags: [] }, config: cfg({ displayName: 'Bea' }), fallbackDisplayName: '' });
    const obj = JSON.parse(r.content);
    expect(obj.displayName).toBe('Old');
    expect(obj.username).toBe('old');
  });

  it('THREE-WAY: an Amethyst-side edit to `about` survives a Signet-side `website` edit', () => {
    // The relay moved on after the match: Amethyst rewrote `about`.
    const amethystNow = JSON.stringify({ ...AMETHYST, about: 'Rewritten in Amethyst.\nNew line.' });
    const r = mergeKindZeroContent({
      comparisonContent: BASE_CONTENT,                     // what Signet last knew
      contentBase: { content: amethystNow, tags: [['client', 'amethyst'], ['t', 'new']] }, // the newer relay version
      config: matchedCard({ website: 'https://signet-edit.example' }), // only `website` edited in Signet
      fallbackDisplayName: 'Alice',
    });
    const obj = JSON.parse(r.content);
    expect(obj.about).toBe('Rewritten in Amethyst.\nNew line.');
    expect(obj.website).toBe('https://signet-edit.example');
    expect(obj.lud06).toBe('lnurl1abc');
    expect(r.tags).toEqual([['client', 'amethyst'], ['t', 'new']]);
  });

  it('THREE-WAY: when BOTH sides edited the same field, Signet wins for that field only', () => {
    const amethystNow = JSON.stringify({ ...AMETHYST, about: 'Amethyst about', website: 'https://amethyst.example' });
    const r = mergeKindZeroContent({
      comparisonContent: BASE_CONTENT,
      contentBase: { content: amethystNow, tags: [] },
      config: matchedCard({ about: 'Signet about' }),
      fallbackDisplayName: 'Alice',
    });
    const obj = JSON.parse(r.content);
    expect(obj.about).toBe('Signet about');
    expect(obj.website).toBe('https://amethyst.example');
  });

  it('does not read a CRLF / trailing-newline difference as an edit', () => {
    const c = JSON.stringify({ name: 'A', about: 'line one\nline two\n' });
    const r = mergeKindZeroContent({
      comparisonContent: c,
      contentBase: { content: c, tags: [] },
      config: cfg({ displayName: 'A', about: 'line one\r\nline two' }),
      fallbackDisplayName: '',
    });
    expect(r.content).toBe(c);
  });

  it('leaves a raw field that parse would drop (invalid picture scheme) alone', () => {
    const c = JSON.stringify({ name: 'A', picture: 'http://insecure.example/p.png', about: 'hi' });
    const r = mergeKindZeroContent({
      comparisonContent: c,
      contentBase: { content: c, tags: [] },
      config: cfg({ displayName: 'A', about: 'hi there' }),
      fallbackDisplayName: '',
    });
    expect(JSON.parse(r.content).picture).toBe('http://insecure.example/p.png');
  });

  it('falls back to the plain build when there is no comparison content (no stored base)', () => {
    const config = cfg({ about: 'a' });
    const r = mergeKindZeroContent({ comparisonContent: undefined, contentBase: { content: BASE_CONTENT, tags: BASE_TAGS }, config, fallbackDisplayName: 'Alice' });
    expect(r).toEqual({ content: buildKindZeroContent(config, 'Alice'), tags: [], merged: false });
  });

  it('falls back to the plain build when the content base JSON is not a plain object', () => {
    for (const bad of ['[1,2]', '"str"', 'null', 'not json', '42']) {
      const config = cfg({ about: 'a' });
      const r = mergeKindZeroContent({ comparisonContent: BASE_CONTENT, contentBase: { content: bad, tags: BASE_TAGS }, config, fallbackDisplayName: 'Alice' });
      expect(r.content).toBe(buildKindZeroContent(config, 'Alice'));
      expect(r.tags).toEqual([]);
      expect(r.merged).toBe(false);
    }
  });

  it('falls back to the plain build when the comparison content is not a plain object', () => {
    const config = cfg();
    const r = mergeKindZeroContent({ comparisonContent: '[]', contentBase: { content: BASE_CONTENT, tags: [] }, config, fallbackDisplayName: 'Alice' });
    expect(r.merged).toBe(false);
  });

  it('falls back to the plain build when the content base is an empty object (a tombstone)', () => {
    const config = cfg({ about: 'keep me' });
    const r = mergeKindZeroContent({ comparisonContent: BASE_CONTENT, contentBase: { content: '{}', tags: [] }, config, fallbackDisplayName: 'Alice' });
    expect(JSON.parse(r.content).about).toBe('keep me');
    expect(r.merged).toBe(false);
  });
});

describe('sanitiser (about + zero-width joiners)', () => {
  it('keeps newlines and tabs in about and normalises CRLF / CR to LF', () => {
    const json = buildKindZeroContent(cfg({ about: 'a\r\nb\rc\td\u0007e' }), '');
    expect(JSON.parse(json).about).toBe('a\nb\nc\tde');
  });

  it('keeps the emoji ZWJ and ZWNJ, strips ZWSP, LRM/RLM and bidi overrides', () => {
    const family = '👩‍👩‍👧';
    const json = buildKindZeroContent(cfg({ displayName: `Al${family}ice​‎‏‮`, about: `${family} fa‌r​si` }), '');
    const obj = JSON.parse(json);
    expect(obj.display_name).toBe(`Al${family}ice`);
    expect(obj.about).toBe(`${family} fa‌rsi`);
  });

  it('does not keep newlines in single-line fields', () => {
    const json = buildKindZeroContent(cfg({ displayName: 'Al\nice' }), '');
    expect(JSON.parse(json).display_name).toBe('Alice');
  });

  it('parseKindZeroContent keeps about line breaks and ZWJ, and allows 2000 chars', () => {
    const raw = JSON.stringify({ name: 'x', about: `${'y'.repeat(1990)}\n👩‍👩‍👧` });
    const about = parseKindZeroContent(raw)!.about!;
    expect(about).toContain('\n');
    expect(about).toContain('‍');
    const capped = parseKindZeroContent(JSON.stringify({ about: 'z'.repeat(2500) }))!.about!;
    expect(capped.length).toBe(2000);
  });

  it('caps by code points, never splitting a surrogate pair', () => {
    const about = parseKindZeroContent(JSON.stringify({ about: '😀'.repeat(2500) }))!.about!;
    expect(Array.from(about).length).toBe(2000);
    expect(about.endsWith('😀')).toBe(true);
  });
});

describe('toPublicProfileBase', () => {
  const ev = (content: string, tags: string[][] = []) => ({ id: 'a'.repeat(64), created_at: 10, content, tags });
  it('keeps the event verbatim', () => {
    expect(toPublicProfileBase(ev('{"a":1}', [['t', 'x']]))).toEqual({ eventId: 'a'.repeat(64), createdAt: 10, content: '{"a":1}', tags: [['t', 'x']] });
  });
  it('marks a matched base', () => {
    expect(toPublicProfileBase(ev('{}'), true)?.matched).toBe(true);
  });
  it('refuses content over 65536 chars and tags over 65536 chars in total', () => {
    expect(toPublicProfileBase(ev('x'.repeat(65537)))).toBeUndefined();
    expect(toPublicProfileBase(ev('x'.repeat(65536)))).toBeDefined();
    expect(toPublicProfileBase(ev('{}', [['t', 'y'.repeat(40000)], ['t', 'y'.repeat(30000)]]))).toBeUndefined();
  });
});

describe('publishPublicProfile — lossless publish', () => {
  const stored: PublicProfileBase = { eventId: 'b'.repeat(64), createdAt: 1000, content: BASE_CONTENT, tags: BASE_TAGS, matched: true };
  let signed: Array<{ kind: number; created_at: number; tags: string[][]; content: string }>;
  const backend = (): SigningBackend => ({
    activePublicKeyHex: 'c'.repeat(64),
    signEvent: vi.fn(async (u: { kind: number; created_at: number; tags: string[][]; content: string }) => {
      signed.push(u);
      return { ...u, id: 'd'.repeat(64), sig: 'e'.repeat(128), pubkey: 'c'.repeat(64) };
    }),
    nip44Encrypt: vi.fn(), nip44Decrypt: vi.fn(), destroy: vi.fn(),
  }) as unknown as SigningBackend;

  beforeEach(() => {
    signed = [];
    existingMock.result = null;
    vi.mocked(fetchExistingProfile).mockClear();
    vi.mocked(publishEvent).mockClear();
  });

  it('no stored base and nothing usable on the relay: today\'s plain build, empty tags', async () => {
    for (const looked of [null, 'unreachable', { event: { id: 'f'.repeat(64), created_at: 9, content: '{}', tags: [['t', 'x']] } }, { event: { id: 'f'.repeat(64), created_at: 9, content: '[1]', tags: [] } }]) {
      existingMock.result = looked;
      signed = [];
      const config = cfg({ about: 'plain' });
      const res = await publishPublicProfile(config, undefined, 'Alice', backend(), 'wss://r.example');
      expect(signed[0].tags).toEqual([]);
      expect(signed[0].content).toBe(buildKindZeroContent(config, 'Alice'));
      expect(res.merged).toBe(false);
    }
  });

  it('no stored base but a usable relay kind-0: it is both comparison and content base', async () => {
    const relay = { name: 'handle_x', display_name: 'Casey', about: 'a\nb', bot: true, x_custom: 1 };
    existingMock.result = { event: { id: 'f'.repeat(64), created_at: 5000, content: JSON.stringify(relay), tags: [['i', 'github:m', 'proof']] }, profile: {}, base: undefined, relay: 'wss://r.example' };
    // Card: about equals the relay's (raw kept), name renamed.
    const res = await publishPublicProfile({ displayName: 'Casey B', about: 'a\nb' }, undefined, 'Casey B', backend(), 'wss://r.example');
    const obj = JSON.parse(signed[0].content);
    expect(obj.name).toBe('handle_x');
    expect(obj.display_name).toBe('Casey B');
    expect(obj.about).toBe('a\nb');
    expect(obj.bot).toBe(true);
    expect(obj.x_custom).toBe(1);
    expect(signed[0].tags).toEqual([['i', 'github:m', 'proof']]);
    expect(signed[0].created_at).toBeGreaterThan(5000);
    expect(res.merged).toBe(true);
  });

  it('merges onto the stored base when the lookup finds nothing or is unreachable', async () => {
    for (const looked of [null, 'unreachable']) {
      existingMock.result = looked;
      signed = [];
      await publishPublicProfile(matchedCard({ website: 'https://new.example' }), undefined, 'Alice', backend(), 'wss://r.example', undefined, { storedBase: stored });
      const obj = JSON.parse(signed[0].content);
      expect(obj.website).toBe('https://new.example');
      expect(obj.lud06).toBe('lnurl1abc');
      expect(signed[0].tags).toEqual(BASE_TAGS);
    }
  });

  it('uses the NEWER fetched kind-0 as the content base and keeps its edit', async () => {
    const newer = JSON.stringify({ ...AMETHYST, about: 'Amethyst edit after the match' });
    existingMock.result = { event: { id: 'f'.repeat(64), created_at: 5000, content: newer, tags: [['client', 'amethyst'], ['t', 'new']] }, profile: {}, base: undefined, relay: 'wss://r.example' };
    const res = await publishPublicProfile(matchedCard({ website: 'https://signet.example' }), undefined, 'Alice', backend(), 'wss://r.example', undefined, { storedBase: stored, lookupRelays: ['wss://x.example'] });
    const obj = JSON.parse(signed[0].content);
    expect(obj.about).toBe('Amethyst edit after the match');
    expect(obj.website).toBe('https://signet.example');
    expect(signed[0].tags).toEqual([['client', 'amethyst'], ['t', 'new']]);
    // Strictly newer than what it merged onto, even though now() could not be.
    expect(signed[0].created_at).toBeGreaterThan(5000);
    expect(res.tags).toEqual(signed[0].tags);
    expect(fetchExistingProfile).toHaveBeenCalledWith('c'.repeat(64), ['wss://r.example', 'wss://x.example']);
  });

  it('prefers the stored base when the fetched kind-0 is OLDER', async () => {
    existingMock.result = { event: { id: 'f'.repeat(64), created_at: 10, content: JSON.stringify({ name: 'stale' }), tags: [] }, profile: {}, base: undefined, relay: 'wss://r.example' };
    await publishPublicProfile(matchedCard({ website: 'https://signet.example' }), undefined, 'Alice', backend(), 'wss://r.example', undefined, { storedBase: stored });
    expect(JSON.parse(signed[0].content).lud06).toBe('lnurl1abc');
  });

  it('returns what it sent (content, tags, hash) so the caller can store the new base', async () => {
    const res = await publishPublicProfile(matchedCard({ website: 'https://signet.example' }), undefined, 'Alice', backend(), 'wss://r.example', undefined, { storedBase: stored });
    expect(res.ok).toBe(true);
    expect(res.content).toBe(signed[0].content);
    expect(res.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.merged).toBe(true);
  });

  it('short-circuits when nothing is edited and the prior hash is the matched content\'s hash', async () => {
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const { bytesToHex } = await import('@noble/hashes/utils.js');
    const hash = bytesToHex(sha256(new TextEncoder().encode(BASE_CONTENT)));
    const res = await publishPublicProfile(matchedCard(), { enabled: true, lastEventId: stored.eventId, lastPublishedAt: 1000, lastPublishedRelay: 'wss://r.example', lastPublishedContentHash: hash }, 'Alice', backend(), 'wss://r.example', hash, { storedBase: stored });
    expect(res.message).toBe('no changes to publish');
    expect(signed).toHaveLength(0);
    expect(publishEvent).not.toHaveBeenCalled();
  });
});


describe('adoptPublishedIntoCard (card follows the published profile, additively)', () => {
  const card = cfg({ about: 'my bio', pictureUrl: 'https://img.example/a.png', pictureBlossomHash: 'f'.repeat(64), nip05: 'me@example.com', website: 'https://example.com' });

  it('never clears a card field because the published content lacks the key', () => {
    const { config, name } = adoptPublishedIntoCard(card, JSON.stringify({ name: 'Alice' }), { adoptName: true });
    expect(config).toEqual(card);
    expect(name).toBeUndefined();
  });

  it('ignores empty and unparseable values; adopts present, valid, different ones', () => {
    const published = JSON.stringify({
      about: '', picture: 'javascript:alert(1)', nip05: 'bad nip05',
      banner: 'https://img.example/b.png', lud16: 'pay@example.com', website: 'https://other.example',
    });
    const { config } = adoptPublishedIntoCard(card, published, { adoptName: true });
    expect(config).toMatchObject({
      about: 'my bio', pictureUrl: card.pictureUrl, pictureBlossomHash: card.pictureBlossomHash, nip05: 'me@example.com',
      bannerUrl: 'https://img.example/b.png', lud16: 'pay@example.com', website: 'https://other.example',
    });
  });

  it('drops the blossom hash only when the picture URL actually changes', () => {
    const { config } = adoptPublishedIntoCard(card, JSON.stringify({ picture: 'https://img.example/new.png' }), { adoptName: true });
    expect(config.pictureUrl).toBe('https://img.example/new.png');
    expect(config.pictureBlossomHash).toBeUndefined();
  });

  it('never returns a name for the natural-person slot (adoptName: false)', () => {
    const published = JSON.stringify({ display_name: 'Someone Else', about: 'new bio' });
    const np = adoptPublishedIntoCard(cfg({ displayName: 'Legal Name' }), published, { adoptName: false });
    expect(np.name).toBeUndefined();
    expect(np.config.displayName).toBe('Legal Name');
    expect(np.config.about).toBe('new bio');
    const other = adoptPublishedIntoCard(cfg({ displayName: 'Legal Name' }), published, { adoptName: true });
    expect(other.name).toBe('Someone Else');
  });
});
