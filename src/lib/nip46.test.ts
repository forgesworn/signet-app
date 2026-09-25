import { describe, it, expect } from 'vitest';
import {
  parseNIP46Request,
  buildNIP46Response,
  isSupportedMethod,
  parseNostrConnectURI,
  buildConnectedClientFromNostrConnect,
  SUPPORTED_METHODS,
} from './nip46';

const validHex64 = 'a'.repeat(64);

describe('parseNIP46Request', () => {
  it('parses valid request', () => {
    const json = JSON.stringify({ id: 'req-1', method: 'get_public_key', params: [] });
    const result = parseNIP46Request(json);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('req-1');
    expect(result!.method).toBe('get_public_key');
    expect(result!.params).toEqual([]);
  });

  it('parses request with params', () => {
    const json = JSON.stringify({ id: 'req-2', method: 'sign_event', params: ['event-json'] });
    const result = parseNIP46Request(json);
    expect(result!.params).toEqual(['event-json']);
  });

  it('returns null for invalid JSON', () => {
    expect(parseNIP46Request('not json')).toBeNull();
  });

  it('returns null for missing id', () => {
    expect(parseNIP46Request(JSON.stringify({ method: 'test', params: [] }))).toBeNull();
  });

  it('returns null for missing method', () => {
    expect(parseNIP46Request(JSON.stringify({ id: '1', params: [] }))).toBeNull();
  });

  it('returns null for non-array params', () => {
    expect(parseNIP46Request(JSON.stringify({ id: '1', method: 'test', params: 'string' }))).toBeNull();
  });

  it('returns null for non-string params elements', () => {
    expect(parseNIP46Request(JSON.stringify({ id: '1', method: 'test', params: [123] }))).toBeNull();
  });

  it('returns null for oversized content (DoS bound — security audit 2026-06-15)', () => {
    const oversized = 'x'.repeat(128 * 1024 + 1);
    expect(parseNIP46Request(oversized)).toBeNull();
  });

  it('returns null for too many params', () => {
    const params = Array.from({ length: 17 }, (_, i) => String(i));
    expect(parseNIP46Request(JSON.stringify({ id: '1', method: 'sign_event', params }))).toBeNull();
  });
});

describe('buildNIP46Response', () => {
  it('builds response with result', () => {
    const json = buildNIP46Response('req-1', 'pubkey123');
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe('req-1');
    expect(parsed.result).toBe('pubkey123');
    expect(parsed.error).toBeUndefined();
  });

  it('builds response with error', () => {
    const json = buildNIP46Response('req-1', undefined, 'unsupported method');
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe('req-1');
    expect(parsed.result).toBeUndefined();
    expect(parsed.error).toBe('unsupported method');
  });

  it('builds response with both result and error', () => {
    const json = buildNIP46Response('req-1', 'result', 'error');
    const parsed = JSON.parse(json);
    expect(parsed.result).toBe('result');
    expect(parsed.error).toBe('error');
  });
});

describe('isSupportedMethod', () => {
  it('advertises the full NIP-46 method surface MySignet serves', () => {
    expect(SUPPORTED_METHODS).toEqual([
      'connect',
      'get_public_key',
      'sign_event',
      'ping',
      'switch_relays',
      'logout',
      'nip04_encrypt',
      'nip04_decrypt',
      'nip44_encrypt',
      'nip44_decrypt',
    ]);
  });

  it('returns true for all supported methods', () => {
    for (const method of SUPPORTED_METHODS) {
      expect(isSupportedMethod(method)).toBe(true);
    }
  });

  it('returns true for nip44 methods', () => {
    expect(isSupportedMethod('nip44_encrypt')).toBe(true);
    expect(isSupportedMethod('nip44_decrypt')).toBe(true);
  });

  it('returns false for unsupported methods', () => {
    expect(isSupportedMethod('unknown')).toBe(false);
  });
});

