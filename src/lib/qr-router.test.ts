import { describe, it, expect } from 'vitest';
import { routeQR } from './qr-router';
import { buildPairingUriV2 } from '@forgesworn/signet-contacts/wire';
import { buildPairingUri } from '@forgesworn/kenspeckle/companion-rail';

const now = Math.floor(Date.now() / 1000);
const validHex32 = 'a'.repeat(32);
const validHex64 = 'a'.repeat(64);

describe('routeQR', () => {
  describe('verify requests', () => {
    it('routes valid signet-verify-request JSON', () => {
      const payload = JSON.stringify({
        type: 'signet-verify-request',
        requestId: validHex32,
        requiredAgeRange: '18+',
        timestamp: now,
      });
      const result = routeQR(payload);
      expect(result.type).toBe('verify');
      if (result.type === 'verify') {
        expect(result.request.requiredAgeRange).toBe('18+');
      }
    });

    it('routes base64-encoded signet:verify: prefix', () => {
      const json = JSON.stringify({
        type: 'signet-verify-request',
        requestId: validHex32,
        requiredAgeRange: '18+',
        timestamp: now,
      });
      const result = routeQR('signet:verify:' + btoa(json));
      expect(result.type).toBe('verify');
    });

    it('rejects verify request with invalid age range', () => {
      const payload = JSON.stringify({
        type: 'signet-verify-request',
        requestId: validHex32,
        requiredAgeRange: '99+',
        timestamp: now,
      });
      expect(routeQR(payload).type).toBe('unknown');
    });

    it('rejects verify request with stale timestamp', () => {
      const payload = JSON.stringify({
        type: 'signet-verify-request',
        requestId: validHex32,
        requiredAgeRange: '18+',
        timestamp: now - 600,
      });
      expect(routeQR(payload).type).toBe('unknown');
    });
  });

  describe('auth requests', () => {
    it('routes valid compact auth request (t: sa)', () => {
      const payload = JSON.stringify({
        t: 'sa',
        r: validHex32,
        c: 'challenge-string-16ch',
        o: 'https://example.com',
        s: now,
      });
      const result = routeQR(payload);
      expect(result.type).toBe('auth');
    });

    it('routes full signet-auth-request', () => {
      const payload = JSON.stringify({
        type: 'signet-auth-request',
        requestId: validHex32,
        challenge: 'challenge-string-16ch',
        origin: 'https://example.com',
        timestamp: now,
      });
      expect(routeQR(payload).type).toBe('auth');
    });

    it('rejects auth request with http:// origin (non-localhost)', () => {
      const payload = JSON.stringify({
        type: 'signet-auth-request',
        requestId: validHex32,
        challenge: 'challenge-string-16ch',
        origin: 'http://example.com',
        timestamp: now,
      });
      expect(routeQR(payload).type).toBe('unknown');
    });
  });

  describe('companion pairing', () => {
    const pairQuery = () => new URLSearchParams({
      app: 'a'.repeat(64), name: 'My App', scope: 'kith,kin',
      relay: 'wss://relay.example.com', t: String(now), challenge: 'f'.repeat(32),
    }).toString();

    it('routes a signet-grant:// scheme pairing link', () => {
      expect(routeQR(`signet-grant://pair?${pairQuery()}`).type).toBe('companion-pair');
    });

    it('routes a verified https://mysignet.app/pair App Link', () => {
      // The interception-resistant carrier — same request, App-Link form.
      expect(routeQR(`https://mysignet.app/pair?${pairQuery()}`).type).toBe('companion-pair');
    });

    it('a /pair App Link with a malformed request is not a pairing action', () => {
      expect(routeQR('https://mysignet.app/pair?app=nothex').type).not.toBe('companion-pair');
    });
  });

  describe('contacts v2 pairing route', () => {
    const NOW = 1_700_000_000;
    function v2Uri(): string {
      return buildPairingUriV2({
        appPubkey: 'a'.repeat(64), appName: 'Flock',
        capabilities: ['signet.contacts.read:directory'], directory: 'owner',
        relay: 'wss://relay.example.com', nowSec: Math.floor(Date.now() / 1000), challenge: 'D'.repeat(32),
      });
    }

    it('routes a v2 URI to contacts-pair-v2', () => {
      const action = routeQR(v2Uri());
      expect(action.type).toBe('contacts-pair-v2');
    });

    it('routes a v2 mysignet.app App Link to contacts-pair-v2', () => {
      const q = v2Uri().slice(v2Uri().indexOf('?') + 1);
      expect(routeQR(`https://mysignet.app/pair?${q}`).type).toBe('contacts-pair-v2');
    });

    it('still routes a v1 URI to companion-pair', () => {
      const v1 = buildPairingUri({
        appPubkey: 'a'.repeat(64), appName: 'Fledgling', scope: ['kin'],
        relay: 'wss://relay.example.com', nowSec: Math.floor(Date.now() / 1000), challenge: 'D'.repeat(32),
      });
      expect(routeQR(v1).type).toBe('companion-pair');
    });

    it('does not route a stale v2 URI as v1', () => {
      const stale = buildPairingUriV2({
        appPubkey: 'a'.repeat(64), appName: 'Flock',
        capabilities: ['signet.contacts.read:directory'], directory: 'owner',
        relay: 'wss://relay.example.com', nowSec: NOW, challenge: 'D'.repeat(32),
      });
      expect(routeQR(stale).type).not.toBe('companion-pair');
    });
  });

  describe('heartwood operator import link', () => {
    const SK = '1'.repeat(64);
    it('routes a Sapwood #/import link (any origin, full URL or bare fragment) with the raw text', () => {
      const full = `https://sapwood.example/#/import?op=${SK}&dev=${'a'.repeat(64)}&relays=wss://r.example`;
      const action = routeQR(full);
      expect(action.type).toBe('heartwood-operator-import');
      if (action.type === 'heartwood-operator-import') expect(action.raw).toBe(full);
      expect(routeQR(`#/import?eop=ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p&dev=${'b'.repeat(64)}`).type).toBe('heartwood-operator-import');
    });
    it('a #/import fragment without an operator secret is not routed there', () => {
      expect(routeQR(`https://sapwood.example/#/import?dev=${'a'.repeat(64)}`).type).not.toBe('heartwood-operator-import');
    });
  });

  describe('login requests', () => {
    it('routes valid compact login request (t: sl)', () => {
      const payload = JSON.stringify({
        t: 'sl',
        r: validHex32,
        c: 'challenge-string-16ch',
        o: 'https://example.com',
        s: now,
        a: '18+',
      });
      expect(routeQR(payload).type).toBe('login');
    });

    it('routes login request without age range', () => {
      const payload = JSON.stringify({
        t: 'sl',
        r: validHex32,
        c: 'challenge-string-16ch',
        o: 'https://example.com',
        s: now,
      });
      expect(routeQR(payload).type).toBe('login');
    });
  });

  describe('nostr-connect URIs', () => {
    it('routes nostr+connect:// with valid pubkey', () => {
      const uri = `nostr+connect://${validHex64}?relay=wss://relay.example.com`;
      const result = routeQR(uri);
      expect(result.type).toBe('nostr-connect');
      if (result.type === 'nostr-connect') {
        expect(result.pubkey).toBe(validHex64);
        expect(result.relay).toBe('wss://relay.example.com');
      }
    });

    it('routes nostrconnect:// (alternate prefix)', () => {
      const uri = `nostrconnect://${validHex64}?relay=wss://relay.example.com`;
      expect(routeQR(uri).type).toBe('nostr-connect');
    });

    it('routes wrapped mysignet.app nostrconnect links from paste or camera scans', () => {
      const uri = `nostrconnect://${validHex64}?relay=wss://relay.example.com&secret=pair-secret&name=Canary&url=${encodeURIComponent('https://canary.trotters.cc')}`;
      const wrapped = `https://mysignet.app/?nostrconnect=${encodeURIComponent(uri)}`;
      const result = routeQR(wrapped);
      expect(result.type).toBe('nostr-connect');
      if (result.type === 'nostr-connect') {
        expect(result.uri).toBe(uri);
        expect(result.pubkey).toBe(validHex64);
        expect(result.relay).toBe('wss://relay.example.com');
      }
    });

    it('rejects nostr-connect with non-wss relay', () => {
      const uri = `nostr+connect://${validHex64}?relay=http://relay.example.com`;
      expect(routeQR(uri).type).toBe('unknown');
    });

    it('allows ws://localhost relay', () => {
      const uri = `nostr+connect://${validHex64}?relay=ws://localhost:7777`;
      expect(routeQR(uri).type).toBe('nostr-connect');
    });
  });

  describe('contact (npub/nprofile)', () => {
    it('routes valid npub', () => {
      const npub = 'npub1' + 'q'.repeat(58);
      expect(routeQR(npub).type).toBe('contact');
    });

    it('rejects npub with invalid bech32 chars', () => {
      const npub = 'npub1' + 'b'.repeat(58);
      expect(routeQR(npub).type).toBe('unknown');
    });
  });

  describe('mysignet.app URL auth QRs', () => {
    function buildUrlAuthQR(params: Record<string, string>, host = 'mysignet.app'): string {
      const u = new URL(`https://${host}/`);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      return u.toString();
    }

    const baseParams = {
      auth: '1',
      challenge: validHex64,
      origin: 'https://example.com',
      callback: 'https://example.com/auth/callback',
      name: 'Example',
      t: String(now),
    };

    it('routes https://mysignet.app?auth=1 URL to login', () => {
      const result = routeQR(buildUrlAuthQR(baseParams));
      expect(result.type).toBe('login');
      if (result.type === 'login') {
        expect(result.request.challenge).toBe(validHex64);
        expect(result.request.origin).toBe('https://example.com');
        expect(result.request.callbackUrl).toBe('https://example.com/auth/callback');
      }
    });

    it('accepts www.mysignet.app', () => {
      expect(routeQR(buildUrlAuthQR(baseParams, 'www.mysignet.app')).type).toBe('login');
    });

    it('is case-insensitive on hostname', () => {
      expect(routeQR(buildUrlAuthQR(baseParams, 'MySignet.App')).type).toBe('login');
    });

    it('returns unknown for mysignet.app URL missing required params', () => {
      const { challenge: _omit, ...rest } = baseParams;
      expect(routeQR(buildUrlAuthQR(rest)).type).toBe('unknown');
    });

    it('returns unknown for mysignet.app URL with stale timestamp', () => {
      expect(routeQR(buildUrlAuthQR({ ...baseParams, t: String(now - 600) })).type).toBe('unknown');
    });

    it('returns unknown for mysignet.app URL with invalid challenge', () => {
      expect(routeQR(buildUrlAuthQR({ ...baseParams, challenge: 'nope' })).type).toBe('unknown');
    });

    it('delegates unrelated https URLs to protocol router (returns unknown)', () => {
      expect(routeQR('https://example.com/?auth=1&challenge=abc').type).toBe('unknown');
    });
  });

  describe('bounds and edge cases', () => {
    it('rejects payloads over 8192 bytes', () => {
      const result = routeQR('x'.repeat(8193));
      expect(result.type).toBe('unknown');
    });

    it('returns unknown for empty string', () => {
      expect(routeQR('').type).toBe('unknown');
    });

    it('returns unknown for random text', () => {
      expect(routeQR('hello world').type).toBe('unknown');
    });
  });
});
