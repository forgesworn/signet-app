// Tests for nip05-check.ts — persona-card NIP-05 verification button.
// TDD: written before the implementation. `fetchImpl` is injected so
// `checkNip05` never touches the real network in tests.

import { describe, it, expect, vi } from 'vitest';
import {
  parseNip05,
  buildNip05LookupUrl,
  evaluateNip05Response,
  checkNip05,
} from './nip05-check';

const PUBKEY = 'a'.repeat(64);
const PUBKEY_UPPER = 'A'.repeat(64);
const OTHER_PUBKEY = 'b'.repeat(64);

describe('parseNip05', () => {
  it('accepts a plain name@domain identifier', () => {
    expect(parseNip05('alice@example.com')).toEqual({ name: 'alice', domain: 'example.com' });
  });

  it('accepts the root-name special case `_`', () => {
    expect(parseNip05('_@example.com')).toEqual({ name: '_', domain: 'example.com' });
  });

  it('trims and lowercases mixed-case input', () => {
    expect(parseNip05('  Alice@Example.COM  ')).toEqual({ name: 'alice', domain: 'example.com' });
  });

  it('rejects empty input', () => {
    expect(parseNip05('')).toBeNull();
    expect(parseNip05('   ')).toBeNull();
  });

  it('rejects identifiers with more than one @', () => {
    expect(parseNip05('a@b@c')).toBeNull();
  });

  it('rejects identifiers containing spaces', () => {
    expect(parseNip05('alice bob@example.com')).toBeNull();
  });

  it('rejects localhost', () => {
    expect(parseNip05('alice@localhost')).toBeNull();
  });

  it('rejects IPv4 literal domains', () => {
    expect(parseNip05('alice@10.0.0.1')).toBeNull();
  });

  it('rejects bracketed IPv6 literal domains', () => {
    expect(parseNip05('alice@[::1]')).toBeNull();
  });

  it('rejects a domain with a path', () => {
    expect(parseNip05('alice@example.com/path')).toBeNull();
  });

  it('rejects a domain with a port', () => {
    expect(parseNip05('alice@example.com:8080')).toBeNull();
  });

  it('rejects a private/internal host via isPrivateOrInternalHost', () => {
    expect(parseNip05('alice@192.168.1.1')).toBeNull();
    expect(parseNip05('alice@app.localhost')).toBeNull();
  });

  it('rejects a single-label domain with no dot (review fix minor 5)', () => {
    expect(parseNip05('alice@intranet')).toBeNull();
  });

  it('rejects a trailing-dot domain (review fix minor 8)', () => {
    expect(parseNip05('alice@example.com.')).toBeNull();
  });

  it('rejects an identifier over 320 chars (review fix minor 4)', () => {
    const longName = 'a'.repeat(310); // '<310 a\'s>@example.com' is well over 320 chars total
    const identifier = `${longName}@example.com`;
    expect(identifier.length).toBeGreaterThan(320);
    expect(parseNip05(identifier)).toBeNull();
  });

  it('rejects a domain over 253 chars (review fix minor 4)', () => {
    // Build a >253-char domain out of valid 63-char labels so only the
    // overall-length cap (not HOSTNAME_RE's per-label cap) is exercised.
    const label = 'a'.repeat(63);
    const longDomain = `${label}.${label}.${label}.${label}.com`; // 63*4 + 3 dots + 4 ('.com') = 259
    expect(longDomain.length).toBeGreaterThan(253);
    expect(parseNip05(`alice@${longDomain}`)).toBeNull();
  });

  it('accepts a long-but-within-cap domain', () => {
    const label = 'a'.repeat(63);
    const domain = `${label}.${label}.${label}.b`; // 194 chars — under the 253 cap
    expect(domain.length).toBeLessThan(253);
    const result = parseNip05(`alice@${domain}`);
    expect(result).toEqual({ name: 'alice', domain });
  });
});

describe('buildNip05LookupUrl', () => {
  it('always builds an https URL under .well-known/nostr.json', () => {
    const url = buildNip05LookupUrl({ name: 'alice', domain: 'example.com' });
    expect(url).toBe('https://example.com/.well-known/nostr.json?name=alice');
    expect(url.startsWith('https://')).toBe(true);
  });

  it('URL-encodes the name', () => {
    const url = buildNip05LookupUrl({ name: 'a b+c', domain: 'example.com' });
    expect(url).toContain(encodeURIComponent('a b+c'));
    expect(url).not.toContain('a b+c');
  });
});

