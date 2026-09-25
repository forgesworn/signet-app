import { describe, it, expect } from 'vitest';
import {
  parseUrlAuthParams,
  buildAuthCallbackUrl,
  buildAuthDeniedUrl,
  getUrlAuthSiteName,
  parseConsumerHint,
  parseSignInRequest,
  parseAddDependantRequest,
  buildAddDependantCallbackUrl,
  buildAddDependantErrorUrl,
} from './url-auth';

function validSearch(overrides: Record<string, string> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const params: Record<string, string> = {
    auth: '1',
    challenge: 'a'.repeat(64),
    origin: 'https://example.com',
    name: 'Test App',
    callback: 'https://example.com/callback',
    t: String(now),
    ...overrides,
  };
  return '?' + new URLSearchParams(params).toString();
}

describe('parseUrlAuthParams', () => {
  it('parses valid auth params', () => {
    const result = parseUrlAuthParams(validSearch());
    expect(result).not.toBeNull();
    expect(result!.type).toBe('signet-login-request');
    expect(result!.challenge).toBe('a'.repeat(64));
    expect(result!.origin).toBe('https://example.com');
  });

  it('returns null when auth param is not 1', () => {
    expect(parseUrlAuthParams(validSearch({ auth: '0' }))).toBeNull();
  });

  it('returns null when challenge is not 64 hex chars', () => {
    expect(parseUrlAuthParams(validSearch({ challenge: 'short' }))).toBeNull();
    expect(parseUrlAuthParams(validSearch({ challenge: 'g'.repeat(64) }))).toBeNull();
  });

  it('normalises challenge to lowercase', () => {
    const result = parseUrlAuthParams(validSearch({ challenge: 'A'.repeat(64) }));
    expect(result!.challenge).toBe('a'.repeat(64));
  });

  it('returns null when origin is not https', () => {
    expect(parseUrlAuthParams(validSearch({ origin: 'http://example.com' }))).toBeNull();
  });

  it('allows http://localhost origin', () => {
    const result = parseUrlAuthParams(validSearch({
      origin: 'http://localhost:3000',
      callback: 'http://localhost:3000/cb',
    }));
    expect(result).not.toBeNull();
  });

  it('returns null when callback origin does not match request origin', () => {
    expect(parseUrlAuthParams(validSearch({
      origin: 'https://example.com',
      callback: 'https://evil.com/callback',
    }))).toBeNull();
  });

  it('returns null when timestamp missing', () => {
    const search = validSearch();
    const params = new URLSearchParams(search);
    params.delete('t');
    expect(parseUrlAuthParams('?' + params.toString())).toBeNull();
  });

  it('returns null when timestamp is stale (> 5 min)', () => {
    const stale = Math.floor(Date.now() / 1000) - 600;
    expect(parseUrlAuthParams(validSearch({ t: String(stale) }))).toBeNull();
  });

  it('returns null when name is empty', () => {
    expect(parseUrlAuthParams(validSearch({ name: '' }))).toBeNull();
  });

  it('returns null when name exceeds 64 chars', () => {
    expect(parseUrlAuthParams(validSearch({ name: 'x'.repeat(65) }))).toBeNull();
  });

  it('returns null when required params missing', () => {
    expect(parseUrlAuthParams('?auth=1')).toBeNull();
  });
});

