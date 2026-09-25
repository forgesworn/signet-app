import { describe, expect, it } from 'vitest';
import { routeNativeUrl } from './native-url';
import { buildPairingUriV2 } from '@forgesworn/signet-contacts/wire';

// A verified https App Link (root path) or the signet-grant:// scheme lands
// here from Capacitor's appUrlOpen / getLaunchUrl. The router must send a
// consumer's Sign-in-with-Signet URL to the SAME entry point the web page
// uses, keep companion pairing exactly as before, and do nothing for a plain
// mysignet.app link or for any host that isn't ours.

const now = Math.floor(Date.now() / 1000);

function signInUrl(overrides: Record<string, string> = {}, base = 'https://mysignet.app/'): string {
  const params: Record<string, string> = {
    auth: '1',
    challenge: 'a'.repeat(64),
    origin: 'https://fathom.example',
    name: 'Fathom',
    callback: 'https://fathom.example/callback',
    t: String(now),
    relay: 'wss://relay.example.com',
    sessionPubkey: 'b'.repeat(64),
    ...overrides,
  };
  return base + '?' + new URLSearchParams(params).toString();
}

const pairQuery = () => new URLSearchParams({
  app: 'a'.repeat(64), name: 'My App', scope: 'kith,kin',
  relay: 'wss://relay.example.com', t: String(now), challenge: 'f'.repeat(32),
}).toString();

/** A contacts v2 pairing carrier — same `signet-grant:` shape as v1, marked
 *  `v=2` and carrying a capability list instead of a tier scope. Built through
 *  the SDK rather than hand-assembled, so a wire change reaches this test. */
const v2Uri = () => buildPairingUriV2({
  appPubkey: 'a'.repeat(64), appName: 'Flock',
  capabilities: ['signet.contacts.read:directory'],
  directory: 'owner', relay: 'wss://relay.example.com', nowSec: now, challenge: 'D'.repeat(32),
});
const v2Query = () => v2Uri().slice(v2Uri().indexOf('?') + 1);