describe('parseNostrConnectURI', () => {
  it('parses valid nostrconnect:// URI', () => {
    const uri = `nostrconnect://${validHex64}?relay=wss://relay.example.com&secret=pair-secret&metadata=${encodeURIComponent(JSON.stringify({ name: 'Test App', url: 'https://test.com' }))}`;
    const result = parseNostrConnectURI(uri);
    expect(result).not.toBeNull();
    expect(result!.clientPubkey).toBe(validHex64);
    expect(result!.relayUrl).toBe('wss://relay.example.com');
    expect(result!.relayUrls).toEqual(['wss://relay.example.com']);
    expect(result!.secret).toBe('pair-secret');
    expect(result!.appName).toBe('Test App');
    expect(result!.appUrl).toBe('https://test.com');
  });

  it('preserves ordered valid relay candidates from repeated relay params', () => {
    const uri = `nostrconnect://${validHex64}?relay=wss://relay.primal.net&relay=wss://relay.trotters.cc&relay=wss://nos.lol&relay=wss://relay.primal.net&secret=pair-secret`;
    const result = parseNostrConnectURI(uri);
    expect(result).not.toBeNull();
    expect(result!.relayUrl).toBe('wss://relay.primal.net');
    expect(result!.relayUrls).toEqual([
      'wss://relay.primal.net',
      'wss://relay.trotters.cc',
      'wss://nos.lol',
    ]);
  });

  it('uses the first valid relay when earlier relay params are invalid', () => {
    const uri = `nostrconnect://${validHex64}?relay=http://bad.example&relay=wss://relay.trotters.cc&secret=pair-secret`;
    const result = parseNostrConnectURI(uri);
    expect(result).not.toBeNull();
    expect(result!.relayUrl).toBe('wss://relay.trotters.cc');
    expect(result!.relayUrls).toEqual(['wss://relay.trotters.cc']);
  });

  it('returns null for an oversized URI (DoS bound — security audit 2026-06-15)', () => {
    const huge = `nostrconnect://${validHex64}?relay=wss://r.com&secret=s&metadata=` + 'x'.repeat(9000);
    expect(parseNostrConnectURI(huge)).toBeNull();
  });

  it('ignores oversized metadata but still parses the core fields', () => {
    const bigMeta = encodeURIComponent(JSON.stringify({ name: 'X'.repeat(5000) }));
    const uri = `nostrconnect://${validHex64}?relay=wss://r.com&secret=s&metadata=${bigMeta}`;
    // URI is under the 8192 cap here; metadata is over the 4096 cap so it's
    // skipped — appName falls back to the default rather than DoS-parsing.
    const result = parseNostrConnectURI(uri);
    if (result) expect(result.appName).toBe('Unknown App');
  });

  it('returns null for non-nostrconnect scheme', () => {
    expect(parseNostrConnectURI(`https://${validHex64}?relay=wss://r.com`)).toBeNull();
  });

  it('returns null for missing pubkey', () => {
    expect(parseNostrConnectURI('nostrconnect://?relay=wss://r.com')).toBeNull();
  });

  it('returns null for invalid pubkey (not 64 hex)', () => {
    expect(parseNostrConnectURI('nostrconnect://short?relay=wss://r.com&secret=s')).toBeNull();
  });

  it('returns null for missing relay', () => {
    expect(parseNostrConnectURI(`nostrconnect://${validHex64}?secret=s`)).toBeNull();
  });

  it('returns null for missing secret', () => {
    expect(parseNostrConnectURI(`nostrconnect://${validHex64}?relay=wss://r.com`)).toBeNull();
  });

  it('returns null for non-wss relay', () => {
    expect(parseNostrConnectURI(`nostrconnect://${validHex64}?relay=http://r.com&secret=s`)).toBeNull();
  });

  it('allows ws://localhost relay', () => {
    const result = parseNostrConnectURI(`nostrconnect://${validHex64}?relay=ws://localhost:7777&secret=s`);
    expect(result).not.toBeNull();
  });

  it('defaults appName to Unknown App when no metadata', () => {
    const result = parseNostrConnectURI(`nostrconnect://${validHex64}?relay=wss://r.com&secret=s`);
    expect(result!.appName).toBe('Unknown App');
    expect(result!.appUrl).toBeUndefined();
  });

  it('parses top-level name and url params emitted by signet-login', () => {
    const result = parseNostrConnectURI(
      `nostrconnect://${validHex64}?relay=wss://r.com&secret=s&name=CANARY&url=${encodeURIComponent('https://canary.trotters.cc/path')}`,
    );
    expect(result).not.toBeNull();
    expect(result!.appName).toBe('CANARY');
    expect(result!.appUrl).toBe('https://canary.trotters.cc');
  });

  it('truncates long app name to 100 chars', () => {
    const meta = JSON.stringify({ name: 'x'.repeat(200) });
    const result = parseNostrConnectURI(`nostrconnect://${validHex64}?relay=wss://r.com&secret=s&metadata=${encodeURIComponent(meta)}`);
    expect(result!.appName).toHaveLength(100);
  });

  it('ignores invalid metadata JSON gracefully', () => {
    const result = parseNostrConnectURI(`nostrconnect://${validHex64}?relay=wss://r.com&secret=s&metadata=not-json`);
    expect(result!.appName).toBe('Unknown App');
  });
});