describe('buildAuthCallbackUrl', () => {
  it('appends auth response params to callback URL', () => {
    const url = buildAuthCallbackUrl('https://example.com/cb', 'pubkey1', 'npub1abc', 'sig1', 'event1');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('pubkey')).toBe('pubkey1');
    expect(parsed.searchParams.get('npub')).toBe('npub1abc');
    expect(parsed.searchParams.get('signature')).toBe('sig1');
    expect(parsed.searchParams.get('eventId')).toBe('event1');
  });

  it('throws for non-https callback URL', () => {
    expect(() => buildAuthCallbackUrl('http://example.com/cb', 'p', 'n', 's', 'e')).toThrow();
  });

  it('allows http://localhost callback', () => {
    const url = buildAuthCallbackUrl('http://localhost:3000/cb', 'p', 'n', 's', 'e');
    expect(url).toContain('localhost');
  });

  // Phase 4 of per-persona-avatars — avatar metadata in callback params.
  describe('avatar fields (phase 4)', () => {
    const HASH = 'a'.repeat(64);
    const KEY = 'b'.repeat(64);
    const URL_VAL = 'https://blossom.example.com/' + HASH;

    it('includes all three fields when all are present and well-formed', () => {
      const url = buildAuthCallbackUrl('https://example.com/cb', 'p', 'n', 's', 'e', {
        avatarHash: HASH, avatarUrl: URL_VAL, avatarKey: KEY,
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get('avatar_hash')).toBe(HASH);
      expect(parsed.searchParams.get('avatar_url')).toBe(URL_VAL);
      expect(parsed.searchParams.get('avatar_key')).toBe(KEY);
    });

    it('omits all three when any one is missing — they move together', () => {
      const url = buildAuthCallbackUrl('https://example.com/cb', 'p', 'n', 's', 'e', {
        avatarHash: HASH, avatarUrl: URL_VAL, // avatarKey missing
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.has('avatar_hash')).toBe(false);
      expect(parsed.searchParams.has('avatar_url')).toBe(false);
      expect(parsed.searchParams.has('avatar_key')).toBe(false);
    });

    it('drops malformed avatar_hash (not 64-char hex) defensively', () => {
      const url = buildAuthCallbackUrl('https://example.com/cb', 'p', 'n', 's', 'e', {
        avatarHash: 'not-hex', avatarUrl: URL_VAL, avatarKey: KEY,
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.has('avatar_hash')).toBe(false);
      // The other two CAN still be present per the helper's per-field guards,
      // but in practice an invalid hash means the trio is unusable anyway —
      // consumers should ignore. We don't strictly co-validate; defence in
      // depth comes from the App.tsx pickAvatar logic only producing valid trios.
    });

    it('drops avatar_url for unsupported scheme (e.g. javascript:)', () => {
      const url = buildAuthCallbackUrl('https://example.com/cb', 'p', 'n', 's', 'e', {
        avatarHash: HASH, avatarUrl: 'javascript:alert(1)', avatarKey: KEY,
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.has('avatar_url')).toBe(false);
    });
  });
});

describe('buildAuthDeniedUrl', () => {
  it('appends error=denied to callback URL', () => {
    const url = buildAuthDeniedUrl('https://example.com/cb');
    expect(new URL(url).searchParams.get('error')).toBe('denied');
  });
});

describe('parseConsumerHint', () => {
  const H = (s: string) => parseConsumerHint('?' + s);

  it('accept=persona → ["persona"]', () => {
    expect(H('accept=persona').hint?.allow).toEqual(['persona']);
  });

  it('accept=persona,extra-persona → order preserved', () => {
    expect(H('accept=persona,extra-persona').hint?.allow).toEqual(['persona', 'extra-persona']);
  });

  it('accept=extra-persona,persona → different order preserved', () => {
    expect(H('accept=extra-persona,persona').hint?.allow).toEqual(['extra-persona', 'persona']);
  });

  it('accept=any → no filter (equivalent to omitting the param)', () => {
    // 'any' is explicit 'no filter' — same as omitted.
    expect(H('accept=any').hint).toBeNull();
  });

  it('accept=any,persona → persona still honoured as allow-list', () => {
    // Defensive: mixing 'any' with real tokens — we keep the real tokens
    // rather than silently letting 'any' override them, because the consumer
    // was explicit about what it wanted.
    expect(H('accept=any,persona').hint?.allow).toEqual(['persona']);
  });

  it('accept= (empty value) → no hint', () => {
    expect(H('accept=').hint).toBeNull();
  });

  it('accept missing → no hint', () => {
    expect(H('other=1').hint).toBeNull();
  });

  it('accept=persona, (trailing comma) → ["persona"]', () => {
    expect(H('accept=persona,').hint?.allow).toEqual(['persona']);
  });

  it('accept=,persona (leading comma) → ["persona"]', () => {
    expect(H('accept=,persona').hint?.allow).toEqual(['persona']);
  });

  it('accept=persona,persona → dedupes silently', () => {
    expect(H('accept=persona,persona').hint?.allow).toEqual(['persona']);
  });

  it('accept=Persona → case-insensitive parse, canonical lowercase', () => {
    expect(H('accept=Persona').hint?.allow).toEqual(['persona']);
  });

  it('accept=persona,typo,extra-persona → drops unknown, warns', () => {
    const { hint, warnings } = H('accept=persona,typo,extra-persona');
    expect(hint?.allow).toEqual(['persona', 'extra-persona']);
    expect(warnings.some(w => w.startsWith('accept-unknown:'))).toBe(true);
  });

  it('accept=1000-char garbage → no filter, warns', () => {
    const { hint, warnings } = H('accept=' + 'x'.repeat(1000));
    expect(hint).toBeNull();
    expect(warnings).toContain('accept-truncated');
  });

  it('accept=%20persona%20 (encoded whitespace) → trimmed to ["persona"]', () => {
    expect(H('accept=%20persona%20').hint?.allow).toEqual(['persona']);
  });

  it('multiple accept= params → uses first, warns on duplicates', () => {
    const { hint, warnings } = H('accept=persona&accept=natural-person');
    expect(hint?.allow).toEqual(['persona']);
    expect(warnings).toContain('accept-duplicate');
  });

  it('prefer=persona alongside accept → accepted', () => {
    const { hint } = H('accept=persona,extra-persona&prefer=extra-persona');
    expect(hint?.prefer).toBe('extra-persona');
  });

  it('prefer not in allowlist → warns but still set', () => {
    const { hint, warnings } = H('accept=persona&prefer=natural-person');
    expect(hint?.prefer).toBe('natural-person');
    expect(warnings).toContain('prefer-not-in-allow');
  });

  it('prefer unknown token → warns, not set', () => {
    const { hint, warnings } = H('accept=persona&prefer=bogus');
    expect(hint?.prefer).toBeUndefined();
    expect(warnings.some(w => w.startsWith('prefer-unknown:'))).toBe(true);
  });

  it('accept_reason stripped of control chars, capped at 120', () => {
    const reason = 'Hi\x00 there\u202eend';
    const { hint } = H('accept_reason=' + encodeURIComponent(reason));
    expect(hint?.reason).toBe('Hi there​end'.replace('\u202e', '').replace('\u200b', ''));
  });

  it('accept_reason over 120 chars → truncated', () => {
    const { hint } = H('accept_reason=' + encodeURIComponent('x'.repeat(200)));
    expect(hint?.reason?.length).toBe(120);
  });

  it('reason-only hint (no accept) → hint returned with only reason', () => {
    const { hint } = H('accept_reason=Just%20a%20note');
    expect(hint).not.toBeNull();
    expect(hint?.allow).toEqual([]);
    expect(hint?.reason).toBe('Just a note');
  });

  it('empty reason → not set on hint', () => {
    const { hint } = H('accept_reason=');
    expect(hint).toBeNull();
  });
});

describe('parseSignInRequest', () => {
  function full(overrides: Record<string, string> = {}) {
    const now = Math.floor(Date.now() / 1000);
    const params: Record<string, string> = {
      auth: '1',
      challenge: 'a'.repeat(64),
      origin: 'https://example.com',
      name: 'Test',
      callback: 'https://example.com/cb',
      t: String(now),
      ...overrides,
    };
    return '?' + new URLSearchParams(params).toString();
  }

  it('returns request + hint + warnings on a valid URL with accept=persona', () => {
    const result = parseSignInRequest(full({ accept: 'persona' }));
    expect(result).not.toBeNull();
    expect(result!.request.type).toBe('signet-login-request');
    expect(result!.hint?.allow).toEqual(['persona']);
    expect(result!.warnings).toEqual([]);
  });

  it('returns null when protocol-level params fail', () => {
    expect(parseSignInRequest('?auth=0&accept=persona')).toBeNull();
  });

  it('returns request with null hint when no accept params present', () => {
    const result = parseSignInRequest(full());
    expect(result).not.toBeNull();
    expect(result!.hint).toBeNull();
  });

  it('surfaces parser warnings', () => {
    const result = parseSignInRequest(full({ accept: 'persona,typo' }));
    expect(result!.warnings.some(w => w.startsWith('accept-unknown:'))).toBe(true);
  });
});

describe('buildAuthCallbackUrl with extras', () => {
  it('appends warnings= when list non-empty', () => {
    const url = buildAuthCallbackUrl('https://example.com/cb', 'p', 'n', 's', 'e', { warnings: ['accept-unknown:typo', 'prefer-not-in-allow'] });
    expect(new URL(url).searchParams.get('warnings')).toBe('accept-unknown:typo,prefer-not-in-allow');
  });

  it('appends fromNP=true when user took NP fallback', () => {
    const url = buildAuthCallbackUrl('https://example.com/cb', 'p', 'n', 's', 'e', { fromNP: true });
    expect(new URL(url).searchParams.get('fromNP')).toBe('true');
  });

  it('does not append extras when none supplied', () => {
    const url = buildAuthCallbackUrl('https://example.com/cb', 'p', 'n', 's', 'e');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('warnings')).toBeNull();
    expect(parsed.searchParams.get('fromNP')).toBeNull();
  });

  it('skips empty extras', () => {
    const url = buildAuthCallbackUrl('https://example.com/cb', 'p', 'n', 's', 'e', { warnings: [], fromNP: false });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('warnings')).toBeNull();
    expect(parsed.searchParams.get('fromNP')).toBeNull();
  });

  // Regression: createdAt must round-trip onto the
  // callback URL (as the protocol's `t` param) so consumers can rebuild the
  // signed kind-21236 event and verify the signature without an extra
  // round-trip. The 6th protocol arg was previously dropped at runtime.
  it('forwards createdAt onto the URL as the t param', () => {
    const url = buildAuthCallbackUrl('https://example.com/cb', 'p', 'n', 's', 'e', { createdAt: 1717500000 });
    expect(new URL(url).searchParams.get('t')).toBe('1717500000');
  });

  it('omits t when createdAt not supplied', () => {
    const url = buildAuthCallbackUrl('https://example.com/cb', 'p', 'n', 's', 'e', { fromNP: true });
    expect(new URL(url).searchParams.get('t')).toBeNull();
  });

  it('forwards createdAt alongside other extras', () => {
    const url = buildAuthCallbackUrl('https://example.com/cb', 'p', 'n', 's', 'e', {
      createdAt: 1717500001,
      displayName: 'shadowfox',
      fromNP: true,
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('t')).toBe('1717500001');
    expect(parsed.searchParams.get('display_name')).toBe('shadowfox');
    expect(parsed.searchParams.get('fromNP')).toBe('true');
  });
});

describe('getUrlAuthSiteName', () => {
  it('extracts name param', () => {
    expect(getUrlAuthSiteName('?name=My+Site')).toBe('My Site');
  });

  it('strips control characters', () => {
    expect(getUrlAuthSiteName('?name=Test\x00App')).toBe('TestApp');
  });

  it('strips bidi override characters', () => {
    expect(getUrlAuthSiteName('?name=Test\u202eApp')).toBe('TestApp');
  });

  it('caps at 64 characters', () => {
    expect(getUrlAuthSiteName('?name=' + 'x'.repeat(100))).toHaveLength(64);
  });

  it('returns empty string when no name param', () => {
    expect(getUrlAuthSiteName('?other=1')).toBe('');
  });
});

describe('parseSignInRequest \u2014 consumer_display_name', () => {
  function buildBaseUrl(extra: Record<string, string> = {}): string {
    const challenge = 'a'.repeat(64);
    const t = String(Math.floor(Date.now() / 1000));
    const params = new URLSearchParams({
      auth: '1',
      challenge,
      origin: 'https://example.test',
      callback: 'https://example.test/cb',
      name: 'Example',
      t,
      ...extra,
    });
    return params.toString();
  }

  it('returns consumerDisplayName when present and well-formed', () => {
    const result = parseSignInRequest(buildBaseUrl({ consumer_display_name: 'FlamingArcher42' }));
    expect(result).not.toBeNull();
    expect(result!.consumerDisplayName).toBe('FlamingArcher42');
  });

  it('omits consumerDisplayName when not provided', () => {
    const result = parseSignInRequest(buildBaseUrl());
    expect(result).not.toBeNull();
    expect(result!.consumerDisplayName).toBeUndefined();
  });

  it('strips control characters from consumer_display_name', () => {
    const result = parseSignInRequest(buildBaseUrl({ consumer_display_name: 'Bad\x00Name' }));
    expect(result!.consumerDisplayName).toBe('BadName');
  });

  it('caps consumer_display_name at 64 characters', () => {
    const long = 'A'.repeat(200);
    const result = parseSignInRequest(buildBaseUrl({ consumer_display_name: long }));
    expect(result!.consumerDisplayName!.length).toBe(64);
  });

  it('drops empty consumer_display_name after sanitisation', () => {
    const result = parseSignInRequest(buildBaseUrl({ consumer_display_name: '' }));
    expect(result!.consumerDisplayName).toBeUndefined();
  });
});

describe('parseSignInRequest \u2014 post= validation', () => {
  function buildBaseUrl(extra: Record<string, string> = {}): string {
    const challenge = 'a'.repeat(64);
    const t = String(Math.floor(Date.now() / 1000));
    const params = new URLSearchParams({
      auth: '1',
      challenge,
      origin: 'https://example.test',
      callback: 'https://example.test/cb',
      name: 'Example',
      t,
      ...extra,
    });
    return params.toString();
  }

  it('returns postUrl when same-origin and well-formed', () => {
    const result = parseSignInRequest(buildBaseUrl({ post: 'https://example.test/controller?session=abc' }));
    expect(result).not.toBeNull();
    expect(result!.postUrl).toBe('https://example.test/controller?session=abc');
    expect(result!.warnings.some(w => w.startsWith('post-'))).toBe(false);
  });

  it('omits postUrl when post= is absent', () => {
    const result = parseSignInRequest(buildBaseUrl());
    expect(result).not.toBeNull();
    expect(result!.postUrl).toBeUndefined();
    expect(result!.warnings.some(w => w.startsWith('post-'))).toBe(false);
  });

  it('rejects cross-origin post= with post-cross-origin warning', () => {
    const result = parseSignInRequest(buildBaseUrl({ post: 'https://attacker.test/handoff' }));
    expect(result!.postUrl).toBeUndefined();
    expect(result!.warnings).toContain('post-cross-origin');
  });

  it('rejects javascript: post= with post-invalid-scheme warning', () => {
    const result = parseSignInRequest(buildBaseUrl({ post: 'javascript:alert(1)' }));
    expect(result!.postUrl).toBeUndefined();
    expect(result!.warnings).toContain('post-invalid-scheme');
  });

  it('rejects data: post= with post-invalid-scheme warning', () => {
    const result = parseSignInRequest(buildBaseUrl({ post: 'data:text/html,<script>alert(1)</script>' }));
    expect(result!.postUrl).toBeUndefined();
    expect(result!.warnings).toContain('post-invalid-scheme');
  });

  it('rejects ftp: post= with post-invalid-scheme warning', () => {
    const result = parseSignInRequest(buildBaseUrl({ post: 'ftp://example.test/file' }));
    expect(result!.postUrl).toBeUndefined();
    expect(result!.warnings).toContain('post-invalid-scheme');
  });

  it('rejects over-2048-char post= with post-too-long warning', () => {
    const long = 'https://example.test/' + 'x'.repeat(2050);
    const result = parseSignInRequest(buildBaseUrl({ post: long }));
    expect(result!.postUrl).toBeUndefined();
    expect(result!.warnings).toContain('post-too-long');
  });

  it('rejects malformed post= with post-malformed warning', () => {
    const result = parseSignInRequest(buildBaseUrl({ post: 'not a url at all' }));
    expect(result!.postUrl).toBeUndefined();
    expect(result!.warnings).toContain('post-malformed');
  });

  it('allows http://localhost post= for dev', () => {
    const result = parseSignInRequest(new URLSearchParams({
      auth: '1',
      challenge: 'a'.repeat(64),
      origin: 'http://localhost:3000',
      callback: 'http://localhost:3000/cb',
      name: 'Dev',
      t: String(Math.floor(Date.now() / 1000)),
      post: 'http://localhost:3000/controller',
    }).toString());
    expect(result!.postUrl).toBe('http://localhost:3000/controller');
    expect(result!.warnings.some(w => w.startsWith('post-'))).toBe(false);
  });

  it('preserves existing callback-origin enforcement when post= is set', () => {
    // post= is valid same-origin, but callback= is cross-origin \u2014 should still parse-fail
    // at the existing callback check (post= doesn't relax other validations).
    const search = new URLSearchParams({
      auth: '1',
      challenge: 'a'.repeat(64),
      origin: 'https://example.test',
      callback: 'https://attacker.test/cb',
      name: 'Example',
      t: String(Math.floor(Date.now() / 1000)),
      post: 'https://example.test/controller',
    }).toString();
    expect(parseSignInRequest(search)).toBeNull();
  });
});

describe('buildAuthCallbackUrl \u2014 display_name', () => {
  const callback = 'https://example.test/cb';
  const pubkey = 'b'.repeat(64);
  const npub = 'npub1xxx';
  const sig = 'c'.repeat(128);
  const eventId = 'd'.repeat(64);

  it('appends display_name when supplied', () => {
    const url = buildAuthCallbackUrl(callback, pubkey, npub, sig, eventId, { displayName: 'shadowfox' });
    expect(new URL(url).searchParams.get('display_name')).toBe('shadowfox');
  });

  it('omits display_name when not supplied', () => {
    const url = buildAuthCallbackUrl(callback, pubkey, npub, sig, eventId, { fromNP: true });
    expect(new URL(url).searchParams.has('display_name')).toBe(false);
  });

  it('omits display_name when empty string', () => {
    const url = buildAuthCallbackUrl(callback, pubkey, npub, sig, eventId, { displayName: '' });
    expect(new URL(url).searchParams.has('display_name')).toBe(false);
  });
});

// ─── ?action=add-dependant ───────────────────────────────────────────────────

describe('parseAddDependantRequest', () => {
  function validAdd(overrides: Record<string, string> = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const params: Record<string, string> = {
      action: 'add-dependant',
      origin: 'https://family.example.com',
      name: 'Family App',
      callback: 'https://family.example.com/dependant-callback',
      t: String(now),
      challenge: 'a'.repeat(64),
      ...overrides,
    };
    return '?' + new URLSearchParams(params).toString();
  }

  it('parses a valid request and canonicalises fields', () => {
    const result = parseAddDependantRequest(validAdd({
      origin: 'https://family.example.com/path/ignored',
      challenge: 'A'.repeat(64),
      child_name: 'Alex',
    }));
    expect(result).not.toBeNull();
    expect(result!.origin).toBe('https://family.example.com');
    expect(result!.callback).toBe('https://family.example.com/dependant-callback');
    expect(result!.name).toBe('Family App');
    expect(result!.challenge).toBe('a'.repeat(64));
    expect(result!.childName).toBe('Alex');
    expect(typeof result!.t).toBe('number');
  });

  it('returns null when action is not "add-dependant"', () => {
    expect(parseAddDependantRequest(validAdd({ action: 'auth' }))).toBeNull();
    expect(parseAddDependantRequest(validAdd({ action: '' }))).toBeNull();
  });

  it('returns null when a required field is missing', () => {
    const search = validAdd();
    const params = new URLSearchParams(search);
    params.delete('callback');
    expect(parseAddDependantRequest('?' + params.toString())).toBeNull();
  });

  it('returns null when t is in the past beyond the freshness window', () => {
    const stale = Math.floor(Date.now() / 1000) - 6 * 60;
    expect(parseAddDependantRequest(validAdd({ t: String(stale) }))).toBeNull();
  });

  it('returns null when t is in the future beyond the freshness window', () => {
    const future = Math.floor(Date.now() / 1000) + 6 * 60;
    expect(parseAddDependantRequest(validAdd({ t: String(future) }))).toBeNull();
  });

  it('returns null when callback origin does not match request origin', () => {
    expect(parseAddDependantRequest(validAdd({
      origin: 'https://family.example.com',
      callback: 'https://evil.example.com/cb',
    }))).toBeNull();
  });

  it('returns null when origin is http (non-localhost)', () => {
    expect(parseAddDependantRequest(validAdd({
      origin: 'http://family.example.com',
      callback: 'http://family.example.com/cb',
    }))).toBeNull();
  });

  it('allows http://localhost for development', () => {
    const result = parseAddDependantRequest(validAdd({
      origin: 'http://localhost:5175',
      callback: 'http://localhost:5175/cb',
    }));
    expect(result).not.toBeNull();
    expect(result!.origin).toBe('http://localhost:5175');
  });

  it('returns null when callback scheme is not https', () => {
    expect(parseAddDependantRequest(validAdd({
      callback: 'ftp://family.example.com/cb',
    }))).toBeNull();
  });

  it('returns null when challenge is not 64 hex chars', () => {
    expect(parseAddDependantRequest(validAdd({ challenge: 'short' }))).toBeNull();
    expect(parseAddDependantRequest(validAdd({ challenge: 'g'.repeat(64) }))).toBeNull();
    expect(parseAddDependantRequest(validAdd({ challenge: 'a'.repeat(63) }))).toBeNull();
  });

  it('returns null when name is empty after sanitisation', () => {
    // Name made entirely of control characters → empty after strip → reject.
    expect(parseAddDependantRequest(validAdd({ name: '\x00\x01\x02' }))).toBeNull();
    // Whitespace-only after trim — also empty.
    expect(parseAddDependantRequest(validAdd({ name: '   ' }))).toBeNull();
  });

  it('strips bidi/control characters from name', () => {
    const result = parseAddDependantRequest(validAdd({ name: 'Family‮App\x00' }));
    expect(result!.name).toBe('FamilyApp');
  });

  it('drops childName when empty after sanitisation (treated as absent)', () => {
    const result = parseAddDependantRequest(validAdd({ child_name: '\x00\x01' }));
    expect(result).not.toBeNull();
    expect(result!.childName).toBeUndefined();
  });

  it('strips bidi/control chars from childName', () => {
    const result = parseAddDependantRequest(validAdd({ child_name: 'Alex‮Name\x00' }));
    expect(result).not.toBeNull();
    expect(result!.childName).toBe('AlexName');
  });

  it('caps childName at 100 chars', () => {
    const result = parseAddDependantRequest(validAdd({ child_name: 'A'.repeat(200) }));
    expect(result!.childName!.length).toBe(100);
  });

  it('omits childName when not present', () => {
    const result = parseAddDependantRequest(validAdd());
    expect(result).not.toBeNull();
    expect(result!.childName).toBeUndefined();
  });
});

describe('buildAddDependantCallbackUrl', () => {
  const callback = 'https://family.example.com/cb';
  const dependantPubkey = 'd'.repeat(64);
  const npub = 'npub1dependantbech32';
  const guardianPubkey = 'g'.repeat(64);
  const signature = 's'.repeat(128);
  const eventId = 'e'.repeat(64);

  it('round-trips all five core params through the URL parser', () => {
    const url = buildAddDependantCallbackUrl(callback, dependantPubkey, npub, guardianPubkey, signature, eventId);
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.searchParams.get('dependantPubkey')).toBe(dependantPubkey);
    expect(parsed.searchParams.get('npub')).toBe(npub);
    expect(parsed.searchParams.get('guardianPubkey')).toBe(guardianPubkey);
    expect(parsed.searchParams.get('signature')).toBe(signature);
    expect(parsed.searchParams.get('eventId')).toBe(eventId);
  });

  it('emits npub paired with dependantPubkey, distinct from guardianPubkey', () => {
    // Regression: the param layout must keep npub === bech32(dependantPubkey)
    // and guardianPubkey separate, so consumers can both address the new
    // subject AND verify the proof against the signer.
    const url = buildAddDependantCallbackUrl(callback, dependantPubkey, npub, guardianPubkey, signature, eventId);
    const parsed = new URL(url!);
    expect(parsed.searchParams.get('npub')).not.toBe(parsed.searchParams.get('guardianPubkey'));
  });

  it('appends bunker= when extras.bunker is provided', () => {
    const bunkerUri = 'bunker://abc?relay=wss%3A%2F%2Frelay.example.com&secret=xyz';
    const url = buildAddDependantCallbackUrl(callback, dependantPubkey, npub, guardianPubkey, signature, eventId, { bunker: bunkerUri });
    expect(new URL(url!).searchParams.get('bunker')).toBe(bunkerUri);
  });

  it('omits bunker= when extras.bunker is absent or empty', () => {
    const noBunker = buildAddDependantCallbackUrl(callback, dependantPubkey, npub, guardianPubkey, signature, eventId);
    expect(new URL(noBunker!).searchParams.has('bunker')).toBe(false);
    const empty = buildAddDependantCallbackUrl(callback, dependantPubkey, npub, guardianPubkey, signature, eventId, { bunker: '' });
    expect(new URL(empty!).searchParams.has('bunker')).toBe(false);
  });

  it('preserves existing query params on the callback URL', () => {
    const url = buildAddDependantCallbackUrl(
      'https://family.example.com/cb?session=abc&utm=spam',
      dependantPubkey, npub, guardianPubkey, signature, eventId,
    );
    const parsed = new URL(url!);
    expect(parsed.searchParams.get('session')).toBe('abc');
    expect(parsed.searchParams.get('utm')).toBe('spam');
    expect(parsed.searchParams.get('dependantPubkey')).toBe(dependantPubkey);
    expect(parsed.searchParams.get('guardianPubkey')).toBe(guardianPubkey);
  });

  it('returns null for malformed callback URLs', () => {
    expect(buildAddDependantCallbackUrl('not a url', dependantPubkey, npub, guardianPubkey, signature, eventId)).toBeNull();
  });

  it('returns null for non-http(s) callback schemes (defence in depth)', () => {
    // Regression: a future caller bypassing parseAddDependantRequest must
    // not be able to feed a `javascript:`/`data:`/`file:` URL into a
    // `window.location.href` redirect. The dispatcher pre-validates today,
    // but the helper enforces the same invariant so any direct caller
    // stays safe.
    const cases = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'ftp://relay.example.com',
      'http://attacker.example.com/cb',
    ];
    for (const c of cases) {
      expect(buildAddDependantCallbackUrl(c, dependantPubkey, npub, guardianPubkey, signature, eventId)).toBeNull();
    }
  });

  it('accepts http://localhost and http://127.0.0.1 for dev', () => {
    expect(buildAddDependantCallbackUrl('http://localhost:5174/cb', dependantPubkey, npub, guardianPubkey, signature, eventId)).not.toBeNull();
    expect(buildAddDependantCallbackUrl('http://127.0.0.1:5174/cb', dependantPubkey, npub, guardianPubkey, signature, eventId)).not.toBeNull();
  });
});