describe('evaluateNip05Response', () => {
  it('returns match when the name maps to the exact pubkey', () => {
    expect(evaluateNip05Response({ names: { alice: PUBKEY } }, 'alice', PUBKEY)).toBe('match');
  });

  it('returns match with uppercase hex in the response body (compared case-insensitively)', () => {
    expect(evaluateNip05Response({ names: { alice: PUBKEY_UPPER } }, 'alice', PUBKEY)).toBe('match');
  });

  it('returns mismatch when the name maps to a different pubkey', () => {
    expect(evaluateNip05Response({ names: { alice: OTHER_PUBKEY } }, 'alice', PUBKEY)).toBe('mismatch');
  });

  it('returns not-found when the name is absent from names', () => {
    expect(evaluateNip05Response({ names: { bob: PUBKEY } }, 'alice', PUBKEY)).toBe('not-found');
  });

  it('returns not-found when names is not an object', () => {
    expect(evaluateNip05Response({ names: 'nope' }, 'alice', PUBKEY)).toBe('not-found');
    expect(evaluateNip05Response({ names: null }, 'alice', PUBKEY)).toBe('not-found');
    expect(evaluateNip05Response({ names: ['alice'] }, 'alice', PUBKEY)).toBe('not-found');
  });

  it('returns not-found for a completely malformed body', () => {
    expect(evaluateNip05Response(null, 'alice', PUBKEY)).toBe('not-found');
    expect(evaluateNip05Response('a string', 'alice', PUBKEY)).toBe('not-found');
    expect(evaluateNip05Response({}, 'alice', PUBKEY)).toBe('not-found');
  });

  it('returns not-found for a non-hex value', () => {
    expect(evaluateNip05Response({ names: { alice: 'not-hex' } }, 'alice', PUBKEY)).toBe('not-found');
  });

  it('never throws on a __proto__-keyed body (review fix minor 8)', () => {
    // JSON.parse (unlike an object LITERAL `{ __proto__: '<hex>' }`) DOES
    // create a genuine own `__proto__` data property — ES2018 fixed
    // JSON.parse to use CreateDataProperty semantics, so this is a real
    // string value at `names['__proto__']`, not the object's prototype.
    // (Note: a caller-supplied `name` of '__proto__' would actually pass
    // NAME_RE upstream in parseNip05 — underscores are in the local-part
    // charset — so this case IS reachable via a real identifier, not just
    // a hypothetical. The property this test pins either way: plain
    // bracket-notation property access here never throws and always
    // returns a value from the Nip05CheckResult enum.)
    const body = JSON.parse('{"names": {"__proto__": "' + 'a'.repeat(64) + '"}}');
    expect(() => evaluateNip05Response(body, '__proto__', PUBKEY)).not.toThrow();
    expect(evaluateNip05Response(body, '__proto__', PUBKEY)).toBe('match');
  });
});

describe('checkNip05', () => {
  it('returns match on a 200 response whose body matches', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ names: { alice: PUBKEY } }), { status: 200 }),
    );
    const result = await checkNip05('alice@example.com', PUBKEY, fetchImpl);
    expect(result).toBe('match');
  });

  it('calls fetchImpl with an https:// URL and redirect: "error"', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ names: { alice: PUBKEY } }), { status: 200 }),
    );
    await checkNip05('alice@example.com', PUBKEY, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url).startsWith('https://')).toBe(true);
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit', mode: 'cors' });
  });

  it('never calls fetch for an identifier that fails to parse', async () => {
    const fetchImpl = vi.fn();
    const result = await checkNip05('alice@localhost', PUBKEY, fetchImpl);
    expect(result).toBe('unreachable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns unreachable on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }));
    const result = await checkNip05('alice@example.com', PUBKEY, fetchImpl);
    expect(result).toBe('unreachable');
  });

  it('returns unreachable when fetch rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const result = await checkNip05('alice@example.com', PUBKEY, fetchImpl);
    expect(result).toBe('unreachable');
  });

  it('returns unreachable when the body exceeds 64 KiB', async () => {
    const huge = JSON.stringify({ names: { alice: PUBKEY }, pad: 'x'.repeat(70 * 1024) });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(huge, { status: 200 }));
    const result = await checkNip05('alice@example.com', PUBKEY, fetchImpl);
    expect(result).toBe('unreachable');
  });

  it('returns unreachable on invalid JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{not json', { status: 200 }));
    const result = await checkNip05('alice@example.com', PUBKEY, fetchImpl);
    expect(result).toBe('unreachable');
  });

  it('returns mismatch when the body is well-formed but the key differs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ names: { alice: OTHER_PUBKEY } }), { status: 200 }),
    );
    const result = await checkNip05('alice@example.com', PUBKEY, fetchImpl);
    expect(result).toBe('mismatch');
  });

  it('never throws — a fetchImpl that throws synchronously still resolves to unreachable', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(checkNip05('alice@example.com', PUBKEY, fetchImpl)).resolves.toBe('unreachable');
  });
});
