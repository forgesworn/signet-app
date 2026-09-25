import { describe, it, expect } from 'vitest';
import { inferScope, inferOrigin } from './scope-inference';
import type { UnsignedEvent } from 'signet-protocol';

function tmpl(kind: number, tags: string[][] = [], content = ''): UnsignedEvent {
  return {
    kind,
    tags,
    content,
    created_at: Math.floor(Date.now() / 1000),
    pubkey: '0'.repeat(64),
  };
}

describe('inferScope', () => {
  it('kind 21236 (Signet auth) → sign-in', () => {
    expect(inferScope(tmpl(21236))).toBe('sign-in');
  });

  it('kind 21235 (venue entry) → venue-entry', () => {
    expect(inferScope(tmpl(21235))).toBe('venue-entry');
  });

  it('kind 1 without e tag → post-public', () => {
    expect(inferScope(tmpl(1, [['p', 'abc']]))).toBe('post-public');
    expect(inferScope(tmpl(1))).toBe('post-public');
  });

  it('kind 1 with e tag → react-zap-reply (reply)', () => {
    expect(inferScope(tmpl(1, [['e', 'a'.repeat(64)]]))).toBe('react-zap-reply');
  });

  it('kind 13 (NIP-59 seal — actual bunker-visible DM kind under NIP-17) → dm-private', () => {
    expect(inferScope(tmpl(13))).toBe('dm-private');
  });

  it('kind 4 (NIP-04 legacy encrypted DM) → dm-private', () => {
    expect(inferScope(tmpl(4))).toBe('dm-private');
  });

  it('kind 1059 (gift-wrap) → dm-private (defence-in-depth; signed by ephemeral key in practice)', () => {
    expect(inferScope(tmpl(1059))).toBe('dm-private');
  });

  it('kind 24242 (Blossom auth) → upload-photo', () => {
    expect(inferScope(tmpl(24242))).toBe('upload-photo');
  });

  it('kind 7 (reaction) → react-zap-reply', () => {
    expect(inferScope(tmpl(7))).toBe('react-zap-reply');
  });

  it('kind 9734 (zap request — the user-signed kind) → react-zap-reply', () => {
    expect(inferScope(tmpl(9734))).toBe('react-zap-reply');
  });

  it('kind 9735 (zap receipt — signed by LNURL service, not the user) → null', () => {
    // 9735 is the receipt, signed by the lightning service, not the user.
    // A user's bunker should never be asked to sign one; if it is, we
    // conservatively return null so the guardian sees an ASK-EVERY prompt.
    expect(inferScope(tmpl(9735))).toBeNull();
  });

  it('kind 24133 (NIP-46 transport) → pair-device', () => {
    expect(inferScope(tmpl(24133))).toBe('pair-device');
  });

  it('kind 0 (profile metadata) → mutate-identity', () => {
    expect(inferScope(tmpl(0))).toBe('mutate-identity');
  });

  it('kind 31000 with type tag ending in "name-change" → mutate-identity', () => {
    expect(inferScope(tmpl(31000, [['type', 'display-name-change']]))).toBe('mutate-identity');
    expect(inferScope(tmpl(31000, [['type', 'persona-name-change']]))).toBe('mutate-identity');
  });

  it('kind 31000 with unrelated type → null (out of scope)', () => {
    expect(inferScope(tmpl(31000, [['type', 'delegation']]))).toBeNull();
    expect(inferScope(tmpl(31000, [['type', 'migration']]))).toBeNull();
    expect(inferScope(tmpl(31000, [['type', 'audit']]))).toBeNull();
  });

  it('kind 31000 with no type tag → null', () => {
    expect(inferScope(tmpl(31000))).toBeNull();
  });

  it('unknown / unclassified kinds → null (callers fall back to ASK-EVERY)', () => {
    expect(inferScope(tmpl(99999))).toBeNull();
    expect(inferScope(tmpl(12345))).toBeNull();
    expect(inferScope(tmpl(2))).toBeNull();
  });

  it('age-verify and vouch scopes not yet reachable (protocol kinds tbd)', () => {
    // Documenting the gap: when the age-verify / vouch kinds are defined in
    // the protocol, add cases for them here. Until then callers see null
    // for these and fall back to ASK-EVERY — the conservative path.
    //
    // This test is a placeholder / spec marker, not a behavioural assertion.
    expect(true).toBe(true);
  });

  it('e-tag detection is case-sensitive and only on slot 0', () => {
    // The e-tag detection must not accidentally trigger on a capital E or
    // when "e" appears in a different slot (e.g. a value that happens to be 'e').
    expect(inferScope(tmpl(1, [['E', 'x']]))).toBe('post-public');
    expect(inferScope(tmpl(1, [['p', 'e']]))).toBe('post-public');
  });
});

