// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { nip19 } from 'nostr-tools';
import { loadNip55Grants, parseNip55Request, parsePermissions, planNip55, pubkeyHexFrom, saveNip55Grants, type NativeNip55Request } from './nip55';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function raw(over: Partial<NativeNip55Request>): NativeNip55Request {
  return { id: 'r1', callerPackage: 'dev.forgesworn.kithmoot', type: 'sign_event', payload: null, peerPubkey: null, currentUser: null, permissions: null, viaProvider: false, ...over };
}

describe('parseNip55Request', () => {
  it('reads a sign_event template and fills created_at', () => {
    const parsed = parseNip55Request(raw({ payload: JSON.stringify({ kind: 20460, content: '', tags: [['d', 'room']] }) }))!;
    expect(parsed.method).toBe('sign_event');
    expect(parsed.template!.kind).toBe(20460);
    expect(parsed.template!.tags).toEqual([['d', 'room']]);
    expect(typeof parsed.template!.created_at).toBe('number');
  });

  it('rejects a template that is not an event', () => {
    expect(parseNip55Request(raw({ payload: 'not json' }))).toBeNull();
    expect(parseNip55Request(raw({ payload: JSON.stringify({ content: 'no kind' }) }))).toBeNull();
    expect(parseNip55Request(raw({ payload: JSON.stringify({ kind: 1, content: 1 }) }))).toBeNull();
    expect(parseNip55Request(raw({ payload: JSON.stringify({ kind: 1, content: '', tags: [[1]] }) }))).toBeNull();
    expect(parseNip55Request(raw({ payload: null }))).toBeNull();
  });

  it('takes current_user as npub or hex, and refuses garbage there', () => {
    expect(parseNip55Request(raw({ type: 'get_public_key', currentUser: nip19.npubEncode(A) }))!.currentUser).toBe(A);
    expect(parseNip55Request(raw({ type: 'get_public_key', currentUser: A.toUpperCase() }))!.currentUser).toBe(A);
    expect(parseNip55Request(raw({ type: 'get_public_key', currentUser: 'nope' }))).toBeNull();
  });

  it('needs a peer and a payload for the crypto methods', () => {
    expect(parseNip55Request(raw({ type: 'nip44_encrypt', peerPubkey: B, payload: 'hello' }))).toMatchObject({ method: 'nip44_encrypt', peer: B, payload: 'hello' });
    expect(parseNip55Request(raw({ type: 'nip44_decrypt', peerPubkey: null, payload: 'x' }))).toBeNull();
    expect(parseNip55Request(raw({ type: 'nip44_decrypt', peerPubkey: B, payload: '' }))).toBeNull();
    expect(parseNip55Request(raw({ type: 'nip04_encrypt', peerPubkey: B, payload: 'x' }))).toBeNull();
  });

  it('reads the permissions list for display and shrugs at a bad one', () => {
    expect(parsePermissions(JSON.stringify([{ type: 'sign_event', kind: 20460 }, { type: 'nip44_encrypt' }, { nope: 1 }]))).toEqual(['sign_event:20460', 'nip44_encrypt']);
    expect(parsePermissions('{')).toEqual([]);
    expect(pubkeyHexFrom(null)).toBeNull();
  });
});

describe('planNip55', () => {
  const signIt = parseNip55Request(raw({ payload: JSON.stringify({ kind: 1, content: 'hi' }) }))!;
  const whoAmI = parseNip55Request(raw({ type: 'get_public_key' }))!;

  it('rejects malformed and refused callers on either path', () => {
    expect(planNip55(null, false, undefined, [A], A)).toEqual({ kind: 'reject', reason: 'malformed' });
    expect(planNip55(signIt, true, { pubkey: A, allowAlways: true, denyAlways: true, grantedAt: 0 }, [A], A)).toEqual({ kind: 'reject', reason: 'denied' });
  });

  it('asks by intent and defers by provider when nothing is remembered', () => {
    expect(planNip55(signIt, false, undefined, [A], A)).toEqual({ kind: 'ask', pubkey: A });
    expect(planNip55(signIt, true, undefined, [A], A)).toEqual({ kind: 'defer' });
  });

  it('forwards silently only for the remembered key', () => {
    const grant = { pubkey: A, allowAlways: true, denyAlways: false, grantedAt: 1 };
    expect(planNip55(signIt, true, grant, [A, B], A)).toEqual({ kind: 'forward', pubkey: A });
    const namedOther = { ...signIt, currentUser: B };
    expect(planNip55(namedOther, true, grant, [A, B], A)).toEqual({ kind: 'defer' });
    expect(planNip55(namedOther, false, grant, [A, B], A)).toEqual({ kind: 'ask', pubkey: B });
  });

  it('never signs under a key this phone does not hold', () => {
    expect(planNip55({ ...signIt, currentUser: 'c'.repeat(64) }, false, undefined, [A, B], A)).toEqual({ kind: 'reject', reason: 'unknown-identity' });
  });

  it('with several keys and nothing named, offers the active one and lets the person choose', () => {
    expect(planNip55(whoAmI, false, undefined, [A, B], B)).toEqual({ kind: 'ask', pubkey: B });
    expect(planNip55(whoAmI, false, undefined, [A, B], null)).toEqual({ kind: 'ask', pubkey: null });
  });

  it('with no key available, the provider defers and the intent is refused', () => {
    expect(planNip55(signIt, true, undefined, [], null)).toEqual({ kind: 'defer' });
    expect(planNip55(signIt, false, undefined, [], null)).toEqual({ kind: 'reject', reason: 'no-identity' });
  });
});

describe('grants', () => {
  beforeEach(() => localStorage.clear());

  it('round trip, dropping anything that is not a key', () => {
    saveNip55Grants({ 'app.one': { pubkey: A, allowAlways: true, denyAlways: false, grantedAt: 5 } });
    expect(loadNip55Grants()).toEqual({ 'app.one': { pubkey: A, allowAlways: true, denyAlways: false, grantedAt: 5 } });
    localStorage.setItem('signet.nip55.grants', JSON.stringify({ bad: { pubkey: 'zz' }, ok: { pubkey: B } }));
    expect(loadNip55Grants()).toEqual({ ok: { pubkey: B, allowAlways: false, denyAlways: false, grantedAt: 0 } });
    saveNip55Grants({});
  });

  it("keeps the app's name when it was recorded, and trims it", () => {
    saveNip55Grants({ 'app.one': { pubkey: A, allowAlways: true, denyAlways: false, grantedAt: 5, label: '  Amethyst  ' } });
    expect(loadNip55Grants()['app.one'].label).toBe('Amethyst');
    saveNip55Grants({ 'app.one': { pubkey: A, allowAlways: true, denyAlways: false, grantedAt: 5 } });
    expect(loadNip55Grants()['app.one'].label).toBeUndefined();
    saveNip55Grants({});
    expect(localStorage.getItem('signet.nip55.grants')).toBeNull();
  });
});
