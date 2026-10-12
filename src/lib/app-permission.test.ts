import { describe, it, expect } from 'vitest';
import { getPublicKey, generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import {
  parseAppPermissionRequest, validateAppPermissionTemplate, checkAppPermissionClaim, appPermissionAskDetails,
  buildAppPermissionApprovedRumor, buildAppPermissionDeniedRumor, appPermissionTemplateOf,
  APP_PERMISSION_KIND, APP_PERMISSION_RESPONSE_TYPE,
  type AppPermissionRefusal, type AppPermissionTemplateRefusal,
} from './app-permission';
import type { ChildSignAsk } from './child-sign-asks';

const NOW = 1_790_000_000;
const PERSONA = getPublicKey(generateSecretKey());
const INSTALL = getPublicKey(generateSecretKey());
const SESSION = getPublicKey(generateSecretKey());
const CHALLENGE = 'ab'.repeat(32);
const NOT_A_POINT = 'f'.repeat(64);

function tags(over: Record<string, string | null> = {}): string[][] {
  const base: Record<string, string> = {
    d: 'twang-thang', p: INSTALL, valid_from: String(NOW), valid_until: String(NOW + 90 * 86400),
    v: '1', role: 'player', expiration: String(NOW + 90 * 86400),
  };
  const out: string[][] = [];
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) out.push([k, v]);
  return out;
}
function template(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 30420, pubkey: PERSONA, content: '', tags: tags(), ...over };
}
const b64url = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v), 'utf8').toString('base64url');

function params(over: Record<string, string | null> = {}): string {
  const base: Record<string, string> = {
    action: 'app-permission', permission: 'online-play', origin: 'https://twang.example', name: 'Twang Thang',
    reason: 'Twang Thang shows the other players it is really you.', template: b64url(template()),
    relay: 'wss://relay.example', sessionPubkey: SESSION, challenge: CHALLENGE, t: String(NOW),
    callback: 'https://twang.example/back',
  };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== null) p.set(k, v);
  return `?${p.toString()}`;
}
const parse = (over: Record<string, string | null> = {}) => parseAppPermissionRequest(params(over), NOW);
const refusal = (over: Record<string, string | null>): AppPermissionRefusal | null => {
  const r = parse(over);
  return r.ok ? null : r.reason;
};
const tmplRefusal = (raw: unknown, checkTime = true): AppPermissionTemplateRefusal | null => {
  const r = validateAppPermissionTemplate(raw, { nowS: NOW, checkTime });
  return r.ok ? null : r.reason;
};