describe('buildAddDependantErrorUrl', () => {
  it('appends error=<token>', () => {
    const url = buildAddDependantErrorUrl('https://family.example.com/cb', 'denied');
    expect(new URL(url!).searchParams.get('error')).toBe('denied');
  });

  it('preserves existing query params on the callback URL', () => {
    const url = buildAddDependantErrorUrl('https://family.example.com/cb?session=xyz', 'create_failed');
    const parsed = new URL(url!);
    expect(parsed.searchParams.get('session')).toBe('xyz');
    expect(parsed.searchParams.get('error')).toBe('create_failed');
  });

  it('returns null for malformed callback URLs', () => {
    expect(buildAddDependantErrorUrl('also not a url', 'denied')).toBeNull();
  });

  it('returns null for non-http(s) callback schemes (defence in depth)', () => {
    expect(buildAddDependantErrorUrl('javascript:alert(1)', 'denied')).toBeNull();
    expect(buildAddDependantErrorUrl('data:,', 'denied')).toBeNull();
    expect(buildAddDependantErrorUrl('http://attacker.example.com/cb', 'denied')).toBeNull();
  });

  it('accepts http://localhost and http://127.0.0.1 for dev', () => {
    expect(buildAddDependantErrorUrl('http://localhost:5174/cb', 'denied')).not.toBeNull();
    expect(buildAddDependantErrorUrl('http://127.0.0.1:5174/cb', 'denied')).not.toBeNull();
  });
});