describe('inferOrigin', () => {
  it('sign-in: reads the origin tag', () => {
    const t = tmpl(21236, [['challenge', 'abc'], ['origin', 'https://roblox.com']]);
    expect(inferOrigin(t, 'sign-in')).toBe('https://roblox.com');
  });

  it('sign-in: returns null when origin tag is missing', () => {
    expect(inferOrigin(tmpl(21236, [['challenge', 'abc']]), 'sign-in')).toBeNull();
  });

  it('sign-in: returns null when origin tag value is empty', () => {
    expect(inferOrigin(tmpl(21236, [['origin', '']]), 'sign-in')).toBeNull();
  });

  it('upload-photo: normalises the `u` tag URL to its origin', () => {
    const t = tmpl(24242, [
      ['t', 'upload'],
      ['u', 'https://blossom.example.com/upload/abc123'],
    ]);
    expect(inferOrigin(t, 'upload-photo')).toBe('https://blossom.example.com');
  });

  it('upload-photo: returns null when `u` tag missing', () => {
    expect(inferOrigin(tmpl(24242, [['t', 'upload']]), 'upload-photo')).toBeNull();
  });

  it('upload-photo: returns null when `u` tag value is not a valid URL', () => {
    expect(inferOrigin(tmpl(24242, [['u', 'not a url']]), 'upload-photo')).toBeNull();
  });

  it('sign-in: rejects javascript: / data: / ftp: pseudo-schemes', () => {
    expect(inferOrigin(tmpl(21236, [['origin', 'javascript:alert(1)']]), 'sign-in')).toBeNull();
    expect(inferOrigin(tmpl(21236, [['origin', 'data:text/html,xxx']]), 'sign-in')).toBeNull();
    expect(inferOrigin(tmpl(21236, [['origin', 'ftp://evil.com']]), 'sign-in')).toBeNull();
  });

  it('sign-in: rejects non-localhost http:// — only https and http://localhost accepted', () => {
    expect(inferOrigin(tmpl(21236, [['origin', 'http://evil.com']]), 'sign-in')).toBeNull();
    expect(inferOrigin(tmpl(21236, [['origin', 'http://localhost:3000/x']]), 'sign-in')).toBe('http://localhost:3000');
    expect(inferOrigin(tmpl(21236, [['origin', 'http://127.0.0.1:8080']]), 'sign-in')).toBe('http://127.0.0.1:8080');
  });

  it('sign-in: rejects raw strings that are not valid URLs (e.g. "roblox.com" with no scheme)', () => {
    expect(inferOrigin(tmpl(21236, [['origin', 'roblox.com']]), 'sign-in')).toBeNull();
  });

  it('upload-photo: rejects javascript: / data: schemes', () => {
    expect(inferOrigin(tmpl(24242, [['u', 'javascript:alert(1)']]), 'upload-photo')).toBeNull();
    expect(inferOrigin(tmpl(24242, [['u', 'data:image/png;base64,xxx']]), 'upload-photo')).toBeNull();
  });

  it('dm-private: returns first `p` tag value as recipient pubkey (lowercased)', () => {
    const recipient = 'f'.repeat(64);
    const t = tmpl(13, [['p', recipient.toUpperCase()]]);
    expect(inferOrigin(t, 'dm-private')).toBe(recipient);
  });

  it('dm-private: returns null when `p` tag value is not 64-hex', () => {
    expect(inferOrigin(tmpl(13, [['p', 'not-hex']]), 'dm-private')).toBeNull();
  });

  it('react-zap-reply: returns first `p` tag as counterparty', () => {
    const cp = 'a'.repeat(64);
    expect(inferOrigin(tmpl(7, [['p', cp]]), 'react-zap-reply')).toBe(cp);
  });

  it('returns null for non-origin scopes', () => {
    expect(inferOrigin(tmpl(1), 'post-public')).toBeNull();
    expect(inferOrigin(tmpl(21235), 'venue-entry')).toBeNull();
    expect(inferOrigin(tmpl(24133), 'pair-device')).toBeNull();
    expect(inferOrigin(tmpl(0), 'mutate-identity')).toBeNull();
  });

  it('tolerates malformed tag entries (non-arrays)', () => {
    // A tag slot that isn't an array would throw on t[0] access without a guard.
    // Cast through unknown to bypass the string[][] type.
    const badTags = [null, ['origin', 'https://x.com']] as unknown as string[][];
    const t: UnsignedEvent = {
      kind: 21236, tags: badTags, content: '', created_at: 1, pubkey: '0'.repeat(64),
    };
    expect(inferOrigin(t, 'sign-in')).toBe('https://x.com');
  });
});