describe('parseAppPermissionRequest — accepts', () => {
  it('a well-formed request, canonicalised', () => {
    const r = parse({ origin: 'https://Twang.Example', challenge: CHALLENGE.toUpperCase(), sessionPubkey: SESSION.toUpperCase() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request).toMatchObject({
      permission: 'online-play', origin: 'https://twang.example', name: 'Twang Thang', relay: 'wss://relay.example',
      sessionPubkey: SESSION, challenge: CHALLENGE, t: NOW, callback: 'https://twang.example/back',
    });
    expect(r.request.template).toEqual({ kind: 30420, pubkey: PERSONA, content: '', tags: tags() });
    expect(r.request.details).toEqual({ appId: 'twang-thang', installKey: INSTALL, validFrom: NOW, validUntil: NOW + 90 * 86400 });
  });
  it('localhost and 127.0.0.1 over http', () => {
    expect(parse({ origin: 'http://localhost:5175', callback: 'http://localhost:5175/cb' }).ok).toBe(true);
    expect(parse({ origin: 'http://127.0.0.1:8080', callback: 'http://127.0.0.1:8080/' }).ok).toBe(true);
  });
  it('t at exactly ±300 s', () => {
    expect(parse({ t: String(NOW - 300) }).ok).toBe(true);
    expect(parse({ t: String(NOW + 300) }).ok).toBe(true);
  });
  it('tags in any order', () => {
    expect(parse({ template: b64url(template({ tags: [...tags()].reverse() })) }).ok).toBe(true);
  });
  it('sanitises name and reason (control / bidi characters stripped)', () => {
    const r = parse({ name: '  Twang‮ Thang\u0007 ', reason: 'Play​ online' });
    expect(r.ok && r.request.name).toBe('Twang Thang');
    expect(r.ok && r.request.reason).toBe('Play online');
  });
});

describe('parseAppPermissionRequest — refuses', () => {
  const cases: [string, Record<string, string | null>, AppPermissionRefusal][] = [
    ['another action', { action: 'add-dependant' }, 'action'],
    ['no action', { action: null }, 'action'],
    ['no permission', { permission: null }, 'permission'],
    ['a permission off the closed list', { permission: 'post-public' }, 'permission'],
    ['a permission in another case', { permission: 'Online-Play' }, 'permission'],
    ['no origin', { origin: null }, 'origin'],
    ['an unparseable origin', { origin: 'not a url' }, 'origin'],
    ['an http origin that is not localhost', { origin: 'http://twang.example', callback: 'http://twang.example/b' }, 'origin'],
    ['a javascript: origin', { origin: 'javascript:alert(1)' }, 'origin'],
    ['no callback', { callback: null }, 'callback'],
    ['a cross-origin callback', { callback: 'https://evil.example/back' }, 'callback'],
    ['an http callback for an https origin', { callback: 'http://twang.example/back' }, 'callback'],
    ['no t', { t: null }, 't'],
    ['a non-integer t', { t: '1790000000.5' }, 't'],
    ['an exponent t', { t: '1.79e9' }, 't'],
    ['t 301 s old', { t: String(NOW - 301) }, 't'],
    ['t 301 s ahead', { t: String(NOW + 301) }, 't'],
    ['no challenge', { challenge: null }, 'challenge'],
    ['a short challenge', { challenge: 'ab'.repeat(31) }, 'challenge'],
    ['a non-hex challenge', { challenge: 'zz'.repeat(32) }, 'challenge'],
    ['no relay', { relay: null }, 'relay'],
    ['a non-wss relay', { relay: 'https://relay.example' }, 'relay'],
    ['a ws relay off localhost', { relay: 'ws://relay.example' }, 'relay'],
    ['a relay over 1024 chars', { relay: `wss://relay.example/${'a'.repeat(1010)}` }, 'relay'],
    ['no session key', { sessionPubkey: null }, 'session'],
    ['a short session key', { sessionPubkey: SESSION.slice(2) }, 'session'],
    ['a session key that is not a point', { sessionPubkey: NOT_A_POINT }, 'session'],
    ['no name', { name: null }, 'name'],
    ['a name empty after sanitising', { name: ' ‮​ ' }, 'name'],
    ['a name over 64 characters', { name: 'n'.repeat(65) }, 'name'],
    ['no reason', { reason: null }, 'reason'],
    ['a reason empty after sanitising', { reason: '\u0000⁦' }, 'reason'],
    ['a reason over 200 characters', { reason: 'r'.repeat(201) }, 'reason'],
    ['no template', { template: null }, 'template'],
    ['a template param over 4096 chars', { template: 'A'.repeat(4097) }, 'template'],
    ['a template that is not base64url', { template: 'eyJ+/=' }, 'template'],
    ['a template that is not JSON', { template: b64url('{nope') }, 'template'],
    ['a template that is not an object', { template: b64url([1, 2]) }, 'template'],
    ['a template that fails the shape check', { template: b64url(template({ kind: 1 })) }, 'template'],
  ];
  for (const [name, over, reason] of cases) it(name, () => expect(refusal(over)).toBe(reason));

  it('a name of exactly 64 and a reason of exactly 200 are fine', () => {
    expect(parse({ name: 'n'.repeat(64), reason: 'r'.repeat(200) }).ok).toBe(true);
  });
  it('a template valid_from 301 s from now (time checked at parse)', () => {
    const t = tags({ valid_from: String(NOW - 301), valid_until: String(NOW + 1000), expiration: String(NOW + 1000) });
    expect(refusal({ template: b64url(template({ tags: t })) })).toBe('template');
  });
});

describe('validateAppPermissionTemplate (D2)', () => {
  it('accepts the one shape', () => {
    expect(tmplRefusal(template())).toBeNull();
  });
  const keyCases: [string, Record<string, unknown>][] = [
    ['created_at', { created_at: NOW }],
    ['id', { id: 'a'.repeat(64) }],
    ['sig', { sig: 'b'.repeat(128) }],
    ['anything else', { extra: 1 }],
  ];
  for (const [name, extra] of keyCases) {
    it(`refuses an extra key: ${name}`, () => expect(tmplRefusal(template(extra))).toBe('keys'));
  }
  it('refuses a missing key', () => {
    const { content: _c, ...rest } = template(); void _c;
    expect(tmplRefusal(rest)).toBe('keys');
  });
  it('refuses a non-object', () => {
    expect(tmplRefusal(null)).toBe('keys');
    expect(tmplRefusal('x')).toBe('keys');
    expect(tmplRefusal([template()])).toBe('keys');
  });
  it('refuses another kind (incl. a string 30420)', () => {
    expect(tmplRefusal(template({ kind: 30421 }))).toBe('kind');
    expect(tmplRefusal(template({ kind: '30420' }))).toBe('kind');
  });
  it('refuses non-empty content', () => {
    expect(tmplRefusal(template({ content: ' ' }))).toBe('content');
  });
  it('refuses a pubkey that is not 64 lowercase hex', () => {
    expect(tmplRefusal(template({ pubkey: PERSONA.toUpperCase() }))).toBe('pubkey');
    expect(tmplRefusal(template({ pubkey: PERSONA.slice(1) }))).toBe('pubkey');
  });
  it('refuses tags that are not an array', () => {
    expect(tmplRefusal(template({ tags: {} }))).toBe('tags');
  });
  it('refuses a missing tag, a duplicated tag, an unknown tag', () => {
    expect(tmplRefusal(template({ tags: tags({ role: null }) }))).toBe('tags');
    expect(tmplRefusal(template({ tags: [...tags(), ['v', '1']] }))).toBe('tags');
    expect(tmplRefusal(template({ tags: [...tags({ v: null }), ['x', '1']] }))).toBe('tags');
    expect(tmplRefusal(template({ tags: [...tags(), ['x', '1']] }))).toBe('tags');
  });
  it('refuses a tag that is not exactly [name, value]', () => {
    const t = tags();
    t[0] = [...t[0], 'extra'];
    expect(tmplRefusal(template({ tags: t }))).toBe('tags');
    const u = tags();
    u[1] = [u[1][0]];
    expect(tmplRefusal(template({ tags: u }))).toBe('tags');
    const w = tags();
    (w as unknown[])[2] = ['valid_from', NOW];
    expect(tmplRefusal(template({ tags: w }))).toBe('tags');
  });
  it('d: [a-z0-9-]{1,64}', () => {
    expect(tmplRefusal(template({ tags: tags({ d: '' }) }))).toBe('d');
    expect(tmplRefusal(template({ tags: tags({ d: 'Twang' }) }))).toBe('d');
    expect(tmplRefusal(template({ tags: tags({ d: 'twang_thang' }) }))).toBe('d');
    expect(tmplRefusal(template({ tags: tags({ d: 'a'.repeat(65) }) }))).toBe('d');
    expect(tmplRefusal(template({ tags: tags({ d: 'a'.repeat(64) }) }))).toBeNull();
  });
  it('p: 64 lowercase hex, a valid point, not the persona', () => {
    expect(tmplRefusal(template({ tags: tags({ p: INSTALL.toUpperCase() }) }))).toBe('p');
    expect(tmplRefusal(template({ tags: tags({ p: NOT_A_POINT }) }))).toBe('p');
    expect(tmplRefusal(template({ tags: tags({ p: '0'.repeat(64) }) }))).toBe('p');
    expect(tmplRefusal(template({ tags: tags({ p: PERSONA }) }))).toBe('p');
  });
  it('valid_from: an integer string within ±300 s (checkTime only)', () => {
    const at = (from: number) => template({ tags: tags({ valid_from: String(from), valid_until: String(from + 10), expiration: String(from + 10) }) });
    expect(tmplRefusal(at(NOW - 300))).toBeNull();
    expect(tmplRefusal(at(NOW + 300))).toBeNull();
    expect(tmplRefusal(at(NOW - 301))).toBe('valid_from');
    expect(tmplRefusal(at(NOW + 301))).toBe('valid_from');
    // The guardian re-runs it later: no clock check, everything else still checked.
    expect(tmplRefusal(at(NOW - 86400), false)).toBeNull();
    expect(tmplRefusal(template({ tags: tags({ valid_from: '01790000000' }) }))).toBe('valid_from');
    expect(tmplRefusal(template({ tags: tags({ valid_from: '-5' }) }))).toBe('valid_from');
    expect(tmplRefusal(template({ tags: tags({ valid_from: '1.79e9' }) }))).toBe('valid_from');
  });
  it('valid_until: > valid_from and ≤ valid_from + 90 days (checked with or without the clock)', () => {
    const until = (u: number) => template({ tags: tags({ valid_until: String(u), expiration: String(u) }) });
    for (const checkTime of [true, false]) {
      expect(tmplRefusal(until(NOW), checkTime)).toBe('valid_until');
      expect(tmplRefusal(until(NOW - 1), checkTime)).toBe('valid_until');
      expect(tmplRefusal(until(NOW + 90 * 86400 + 1), checkTime)).toBe('valid_until');
      expect(tmplRefusal(until(NOW + 1), checkTime)).toBeNull();
    }
    expect(tmplRefusal(template({ tags: tags({ valid_until: 'soon' }) }))).toBe('valid_until');
  });
  it('v = "1", role = "player"', () => {
    expect(tmplRefusal(template({ tags: tags({ v: '2' }) }))).toBe('v');
    expect(tmplRefusal(template({ tags: tags({ role: 'admin' }) }))).toBe('role');
  });
  it('expiration == valid_until', () => {
    expect(tmplRefusal(template({ tags: tags({ expiration: String(NOW + 1000) }) }))).toBe('expiration');
    expect(tmplRefusal(template({ tags: tags({ expiration: '0' + String(NOW + 90 * 86400) }) }))).toBe('expiration');
  });
});

describe('appPermissionTemplateOf', () => {
  it('projects a signed-or-unsigned event onto the four template fields', () => {
    const t = { kind: 30420, pubkey: PERSONA, created_at: NOW, tags: tags(), content: '' } as UnsignedEvent;
    expect(appPermissionTemplateOf(t)).toEqual({ kind: 30420, pubkey: PERSONA, content: '', tags: tags() });
  });
});

describe('checkAppPermissionClaim (D6)', () => {
  const claim = { permission: 'online-play', name: 'Twang Thang', origin: 'https://twang.example', reason: 'To play online.' };
  it('accepts a sanitised claim', () => {
    expect(checkAppPermissionClaim(claim)).toEqual(claim);
    expect(checkAppPermissionClaim({ ...claim, origin: 'http://localhost:5175' })).toEqual({ ...claim, origin: 'http://localhost:5175' });
  });
  it('re-sanitises name and reason', () => {
    expect(checkAppPermissionClaim({ ...claim, name: 'Twang‮ Thang' })?.name).toBe('Twang Thang');
  });
  it('refuses: unknown permission, bad origin, empty / long name or reason, extra keys, wrong types', () => {
    expect(checkAppPermissionClaim({ ...claim, permission: 'post' })).toBeNull();
    expect(checkAppPermissionClaim({ ...claim, origin: 'http://twang.example' })).toBeNull();
    expect(checkAppPermissionClaim({ ...claim, origin: 'https://twang.example/path' })).toBeNull();
    expect(checkAppPermissionClaim({ ...claim, origin: 'javascript:alert(1)' })).toBeNull();
    expect(checkAppPermissionClaim({ ...claim, name: '​' })).toBeNull();
    expect(checkAppPermissionClaim({ ...claim, name: 'n'.repeat(65) })).toBeNull();
    expect(checkAppPermissionClaim({ ...claim, reason: '' })).toBeNull();
    expect(checkAppPermissionClaim({ ...claim, reason: 'r'.repeat(201) })).toBeNull();
    expect(checkAppPermissionClaim({ ...claim, extra: 1 })).toBeNull();
    expect(checkAppPermissionClaim({ ...claim, name: 5 })).toBeNull();
    expect(checkAppPermissionClaim(null)).toBeNull();
  });
});

describe('appPermissionAskDetails (guardian card input)', () => {
  const claim = { permission: 'online-play' as const, name: 'Twang Thang', origin: 'https://twang.example', reason: 'To play online.' };
  function ask(over: Partial<ChildSignAsk> = {}): ChildSignAsk {
    return {
      v: 1, id: '1'.repeat(32), dependantId: 'd'.repeat(64), persona: PERSONA, scope: 'app-permission', kind: 30420,
      method: 'sign_event', target: 'site:https://twang.example', targetLabel: 'Twang Thang', createdAt: NOW, expiresAt: NOW + 600,
      template: { kind: 30420, pubkey: PERSONA, created_at: NOW, tags: tags(), content: '' },
      appPermission: claim, ...over,
    };
  }
  it('the validated details, hours after valid_from (no clock check)', () => {
    expect(appPermissionAskDetails(ask())).toEqual({
      ...claim, appId: 'twang-thang', installKey: INSTALL, validFrom: NOW, validUntil: NOW + 90 * 86400,
    });
  });
  it('null (generic card) without the claim, off scope, on a bad template, truncated tags, or a target off the origin', () => {
    expect(appPermissionAskDetails(ask({ appPermission: undefined }))).toBeNull();
    expect(appPermissionAskDetails(ask({ scope: null }))).toBeNull();
    expect(appPermissionAskDetails(ask({ template: { kind: 30420, pubkey: PERSONA, created_at: NOW, tags: tags({ role: 'admin' }), content: '' } }))).toBeNull();
    expect(appPermissionAskDetails(ask({ tagsTruncated: true }))).toBeNull();
    expect(appPermissionAskDetails(ask({ target: 'site:https://other.example' }))).toBeNull();
    expect(appPermissionAskDetails(ask({ method: 'nip44_encrypt' }))).toBeNull();
  });
});

describe('answer rumors (D8)', () => {
  const sk = generateSecretKey();
  const persona = getPublicKey(sk);
  const signed = finalizeEvent({ kind: APP_PERMISSION_KIND, created_at: NOW, tags: tags(), content: '' }, sk) as unknown as NostrEvent;
  it('approved: kind 29999 by the persona, session + approved tags, the signed event in content', () => {
    const r = buildAppPermissionApprovedRumor({ persona, challenge: CHALLENGE, permission: 'online-play', event: signed, nowS: NOW });
    expect(r).toEqual({
      kind: 29999, pubkey: persona, created_at: NOW, tags: [['session', CHALLENGE], ['status', 'approved']],
      content: JSON.stringify({ type: APP_PERMISSION_RESPONSE_TYPE, permission: 'online-play', challenge: CHALLENGE, event: signed }),
    });
  });
  it('denied: rejected status, denied:true, no event, signed by whoever is given (a throwaway key)', () => {
    const throwaway = bytesToHex(generateSecretKey());
    const pub = getPublicKey(Buffer.from(throwaway, 'hex'));
    const r = buildAppPermissionDeniedRumor({ pubkey: pub, challenge: CHALLENGE, permission: 'online-play', nowS: NOW });
    expect(r).toEqual({
      kind: 29999, pubkey: pub, created_at: NOW, tags: [['session', CHALLENGE], ['status', 'rejected']],
      content: JSON.stringify({ type: APP_PERMISSION_RESPONSE_TYPE, permission: 'online-play', challenge: CHALLENGE, denied: true }),
    });
  });
});