describe('routeNativeUrl', () => {
  it('routes a relay-mode Sign in with Signet App Link to the sign-in entry point', () => {
    const href = signInUrl();
    expect(routeNativeUrl(href)).toEqual({ type: 'sign-in', href });
  });

  it('routes a redirect-mode (no relay) sign-in link too', () => {
    const href = signInUrl({ relay: '', sessionPubkey: '' });
    const clean = href.replace(/&relay=&sessionPubkey=$/, '');
    expect(routeNativeUrl(clean).type).toBe('sign-in');
  });

  it('accepts www.mysignet.app', () => {
    expect(routeNativeUrl(signInUrl({}, 'https://www.mysignet.app/')).type).toBe('sign-in');
  });

  it('keeps routing companion-pair links in all three carriers', () => {
    expect(routeNativeUrl(`https://mysignet.app/pair?${pairQuery()}`).type).toBe('companion-pair');
    expect(routeNativeUrl(`signet-grant://pair?${pairQuery()}`).type).toBe('companion-pair');
    expect(routeNativeUrl(`https://mysignet.app/?pair=1&${pairQuery()}`).type).toBe('companion-pair');
  });

  it('a /pair link is never mistaken for sign-in even with auth params present', () => {
    const r = routeNativeUrl(`https://mysignet.app/pair?${pairQuery()}&auth=1&challenge=${'a'.repeat(64)}`);
    expect(r.type).toBe('companion-pair');
  });

  it('falls through to sign-in when a sign-in URL merely contains the substring "pair=1"', () => {
    // A name field containing "pair=1" percent-encodes the "=" (URLSearchParams
    // escapes it to "pair%3D1"), so the literal substring can't reach the raw
    // URL that way — append a raw, unrelated "x=pair=1" param instead.
    const href = `${signInUrl()}&x=pair=1`;
    expect(routeNativeUrl(href).type).toBe('sign-in');
  });

  it('falls through to sign-in for a valid sign-in URL with a raw trailing &pair=1', () => {
    const href = `${signInUrl()}&pair=1`;
    expect(routeNativeUrl(href).type).toBe('sign-in');
  });

  it('a genuine /pair link with a malformed pairing request is still none', () => {
    expect(routeNativeUrl('https://mysignet.app/pair?app=nothex')).toEqual({ type: 'none' });
  });

  it('routes a contacts v2 pairing link as v2 in every carrier, never as v1', () => {
    // Fix round 1 / I1: the v1 parser SUCCEEDS on a v2 URI — it finds no tier
    // scope and defaults to all tiers — so a v2 link read as v1 would put the
    // owner in front of the legacy whole-rolodex grant screen for a
    // capability-scoped request. The `v=2` marker is checked first for exactly
    // that reason.
    expect(routeNativeUrl(v2Uri()).type).toBe('contacts-pair-v2');
    expect(routeNativeUrl(`https://mysignet.app/pair?${v2Query()}`).type).toBe('contacts-pair-v2');
    expect(routeNativeUrl(`https://mysignet.app/?pair=1&${v2Query()}`).type).toBe('contacts-pair-v2');
  });

  it('hands back the parsed v2 request, not the raw href', () => {
    const action = routeNativeUrl(v2Uri());
    expect(action.type === 'contacts-pair-v2' && action.request.appName).toBe('Flock');
    expect(action.type === 'contacts-pair-v2' && action.request.capabilities)
      .toEqual(['signet.contacts.read:directory']);
  });

  it('a v1 pairing link is still v1', () => {
    expect(routeNativeUrl(`signet-grant://pair?${pairQuery()}`).type).toBe('companion-pair');
  });

  it('a malformed v2 pairing link is ignored, never downgraded to v1', () => {
    // `v=2` present but the request does not parse: refused outright rather
    // than handed to the v1 parser, which would read it as an all-tiers grant.
    expect(routeNativeUrl('signet-grant://pair?v=2&app=nothex&name=Flock')).toEqual({ type: 'none' });
    expect(routeNativeUrl(`https://mysignet.app/?pair=1&v=2&app=nothex`)).toEqual({ type: 'none' });
  });

  it('does nothing for a plain mysignet.app link', () => {
    expect(routeNativeUrl('https://mysignet.app/')).toEqual({ type: 'none' });
    expect(routeNativeUrl('https://mysignet.app/about')).toEqual({ type: 'none' });
  });

  it('does nothing for a sign-in-shaped URL on a foreign host', () => {
    expect(routeNativeUrl(signInUrl({}, 'https://evil.example/'))).toEqual({ type: 'none' });
  });

  it('routes a stale or malformed sign-in link as a root carrier, not sign-in', () => {
    // These are root-path URLs that failed sign-in validation, not
    // unrelated links — App.tsx's consumeXUrl callbacks get a shot at them
    // (and will simply find nothing to do, since none of them is a verify /
    // add-dependant / nostrconnect param either).
    expect(routeNativeUrl(signInUrl({ t: String(now - 600) })).type).toBe('root-carrier');
    expect(routeNativeUrl(signInUrl({ challenge: 'short' })).type).toBe('root-carrier');
    expect(routeNativeUrl(signInUrl({ callback: 'https://other.example/cb' })).type).toBe('root-carrier');
  });

  it('routes other root-path web carriers as root-carrier', () => {
    const verifyHref = 'https://mysignet.app/?verify=abc';
    expect(routeNativeUrl(verifyHref)).toEqual({ type: 'root-carrier', href: verifyHref });

    const addDepHref = 'https://mysignet.app/?action=add-dependant&origin=https%3A%2F%2Fx.example';
    expect(routeNativeUrl(addDepHref)).toEqual({ type: 'root-carrier', href: addDepHref });

    const nostrConnectHref = 'https://mysignet.app/?nostrconnect=nostrconnect%3A%2F%2Fabc';
    expect(routeNativeUrl(nostrConnectHref)).toEqual({ type: 'root-carrier', href: nostrConnectHref });
  });

  it('does nothing for a root-shaped carrier on a foreign host', () => {
    expect(routeNativeUrl('https://evil.example/?pair=1&app=' + 'a'.repeat(64))).toEqual({ type: 'none' });
  });

  it('does nothing for a plain root link or a non-root path even with a query', () => {
    expect(routeNativeUrl('https://mysignet.app/')).toEqual({ type: 'none' });
    expect(routeNativeUrl('https://mysignet.app/about?verify=abc')).toEqual({ type: 'none' });
  });

  it('does nothing for garbage', () => {
    expect(routeNativeUrl('')).toEqual({ type: 'none' });
    expect(routeNativeUrl('not a url')).toEqual({ type: 'none' });
    expect(routeNativeUrl('x'.repeat(10_000))).toEqual({ type: 'none' });
  });
});
