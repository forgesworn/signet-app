import { describe, it, expect } from 'vitest';
import { buildPairingURI, parsePairingURI, generatePairingSecret } from './pairing-uri';

const ENDPOINT = 'a'.repeat(64);
const DEPENDANT = 'b'.repeat(64);
const GUARDIAN = 'e'.repeat(64);
const RELAY = 'wss://relay.example.com';
const RELAY_FALLBACK = 'wss://fallback.example.com';
const SECRET = 'deadbeef'.repeat(4);

describe('buildPairingURI', () => {
  it('emits a well-formed bunker:// URI with all required params', () => {
    const uri = buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays: [RELAY],
      secret: SECRET,
      dependantPubkey: DEPENDANT,
      dependantName: 'Alice',
    });
    expect(uri.startsWith(`bunker://${ENDPOINT}?`)).toBe(true);
    expect(uri).toContain('relay=wss');
    expect(uri).toContain(`secret=${SECRET}`);
    expect(uri).toContain(`dependant=${DEPENDANT}`);
    expect(uri).toContain('name=Alice');
  });

  it('lowercases pubkeys in the URI', () => {
    const uri = buildPairingURI({
      endpointPubkey: ENDPOINT.toUpperCase(),
      relays: [RELAY],
      secret: SECRET,
      dependantPubkey: DEPENDANT.toUpperCase(),
      dependantName: 'Alice',
    });
    expect(uri).toContain(ENDPOINT);
    expect(uri).toContain(DEPENDANT);
    expect(uri).not.toContain(ENDPOINT.toUpperCase());
  });

  it('URL-encodes the dependant name for non-ASCII characters', () => {
    const uri = buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays: [RELAY],
      secret: SECRET,
      dependantPubkey: DEPENDANT,
      dependantName: 'Zoë',
    });
    expect(uri).toContain('Zo');
    // Decoding should recover the original
    const parsed = parsePairingURI(uri);
    expect(parsed?.dependantName).toBe('Zoë');
  });

  it('strips control characters from the dependant name', () => {
    const uri = buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays: [RELAY],
      secret: SECRET,
      dependantPubkey: DEPENDANT,
      dependantName: 'Ali\u0000ce\u202eevil',
    });
    const parsed = parsePairingURI(uri);
    expect(parsed?.dependantName).toBe('Aliceevil');
  });

  it('caps the dependant name at 64 chars', () => {
    const longName = 'x'.repeat(200);
    const uri = buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays: [RELAY],
      secret: SECRET,
      dependantPubkey: DEPENDANT,
      dependantName: longName,
    });
    const parsed = parsePairingURI(uri);
    expect(parsed?.dependantName.length).toBe(64);
  });

  it('emits multiple relay= params in order when fallbacks are supplied', () => {
    const uri = buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays: [RELAY, RELAY_FALLBACK],
      secret: SECRET,
      dependantPubkey: DEPENDANT,
      dependantName: 'Alice',
    });
    const primaryIdx = uri.indexOf(encodeURIComponent(RELAY));
    const fallbackIdx = uri.indexOf(encodeURIComponent(RELAY_FALLBACK));
    expect(primaryIdx).toBeGreaterThan(0);
    expect(fallbackIdx).toBeGreaterThan(primaryIdx);
  });

  it('deduplicates identical relay entries before emitting', () => {
    const uri = buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays: [RELAY, RELAY],
      secret: SECRET,
      dependantPubkey: DEPENDANT,
      dependantName: 'Alice',
    });
    const parsed = parsePairingURI(uri);
    expect(parsed?.relays).toEqual([RELAY]);
  });

  it('encodes spaces in dependant name as %20, never +', () => {
    // nostr-tools' `BUNKER_REGEX` allows `[?\/\w:.=&%-]` in the query string
    // but does NOT permit `+`. URLSearchParams' default form-encoding emits
    // `+` for space, which would cause `parseBunkerInput` to fail entirely
    // (`bp.relays` ends up empty) and `BunkerSigner.fromBunker` throws
    // "Bunker URI must include at least one relay" — even though the URI
    // does have a `relay=` param. Any multi-word dependant name was a
    // silent pairing failure until we switched to `%20`.
    const uri = buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays: [RELAY],
      secret: SECRET,
      dependantPubkey: DEPENDANT,
      dependantName: 'Dep Person',
    });
    expect(uri).not.toMatch(/\+/);
    expect(uri).toMatch(/name=Dep%20Person/);
    // Round-trip: parser decodes both `+` and `%20` as space, so
    // `parsePairingURI` should still recover the original name.
    expect(parsePairingURI(uri)?.dependantName).toBe('Dep Person');
  });

  it('throws on invalid endpoint pubkey', () => {
    expect(() => buildPairingURI({
      endpointPubkey: 'not-hex',
      relays: [RELAY], secret: SECRET, dependantPubkey: DEPENDANT, dependantName: 'Alice',
    })).toThrow(/endpoint/i);
  });

  it('throws on invalid relay scheme (http://)', () => {
    expect(() => buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays: ['http://relay.example.com'],
      secret: SECRET, dependantPubkey: DEPENDANT, dependantName: 'Alice',
    })).toThrow(/relay/i);
  });

  it('throws when any fallback relay has an invalid scheme', () => {
    expect(() => buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays: [RELAY, 'http://attacker.com'],
      secret: SECRET, dependantPubkey: DEPENDANT, dependantName: 'Alice',
    })).toThrow(/relay/i);
  });

  it('throws on empty relays array', () => {
    expect(() => buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays: [],
      secret: SECRET, dependantPubkey: DEPENDANT, dependantName: 'Alice',
    })).toThrow(/relays/i);
  });

  it('throws when the relays array exceeds the cap', () => {
    const tooMany = Array.from({ length: 6 }, (_, i) => `wss://r${i}.example.com`);
    expect(() => buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays: tooMany,
      secret: SECRET, dependantPubkey: DEPENDANT, dependantName: 'Alice',
    })).toThrow(/relays/i);
  });

  it('accepts ws://localhost relays (dev)', () => {
    expect(() => buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays: ['ws://localhost:8080'],
      secret: SECRET, dependantPubkey: DEPENDANT, dependantName: 'Alice',
    })).not.toThrow();
  });

  it('throws on short secret', () => {
    expect(() => buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays: [RELAY],
      secret: 'short',
      dependantPubkey: DEPENDANT, dependantName: 'Alice',
    })).toThrow(/secret/i);
  });

  it('throws on empty name after stripping', () => {
    expect(() => buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays: [RELAY],
      secret: SECRET,
      dependantPubkey: DEPENDANT,
      dependantName: '\u0000\u202e',
    })).toThrow(/name/i);
  });
  // ── C1: guardian= param (guardian's real signing pubkey) ─────────────────

  it('emits a guardian= param when guardianPubkey is supplied', () => {
    const uri = buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays: [RELAY],
      secret: SECRET,
      dependantPubkey: DEPENDANT,
      dependantName: 'Alice',
      guardianPubkey: GUARDIAN,
    });
    expect(uri).toContain(`guardian=${GUARDIAN}`);
    expect(parsePairingURI(uri)?.guardianPubkey).toBe(GUARDIAN);
  });

  it('omits the guardian= param when guardianPubkey is not supplied (backward compat)', () => {
    const uri = buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays: [RELAY],
      secret: SECRET,
      dependantPubkey: DEPENDANT,
      dependantName: 'Alice',
    });
    expect(uri).not.toContain('guardian=');
    expect(parsePairingURI(uri)?.guardianPubkey).toBeUndefined();
  });

  it('lowercases the guardian pubkey', () => {
    const uri = buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays: [RELAY],
      secret: SECRET,
      dependantPubkey: DEPENDANT,
      dependantName: 'Alice',
      guardianPubkey: GUARDIAN.toUpperCase(),
    });
    expect(uri).toContain(`guardian=${GUARDIAN}`);
    expect(uri).not.toContain(GUARDIAN.toUpperCase());
  });

  it('throws on an invalid guardian pubkey', () => {
    expect(() => buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays: [RELAY],
      secret: SECRET,
      dependantPubkey: DEPENDANT,
      dependantName: 'Alice',
      guardianPubkey: 'not-hex',
    })).toThrow(/guardian/i);
  });
});

