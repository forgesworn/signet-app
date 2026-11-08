// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { nip19 } from 'nostr-tools';
import { defaultNip55Pubkey, describeNip55, loadNip55Grants, parseNip55Request, parsePermissions, planNip55, pubkeyHexFrom, saveNip55Grants, type NativeNip55Request } from './nip55';

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

  describe('nip04_decrypt', () => {
    const CIPHER = 'AqWa+b/cd==?iv=Zm9vYmFyYmF6cXV4MTIzNA==';

    it('reads a peer and a NIP-04 ciphertext, hex or npub, any case of method', () => {
      expect(parseNip55Request(raw({ type: 'nip04_decrypt', peerPubkey: B, payload: CIPHER }))).toMatchObject({ method: 'nip04_decrypt', peer: B, payload: CIPHER, permissions: [] });
      expect(parseNip55Request(raw({ type: 'NIP04_DECRYPT', peerPubkey: nip19.npubEncode(B), payload: ` ${CIPHER}\n` }))).toMatchObject({ method: 'nip04_decrypt', peer: B, payload: CIPHER });
      expect(parseNip55Request(raw({ type: 'nip04_decrypt', peerPubkey: B, payload: CIPHER, currentUser: A }))!.currentUser).toBe(A);
    });

    it('needs a peer and a payload, like the other crypto methods', () => {
      expect(parseNip55Request(raw({ type: 'nip04_decrypt', peerPubkey: null, payload: CIPHER }))).toBeNull();
      expect(parseNip55Request(raw({ type: 'nip04_decrypt', peerPubkey: 'nope', payload: CIPHER }))).toBeNull();
      expect(parseNip55Request(raw({ type: 'nip04_decrypt', peerPubkey: B, payload: '' }))).toBeNull();
      expect(parseNip55Request(raw({ type: 'nip04_decrypt', peerPubkey: B, payload: null }))).toBeNull();
    });

    it('refuses what is not NIP-04 content, so it never reaches a screen', () => {
      expect(parseNip55Request(raw({ type: 'nip04_decrypt', peerPubkey: B, payload: 'AqWa+b/cd==' }))).toBeNull(); // no iv
      expect(parseNip55Request(raw({ type: 'nip04_decrypt', peerPubkey: B, payload: '?iv=Zm9v' }))).toBeNull(); // no ciphertext
      expect(parseNip55Request(raw({ type: 'nip04_decrypt', peerPubkey: B, payload: 'AqWa?iv=' }))).toBeNull(); // empty iv
      expect(parseNip55Request(raw({ type: 'nip04_decrypt', peerPubkey: B, payload: 'AqWa?iv=Zm9v?iv=Zm9v' }))).toBeNull(); // two ivs
      expect(parseNip55Request(raw({ type: 'nip04_decrypt', peerPubkey: B, payload: 'not base64!?iv=Zm9v' }))).toBeNull();
      expect(parseNip55Request(raw({ type: 'nip04_decrypt', peerPubkey: B, payload: '{"kind":1}' }))).toBeNull();
    });

    it('is bounded like every other payload', () => {
      const huge = `${'A'.repeat(256 * 1024)}?iv=Zm9v`;
      expect(parseNip55Request(raw({ type: 'nip04_decrypt', peerPubkey: B, payload: huge }))).toBeNull();
    });

    it('nip04_encrypt is still refused, whatever it carries', () => {
      expect(parseNip55Request(raw({ type: 'nip04_encrypt', peerPubkey: B, payload: 'hello' }))).toBeNull();
      expect(parseNip55Request(raw({ type: 'nip04_encrypt', peerPubkey: B, payload: CIPHER }))).toBeNull();
      expect(parseNip55Request(raw({ type: 'NIP04_ENCRYPT', peerPubkey: B, payload: 'hello', viaProvider: true }))).toBeNull();
      expect(parseNip55Request(raw({ type: 'decrypt_zap_event', peerPubkey: B, payload: CIPHER }))).toBeNull();
    });
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

  it('M6: a remembered grant never signs an app permission (kind 30420): always asked', () => {
    const grant = { pubkey: A, allowAlways: true, denyAlways: false, grantedAt: 1 };
    const permission = parseNip55Request(raw({ payload: JSON.stringify({ kind: 30420, content: '', tags: [['d', 'twang']] }) }))!;
    expect(permission).not.toBeNull();
    expect(planNip55(permission, false, grant, [A], A)).toEqual({ kind: 'ask', pubkey: A });
    expect(planNip55(permission, true, grant, [A], A)).toEqual({ kind: 'defer' });
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

  describe('nip04_decrypt is planned exactly as nip44_decrypt is', () => {
    const CIPHER = 'AqWa+b/cd==?iv=Zm9vYmFyYmF6cXV4MTIzNA==';
    const old = parseNip55Request(raw({ type: 'nip04_decrypt', peerPubkey: B, payload: CIPHER }))!;
    const current = parseNip55Request(raw({ type: 'nip44_decrypt', peerPubkey: B, payload: 'AqWa' }))!;
    const grant = { pubkey: A, allowAlways: true, denyAlways: false, grantedAt: 1 };
    const cases: Array<[string, boolean, Parameters<typeof planNip55>[2], string[], string | null]> = [
      ['intent, nothing remembered', false, undefined, [A], A],
      ['provider, nothing remembered', true, undefined, [A], A],
      ['provider, allowed always', true, grant, [A, B], A],
      ['intent, allowed always', false, grant, [A, B], A],
      ['refused for good', true, { ...grant, denyAlways: true }, [A], A],
      ['no keys, provider', true, undefined, [], null],
      ['no keys, intent', false, undefined, [], null],
      ['several keys, none active', false, undefined, [A, B], null],
    ];
    it.each(cases)('%s', (_name, viaProvider, g, owned, active) => {
      expect(planNip55(old, viaProvider, g, owned, active)).toEqual(planNip55(current, viaProvider, g, owned, active));
    });

    it('the key it names must be one this phone holds; a dormant real identity has no route, so it is unknown', () => {
      const dormant = 'd'.repeat(64);
      expect(planNip55({ ...old, currentUser: dormant }, false, undefined, [A, B], A)).toEqual({ kind: 'reject', reason: 'unknown-identity' });
      expect(planNip55({ ...old, currentUser: dormant }, true, grant, [A, B], A)).toEqual({ kind: 'reject', reason: 'unknown-identity' });
      expect(planNip55({ ...old, currentUser: B }, false, undefined, [A, B], A)).toEqual({ kind: 'ask', pubkey: B });
    });
  });
});

describe('describeNip55', () => {
  const never = () => { throw new Error('no template'); };

  it('says what each method asks for', () => {
    expect(describeNip55({ method: 'get_public_key', permissions: [] }, never)).toBe('know which key you are');
    expect(describeNip55({ method: 'nip44_encrypt', permissions: [] }, never)).toBe('encrypt a message to someone');
    expect(describeNip55({ method: 'nip44_decrypt', permissions: [] }, never)).toBe('read a message sent to you');
  });

  it('nip04_decrypt says the message is in an older format and that it is read', () => {
    expect(describeNip55({ method: 'nip04_decrypt', permissions: [] }, never)).toBe('read an older-format message sent to you');
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

describe('defaultNip55Pubkey', () => {
  const C = 'c'.repeat(64);
  const grant = (pubkey: string) => ({ pubkey, allowAlways: false, denyAlways: false, grantedAt: 0 });

  it('prefers the remembered key when it is owned, and ignores one that is not', () => {
    expect(defaultNip55Pubkey([A, B], grant(B), A)).toBe(B);
    expect(defaultNip55Pubkey([A, B], grant(C), A)).toBe(A);
  });

  it('takes the active key only when it is owned, else the first owned', () => {
    expect(defaultNip55Pubkey([A, B], undefined, B)).toBe(B);
    expect(defaultNip55Pubkey([B, A], undefined, C)).toBe(B);
    expect(defaultNip55Pubkey([B, A], undefined, null)).toBe(B);
  });

  it('returns the only owned key, lowercase, and null when nothing is owned', () => {
    expect(defaultNip55Pubkey([A.toUpperCase()], undefined, C)).toBe(A);
    expect(defaultNip55Pubkey([A, B], undefined, B.toUpperCase())).toBe(B);
    expect(defaultNip55Pubkey([], grant(A), A)).toBeNull();
  });
});
