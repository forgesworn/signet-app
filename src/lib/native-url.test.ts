import { describe, expect, it } from 'vitest';
import { routeNativeUrl, contactInviteFromNativeUrl, isUnactionableMysignetLink, NATIVE_LINK_NOTHING_TO_OPEN_COPY } from './native-url';
import { contactInviteLink } from './contact-invite-link';
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

  it('an app-permission link arrives as root-carrier, for the app-permission consumer to pick up', () => {
    const href = 'https://mysignet.app/?action=app-permission&permission=online-play&origin=https%3A%2F%2Ftwang.example';
    expect(routeNativeUrl(href)).toEqual({ type: 'root-carrier', href });
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

describe('isUnactionableMysignetLink', () => {
  const check = (url: string) => isUnactionableMysignetLink(url, routeNativeUrl(url));

  it('is true for a mysignet.app link nothing acted on', () => {
    expect(check('https://mysignet.app/')).toBe(true);
    expect(check('https://www.mysignet.app/')).toBe(true);
    expect(check('https://mysignet.app/pair?app=nothex')).toBe(true);
    expect(check('https://mysignet.app/?pair=1&v=2&app=nothex')).toBe(true);
  });

  it('is false for every link that was routed to something', () => {
    expect(check(`https://mysignet.app/pair?${pairQuery()}`)).toBe(false);
    expect(check(v2Uri())).toBe(false);
    expect(check(`https://mysignet.app/pair?${v2Query()}`)).toBe(false);
    expect(check(signInUrl({}))).toBe(false);
    expect(check('https://mysignet.app/?verify=abc')).toBe(false);
  });

  it('is false for a foreign host, a custom-scheme link or garbage', () => {
    expect(check('https://evil.example/')).toBe(false);
    expect(check(signInUrl({}, 'https://evil.example/'))).toBe(false);
    expect(check('https://evil.example/?pair=1&app=' + 'a'.repeat(64))).toBe(false);
    expect(check('signet-grant://pair?v=2&app=nothex&name=Flock')).toBe(false);
    expect(check('http://mysignet.app/')).toBe(false);
    expect(check('')).toBe(false);
    expect(check('not a url')).toBe(false);
  });

  it('has plain copy', () => {
    expect(NATIVE_LINK_NOTHING_TO_OPEN_COPY).toMatch(/didn't contain a request/);
  });
});

describe('contact invite App Link', () => {
  const invite = { v: 1 as const, recipient: 'a'.repeat(64), secret: 'b'.repeat(64), relays: ['wss://relay.example/'] };
  const link = contactInviteLink(invite, 'https://mysignet.app');
  it('feeds the hash invite to the pending-invite state, cold and warm alike', () => {
    expect(contactInviteFromNativeUrl(link)).toBe(JSON.stringify(invite));
    // The router itself has no query to act on, so the invite check must come first.
    expect(routeNativeUrl(link)).toEqual({ type: 'none' });
  });
  it('ignores other hosts, other paths, expired and oversized invites', () => {
    expect(contactInviteFromNativeUrl(contactInviteLink(invite, 'https://evil.example'))).toBeUndefined();
    expect(contactInviteFromNativeUrl(link.replace('mysignet.app/', 'mysignet.app/about'))).toBeUndefined();
    expect(contactInviteFromNativeUrl(contactInviteLink({ ...invite, expiresAt: 100 }, 'https://mysignet.app'))).toBeUndefined();
    expect(contactInviteFromNativeUrl(link + 'x'.repeat(9000))).toBeUndefined();
  });
});

describe('Keep invite link (keep-invite)', () => {
  const K = 'ab'.repeat(32);
  const P = 'cd'.repeat(32);
  // The route lives in the fragment, parsed like the contact invite's: `#keep-invite=1&k=…&g=…`.
  const link = (q: string, base = 'https://mysignet.app/') => `${base}#${q}`;
  const qlink = (q: string, base = 'https://mysignet.app/') => `${base}?${q}`;
  const valid = `keep-invite=1&k=${K}&g=axenstax`;

  it('routes a valid link to the Keep invite action with the Keep and the game', () => {
    expect(routeNativeUrl(link(valid))).toEqual({ type: 'keep-invite', invite: { keep: K, game: 'axenstax' } });
    expect(routeNativeUrl(link(valid, 'https://www.mysignet.app/')).type).toBe('keep-invite');
  });

  it('carries the person and the name when the link has them, for every allowlisted game', () => {
    for (const game of ['stampede', 'twangthang', 'axenstax', 'gameflock']) {
      expect(routeNativeUrl(link(`keep-invite=1&k=${K}&g=${game}&p=${P}&n=Dave`)))
        .toEqual({ type: 'keep-invite', invite: { keep: K, game, persona: P, name: 'Dave' } });
    }
  });

  it('trims the name, strips control characters and caps it at 64 characters', () => {
    const a = routeNativeUrl(link(`${valid}&n=${encodeURIComponent('  Dave\u0000\u0007‮ Smith\n ')}`));
    expect(a).toMatchObject({ type: 'keep-invite', invite: { name: 'Dave Smith' } });
    const long = routeNativeUrl(link(`${valid}&n=${'x'.repeat(200)}`));
    expect(long.type === 'keep-invite' && long.invite.name).toBe('x'.repeat(64));
    // A name that is nothing but control characters is the same as no name.
    const none = routeNativeUrl(link(`${valid}&n=${encodeURIComponent('\u0000\u0001 ')}`));
    expect(none).toEqual({ type: 'keep-invite', invite: { keep: K, game: 'axenstax' } });
  });

  it('also strips the marks the shared cleaner leaves in, and double quotes, from the name', () => {
    const dirty = 'Da\u061c\ufeff\u2060\u2061\u2064\u00adve "the\u201c man\u201d"';
    expect(routeNativeUrl(link(`${valid}&n=${encodeURIComponent(dirty)}`))).toMatchObject({ invite: { name: 'Dave the man' } });
    // A name made only of them is the same as no name.
    expect(routeNativeUrl(link(`${valid}&n=${encodeURIComponent('\u061c\ufeff"')}`))).toEqual({ type: 'keep-invite', invite: { keep: K, game: 'axenstax' } });
  });

  it('keeps a name that looks like markup as plain text for the screen to render as text', () => {
    const r = routeNativeUrl(link(`${valid}&n=${encodeURIComponent('<img src=x onerror=alert(1)>')}`));
    expect(r).toMatchObject({ type: 'keep-invite', invite: { name: '<img src=x onerror=alert(1)>' } });
  });

  it.each([
    ['a missing k', 'keep-invite=1&g=axenstax'],
    ['a short k', `keep-invite=1&k=${'ab'.repeat(31)}&g=axenstax`],
    ['an uppercase k', `keep-invite=1&k=${K.toUpperCase()}&g=axenstax`],
    ['a non-hex k', `keep-invite=1&k=${'zz'.repeat(32)}&g=axenstax`],
    ['a missing g', `keep-invite=1&k=${K}`],
    ['an empty g', `keep-invite=1&k=${K}&g=`],
    ['a g that is not an allowlisted game', `keep-invite=1&k=${K}&g=unknowngame`],
    ['g=https', `keep-invite=1&k=${K}&g=https`],
    ['g=javascript', `keep-invite=1&k=${K}&g=javascript`],
    ['g=intent', `keep-invite=1&k=${K}&g=intent`],
    ['a g in capitals', `keep-invite=1&k=${K}&g=Stampede`],
    ['a bad p', `${valid}&p=${'cd'.repeat(31)}`],
    ['an uppercase p', `${valid}&p=${P.toUpperCase()}`],
    ['an empty p', `${valid}&p=`],
    ['a repeated k', `${valid}&k=${P}`],
    ['a repeated g', `${valid}&g=stampede`],
    ['a repeated n', `${valid}&n=a&n=b`],
    ['a keep-invite that is not 1', `keep-invite=0&k=${K}&g=axenstax`],
    ['a bare keep-invite', 'keep-invite'],
  ])('refuses %s, and never falls through to root-carrier', (_name, q) => {
    expect(routeNativeUrl(link(q))).toEqual({ type: 'keep-invite-invalid' });
  });

  it('a malformed keep-invite link that also looks like sign-in or a nostrconnect carrier is still refused', () => {
    const si = signInUrl({ 'keep-invite': '1' });
    expect(routeNativeUrl(si)).toEqual({ type: 'keep-invite-invalid' });
    expect(routeNativeUrl(link(`keep-invite=1&nostrconnect=nostrconnect%3A%2F%2F${K}&g=https`))).toEqual({ type: 'keep-invite-invalid' });
    expect(routeNativeUrl(link(`auth=1&keep-invite=1&k=${K}&g=intent`)).type).not.toBe('root-carrier');
  });

  it('a malformed link is not "none" either, so the app does not also say it held nothing', () => {
    for (const url of [link(`keep-invite=1&k=${K}&g=https`), link(valid)]) {
      expect(isUnactionableMysignetLink(url, routeNativeUrl(url))).toBe(false);
    }
  });

  it('is only read on our own host at the root path', () => {
    expect(routeNativeUrl(link(valid, 'https://example.com/')).type).toBe('none');
    expect(routeNativeUrl(link(valid, 'https://mysignet.app/other')).type).toBe('none');
    expect(routeNativeUrl(link(valid, 'http://mysignet.app/')).type).toBe('none');
  });

  it('other links are routed exactly as before', () => {
    expect(routeNativeUrl(qlink('some=thing')).type).toBe('root-carrier');
    expect(routeNativeUrl(qlink(`keep=${K}&game=axenstax`)).type).toBe('root-carrier');
    expect(routeNativeUrl('https://mysignet.app/').type).toBe('none');
    // A fragment that is not a keep-invite one changes nothing: a plain root link is still nothing, a carrier still a carrier.
    expect(routeNativeUrl('https://mysignet.app/#something-else=1').type).toBe('none');
    expect(routeNativeUrl(`${qlink('some=thing')}#something-else=1`).type).toBe('root-carrier');
    expect(routeNativeUrl(signInUrl()).type).toBe('sign-in');
  });

  it('the old query form was never released and is refused, never read as a carrier, sign-in or pairing', () => {
    expect(routeNativeUrl(qlink(valid))).toEqual({ type: 'keep-invite-invalid' });
    expect(routeNativeUrl(qlink(`keep-invite=1&k=${K}&g=axenstax&p=${P}&n=Dave`))).toEqual({ type: 'keep-invite-invalid' });
    expect(routeNativeUrl(qlink('keep-invite=1'))).toEqual({ type: 'keep-invite-invalid' });
    expect(routeNativeUrl(signInUrl({ 'keep-invite': '1' }))).toEqual({ type: 'keep-invite-invalid' });
  });

  it('a keep-invite fragment together with any query is refused (pairing, sign-in, carriers or anything else)', () => {
    for (const q of ['pair=1', 'auth=1', 'some=thing', `keep-invite=1&k=${K}&g=axenstax`, `nostrconnect=x`]) {
      expect(routeNativeUrl(`https://mysignet.app/?${q}#${valid}`)).toEqual({ type: 'keep-invite-invalid' });
    }
    expect(routeNativeUrl(`${signInUrl()}#${valid}`)).toEqual({ type: 'keep-invite-invalid' });
    expect(routeNativeUrl(`https://mysignet.app/pair?pair=1#${valid}`).type).not.toBe('keep-invite');
  });

  it('a keep-invite fragment that also carries a contact invite is refused', () => {
    expect(routeNativeUrl(link(`${valid}&contact-invite=abc`))).toEqual({ type: 'keep-invite-invalid' });
  });

  it('is the shape a game builds: root, fragment, percent-encoded name, in any parameter order', () => {
    const name = encodeURIComponent('Dave & Co #1 100%');
    expect(routeNativeUrl(`https://mysignet.app/#n=${name}&g=gameflock&k=${K}&keep-invite=1&p=${P}`))
      .toEqual({ type: 'keep-invite', invite: { keep: K, game: 'gameflock', persona: P, name: 'Dave & Co #1 100%' } });
  });

  it('the existing contact invite route is untouched by the keep-invite fragment', () => {
    expect(contactInviteFromNativeUrl(link(valid))).toBeUndefined();
    expect(routeNativeUrl(link(valid)).type).toBe('keep-invite');
  });
});