describe('parsePairingURI', () => {
  function validURI(relays: string[] = [RELAY]) {
    return buildPairingURI({
      endpointPubkey: ENDPOINT,
      relays,
      secret: SECRET,
      dependantPubkey: DEPENDANT,
      dependantName: 'Alice',
    });
  }

  it('round-trips a single-relay URI built by buildPairingURI', () => {
    const uri = validURI();
    const parsed = parsePairingURI(uri);
    expect(parsed).not.toBeNull();
    expect(parsed!.endpointPubkey).toBe(ENDPOINT);
    expect(parsed!.relays).toEqual([RELAY]);
    expect(parsed!.secret).toBe(SECRET);
    expect(parsed!.dependantPubkey).toBe(DEPENDANT);
    expect(parsed!.dependantName).toBe('Alice');
  });

  it('round-trips a multi-relay URI, preserving order', () => {
    const uri = validURI([RELAY, RELAY_FALLBACK]);
    const parsed = parsePairingURI(uri);
    expect(parsed?.relays).toEqual([RELAY, RELAY_FALLBACK]);
  });

  it('accepts an externally-crafted URI with two relay= params', () => {
    const uri = `bunker://${ENDPOINT}?relay=${encodeURIComponent(RELAY)}&relay=${encodeURIComponent(RELAY_FALLBACK)}&secret=${SECRET}&dependant=${DEPENDANT}&name=Alice`;
    const parsed = parsePairingURI(uri);
    expect(parsed?.relays).toEqual([RELAY, RELAY_FALLBACK]);
  });

  it('returns null for non-bunker scheme', () => {
    expect(parsePairingURI('nostrconnect://a?b=c')).toBeNull();
    expect(parsePairingURI('https://example.com')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parsePairingURI('')).toBeNull();
    expect(parsePairingURI('bunker://')).toBeNull();
    expect(parsePairingURI('bunker://abc?relay=wss://x')).toBeNull();
    expect(parsePairingURI(null as unknown as string)).toBeNull();
  });

  it('returns null when endpoint pubkey is not 64-hex', () => {
    const uri = validURI().replace(ENDPOINT, 'short');
    expect(parsePairingURI(uri)).toBeNull();
  });

  it('returns null when any relay has an invalid scheme', () => {
    const bad = `bunker://${ENDPOINT}?relay=http%3A%2F%2Fx&secret=${SECRET}&dependant=${DEPENDANT}&name=Alice`;
    expect(parsePairingURI(bad)).toBeNull();
  });

  it('returns null when the primary relay is valid but a fallback is not', () => {
    const bad = `bunker://${ENDPOINT}?relay=${encodeURIComponent(RELAY)}&relay=${encodeURIComponent('http://attacker.com')}&secret=${SECRET}&dependant=${DEPENDANT}&name=Alice`;
    expect(parsePairingURI(bad)).toBeNull();
  });

  it('returns null when relays are missing entirely', () => {
    const bad = `bunker://${ENDPOINT}?secret=${SECRET}&dependant=${DEPENDANT}&name=Alice`;
    expect(parsePairingURI(bad)).toBeNull();
  });

  it('returns null when the relay list exceeds the cap', () => {
    const parts = Array.from({ length: 6 }, (_, i) => `relay=${encodeURIComponent(`wss://r${i}.example.com`)}`).join('&');
    const bad = `bunker://${ENDPOINT}?${parts}&secret=${SECRET}&dependant=${DEPENDANT}&name=Alice`;
    expect(parsePairingURI(bad)).toBeNull();
  });

  it('returns null when secret is missing', () => {
    const bad = `bunker://${ENDPOINT}?relay=${encodeURIComponent(RELAY)}&dependant=${DEPENDANT}&name=Alice`;
    expect(parsePairingURI(bad)).toBeNull();
  });

  it('returns null when dependant pubkey is missing or invalid', () => {
    const noDep = `bunker://${ENDPOINT}?relay=${encodeURIComponent(RELAY)}&secret=${SECRET}&name=Alice`;
    expect(parsePairingURI(noDep)).toBeNull();
    const badDep = `bunker://${ENDPOINT}?relay=${encodeURIComponent(RELAY)}&secret=${SECRET}&dependant=zz&name=Alice`;
    expect(parsePairingURI(badDep)).toBeNull();
  });

  it('returns null when name is missing or empty after strip', () => {
    const noName = `bunker://${ENDPOINT}?relay=${encodeURIComponent(RELAY)}&secret=${SECRET}&dependant=${DEPENDANT}`;
    expect(parsePairingURI(noName)).toBeNull();
    const emptyName = `bunker://${ENDPOINT}?relay=${encodeURIComponent(RELAY)}&secret=${SECRET}&dependant=${DEPENDANT}&name=`;
    expect(parsePairingURI(emptyName)).toBeNull();
  });

  it('accepts uppercase hex and normalises to lowercase', () => {
    const uri = `bunker://${ENDPOINT.toUpperCase()}?relay=${encodeURIComponent(RELAY)}&secret=${SECRET}&dependant=${DEPENDANT.toUpperCase()}&name=Alice`;
    const parsed = parsePairingURI(uri);
    expect(parsed?.endpointPubkey).toBe(ENDPOINT);
    expect(parsed?.dependantPubkey).toBe(DEPENDANT);
  });

  it('accepts the bunker:// prefix case-insensitively (BUNKER://, Bunker://)', () => {
    const base = validURI().slice('bunker://'.length);
    expect(parsePairingURI('BUNKER://' + base)).not.toBeNull();
    expect(parsePairingURI('Bunker://' + base)).not.toBeNull();
  });

  it('collapses duplicate identical relay entries inside a single URI', () => {
    const uri = `bunker://${ENDPOINT}?relay=${encodeURIComponent(RELAY)}&relay=${encodeURIComponent(RELAY)}&secret=${SECRET}&dependant=${DEPENDANT}&name=Alice`;
    const parsed = parsePairingURI(uri);
    expect(parsed?.relays).toEqual([RELAY]);
  });

  it('rejects URIs with duplicate `secret` / `dependant` / `name` params', () => {
    const dupSecret = `bunker://${ENDPOINT}?relay=${encodeURIComponent(RELAY)}&secret=${SECRET}&secret=other&dependant=${DEPENDANT}&name=Alice`;
    expect(parsePairingURI(dupSecret)).toBeNull();
    const dupDep = `bunker://${ENDPOINT}?relay=${encodeURIComponent(RELAY)}&secret=${SECRET}&dependant=${DEPENDANT}&dependant=${'c'.repeat(64)}&name=Alice`;
    expect(parsePairingURI(dupDep)).toBeNull();
    const dupName = `bunker://${ENDPOINT}?relay=${encodeURIComponent(RELAY)}&secret=${SECRET}&dependant=${DEPENDANT}&name=Alice&name=Bob`;
    expect(parsePairingURI(dupName)).toBeNull();
  });

  it('rejects URIs exceeding the 8 KB length cap', () => {
    const bloat = 'A'.repeat(9000);
    const bad = `bunker://${ENDPOINT}?relay=${encodeURIComponent(RELAY)}&secret=${SECRET}&dependant=${DEPENDANT}&name=${bloat}`;
    expect(parsePairingURI(bad)).toBeNull();
  });

  it('rejects URIs with oversize relay values', () => {
    const longRelay = 'wss://' + 'x'.repeat(1100) + '.com';
    const bad = `bunker://${ENDPOINT}?relay=${encodeURIComponent(longRelay)}&secret=${SECRET}&dependant=${DEPENDANT}&name=Alice`;
    expect(parsePairingURI(bad)).toBeNull();
  });

  it('rejects URIs with oversize secret values', () => {
    const longSecret = 'a'.repeat(300);
    const bad = `bunker://${ENDPOINT}?relay=${encodeURIComponent(RELAY)}&secret=${longSecret}&dependant=${DEPENDANT}&name=Alice`;
    expect(parsePairingURI(bad)).toBeNull();
  });

  // ── C1: guardian= param ────────────────────────────────────────────────

  it('parses guardianPubkey when present, lowercased', () => {
    const uri = `bunker://${ENDPOINT}?relay=${encodeURIComponent(RELAY)}&secret=${SECRET}&dependant=${DEPENDANT}&name=Alice&guardian=${GUARDIAN.toUpperCase()}`;
    const parsed = parsePairingURI(uri);
    expect(parsed?.guardianPubkey).toBe(GUARDIAN);
  });

  it('leaves guardianPubkey undefined when absent (pre-C1 QRs)', () => {
    const uri = `bunker://${ENDPOINT}?relay=${encodeURIComponent(RELAY)}&secret=${SECRET}&dependant=${DEPENDANT}&name=Alice`;
    const parsed = parsePairingURI(uri);
    expect(parsed?.guardianPubkey).toBeUndefined();
  });

  it('returns null when guardian is present but malformed', () => {
    const bad = `bunker://${ENDPOINT}?relay=${encodeURIComponent(RELAY)}&secret=${SECRET}&dependant=${DEPENDANT}&name=Alice&guardian=not-hex`;
    expect(parsePairingURI(bad)).toBeNull();
  });

  it('rejects URIs with duplicate guardian params', () => {
    const bad = `bunker://${ENDPOINT}?relay=${encodeURIComponent(RELAY)}&secret=${SECRET}&dependant=${DEPENDANT}&name=Alice&guardian=${GUARDIAN}&guardian=${'c'.repeat(64)}`;
    expect(parsePairingURI(bad)).toBeNull();
  });
});

describe('generatePairingSecret', () => {
  it('returns a 32-char hex string (16 bytes)', () => {
    const s = generatePairingSecret();
    expect(s).toMatch(/^[0-9a-f]{32}$/);
  });

  it('returns unique values across calls (entropy sanity)', () => {
    const a = generatePairingSecret();
    const b = generatePairingSecret();
    expect(a).not.toBe(b);
  });
});