describe('parseNostrConnectURI — web-redirect wrapper contract', () => {
  // Contract used by companion apps that cross the desktop-scheme gap
  // by redirecting to `https://mysignet.app/?nostrconnect=<encoded-uri>`
  // instead of relying on the raw `nostrconnect://` scheme (which on
  // Linux desktops drops users into an xdg-open "pick an app" prompt).
  //
  // Companion wraps the inner URI with a SINGLE `encodeURIComponent`.
  // Our side reads via `URLSearchParams.get`, which performs exactly
  // one percent-decode. No further decoding is done — that would
  // double-decode and mangle any pre-escaped `%XX` inside the inner
  // URI (e.g. the metadata JSON's escaped quotes).
  const original = `nostrconnect://${validHex64}?relay=wss://relay.example.com&secret=pair-secret&metadata=${encodeURIComponent(JSON.stringify({ name: 'matchpass-app', url: 'https://matchpass.example.com' }))}`;

  it('extracts and parses the inner URI from a mysignet.app redirect URL', () => {
    const redirectUrl = `https://mysignet.app/?nostrconnect=${encodeURIComponent(original)}`;
    const extracted = new URL(redirectUrl).searchParams.get('nostrconnect')!;
    expect(extracted).toBe(original);

    const request = parseNostrConnectURI(extracted);
    expect(request).not.toBeNull();
    expect(request!.clientPubkey).toBe(validHex64);
    expect(request!.relayUrl).toBe('wss://relay.example.com');
    expect(request!.appName).toBe('matchpass-app');
    expect(request!.appUrl).toBe('https://matchpass.example.com');
  });

  it('preserves pre-escaped %XX sequences inside the inner URI (no double-decode)', () => {
    // The inner URI's metadata value is already percent-encoded (quotes
    // and braces). Round-tripping through the outer URL must not unwrap
    // that layer — the inner `%22` sequences must arrive intact so the
    // nested JSON parses.
    const redirectUrl = `https://mysignet.app/?nostrconnect=${encodeURIComponent(original)}`;
    const extracted = new URL(redirectUrl).searchParams.get('nostrconnect')!;
    const request = parseNostrConnectURI(extracted)!;
    // If the metadata JSON were double-decoded, the quotes would unwrap
    // and JSON.parse (inside parseNostrConnectURI) would fail, giving
    // us the default 'Unknown App' — this guards that regression.
    expect(request.appName).toBe('matchpass-app');
  });

  it('coexists with `?auth=1` gracefully — the two URL schemes are distinct', () => {
    // Invariant: a URL that has only `?nostrconnect=` MUST NOT also
    // satisfy `parseSignInRequest` (which looks for `auth=1`). If this
    // invariant ever breaks, the two useEffects could race.
    const redirectUrl = `https://mysignet.app/?nostrconnect=${encodeURIComponent(original)}`;
    const u = new URL(redirectUrl);
    expect(u.searchParams.get('auth')).toBeNull();
    expect(u.searchParams.get('nostrconnect')).not.toBeNull();
  });
});

describe('buildConnectedClientFromNostrConnect', () => {
  it('persists explicit NostrConnect approval as an allow-always connected client', () => {
    const request = parseNostrConnectURI(
      `nostrconnect://${'A'.repeat(64)}?relay=wss://relay.example.com&secret=s&name=Canary&url=${encodeURIComponent('https://canary.trotters.cc/path')}`,
    );
    expect(request).not.toBeNull();

    expect(buildConnectedClientFromNostrConnect(request!, 1_770_000_000)).toEqual({
      clientPubkey: 'a'.repeat(64),
      appName: 'Canary',
      appUrl: 'https://canary.trotters.cc',
      connectedAt: 1_770_000_000,
      lastSeenAt: 1_770_000_000,
      allowAlways: true,
    });
  });
});
