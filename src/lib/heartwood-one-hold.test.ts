import { describe, it, expect, vi } from 'vitest';
import { WORDLIST } from 'spoken-token';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  pairWordsForClient, cardLines, buildBundleParam, parseBundleReply, classifyBundleError,
  runApproveBundle, parseOwnerStatus, fetchOwnerStatus, narrowToCareful, supportsApproveBundle,
  addChildPressPreview, negotiateFullAccess, cardLabelLine, CARD_LABEL_PLACEHOLDER, separatelyHint, separateCardCount, ownerOfferState, addChildRaisesCards, type FullAccessOffer, BUNDLE_TIMEOUT_MS, CARD_REQUEST_TIMEOUT_MS, OWNER_QUICK_TIMEOUT_MS, PAIRING_PROBLEM_COPY, FULL_ACCESS_COPY, DEVICE_LIMIT_COPY,
} from './heartwood-one-hold';
import { BunkerRequestTimeoutError, SIGNER_REQUEST_TIMEOUT_MS } from './signing-backend';

const NP = 'a'.repeat(64);
const PERSONA = 'b'.repeat(64);
const MASTER = 'c'.repeat(64);
// secp256k1 generator x-coordinate, the firmware-side test vector's client key.
const VECTOR_CLIENT = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

describe('pairWordsForClient', () => {
  it('matches an independent computation of the 4.2 formula for the vector key', () => {
    const prefix = new Uint8Array([...new TextEncoder().encode('heartwood-pair-words'), 0]);
    const key = hexToBytes(VECTOR_CLIENT);
    const msg = new Uint8Array(prefix.length + 32);
    msg.set(prefix); msg.set(key, prefix.length);
    const d = sha256(msg);
    const expected = [0, 1, 2].map(i => WORDLIST[((d[2 * i] << 8) | d[2 * i + 1]) % 2048]);
    expect(pairWordsForClient(VECTOR_CLIENT)).toEqual(expected);
  });

  it('pins the three words for the vector key', () => {
    // Pinned from this implementation; compare against the firmware's own vector when it lands.
    expect(pairWordsForClient(VECTOR_CLIENT)).toEqual(PINNED_WORDS);
  });

  it('is case-insensitive, deterministic and differs per key', () => {
    expect(pairWordsForClient(VECTOR_CLIENT.toUpperCase())).toEqual(pairWordsForClient(VECTOR_CLIENT));
    expect(pairWordsForClient('1'.repeat(64))).not.toEqual(pairWordsForClient(VECTOR_CLIENT));
  });

  it('every word is in the en-v1 list and is at most 8 letters', () => {
    for (const w of pairWordsForClient(VECTOR_CLIENT)) {
      expect(WORDLIST).toContain(w);
      expect(w.length).toBeLessThanOrEqual(8);
    }
  });

  it('rejects a malformed key', () => {
    expect(() => pairWordsForClient('abc')).toThrow();
  });
});

const PINNED_WORDS: [string, string, string] = ['nice', 'never', 'repair'];

describe('cardLines', () => {
  const words: [string, string, string] = ['one', 'two', 'three'];
  it('everyday, persona only', () => {
    expect(cardLines({ words, label: 'my signet', realName: false, style: 'everyday' })).toEqual({
      header: 'FULL ACCESS', label: 'my signet', labelKnown: true, wordsLine1: 'one two', wordsLine2: 'three',
      scope: 'PERSONA ONLY', powers: ['SIGN IN, POST, BACKUP'], hold: 'HOLD 5 SECONDS',
    });
  });
  it('extra careful with the real name', () => {
    const c = cardLines({ words, realName: true, style: 'careful' });
    expect(c.scope).toBe('PERSONA + REAL NAME');
    expect(c.powers).toEqual(['SIGNS ALONE: BACKUPS', 'ASKS: EVERYTHING ELSE']);
    // No label known here (onboarding): a placeholder keeps the Heartwood's line count.
    expect(c.label).toBe(CARD_LABEL_PLACEHOLDER);
    expect(c.labelKnown).toBe(false);
  });
  it('draws the label the way the firmware does (m4): as typed, ? for non-ASCII, .. when cut', () => {
    expect(cardLabelLine('My Signet')).toBe('My Signet');
    expect(cardLabelLine('Café phone')).toBe('Caf? phone');
    expect(cardLabelLine('a'.repeat(21))).toBe('a'.repeat(21));
    expect(cardLabelLine('a'.repeat(30))).toBe(`${'a'.repeat(19)}..`);
    expect(cardLabelLine('abcdefgh', 3)).toBe('a..');
    expect(cardLabelLine('abcdefgh', 1)).toBe('a..');
  });
});

describe('separatelyHint (M3)', () => {
  it('states the real count, not "a few"', () => {
    expect(separateCardCount(5)).toBe(19);
    const hint = separatelyHint();
    expect(hint).toContain('about 19 times');
    expect(hint).toContain('your 5 backups');
    expect(hint).not.toMatch(/a few times/);
  });
  it('follows the number of backups', () => {
    expect(separateCardCount(7)).toBe(25);
    expect(separatelyHint(7)).toContain('about 25 times');
  });
});

describe('buildBundleParam', () => {
  it('create:true, persona only, everyday', () => {
    expect(JSON.parse(buildBundleParam({ create: true, actAsNaturalPerson: false, style: 'everyday' }))).toEqual({
      v: 1, personas: ['natural-person', 'persona'], act_as: ['persona'], create: true, style: 'everyday',
    });
  });
  it('act_as includes the real identity only when asked', () => {
    const p = JSON.parse(buildBundleParam({ create: true, actAsNaturalPerson: true, style: 'careful' }));
    expect(p.act_as).toEqual(['natural-person', 'persona']);
    expect(p.style).toBe('careful');
  });
  it('create:false carries expect, lowercased', () => {
    const p = JSON.parse(buildBundleParam({
      create: false, actAsNaturalPerson: false, style: 'everyday',
      expect: { naturalPerson: NP.toUpperCase(), persona: PERSONA },
    }));
    expect(p.create).toBe(false);
    expect(p.expect).toEqual({ 'natural-person': NP, persona: PERSONA });
  });
});

describe('parseBundleReply', () => {
  const ctx = { masterPubkey: MASTER, requestedStyle: 'everyday' as const };
  it('accepts the pinned 4.1 shape', () => {
    const raw = JSON.stringify({ v: 1, pubkeys: { 'natural-person': NP, persona: PERSONA }, act_as: ['persona'], owner: true, style: 'careful' });
    expect(parseBundleReply(raw, ctx)).toEqual({ naturalPerson: NP, persona: PERSONA, actAs: ['persona'], style: 'careful' });
  });
  it('rejects the retired personas-array shape', () => {
    const raw = JSON.stringify({ v: 1, personas: [
      { name: 'natural-person', pubkey: NP, index: 0 }, { name: 'persona', pubkey: PERSONA, index: 0 }] });
    expect(parseBundleReply(raw, ctx)).toBeNull();
  });
  it.each([
    ['master as persona', { 'natural-person': NP, persona: MASTER }],
    ['master as real identity', { 'natural-person': MASTER, persona: PERSONA }],
    ['same key twice', { 'natural-person': NP, persona: NP }],
    ['uppercase hex', { 'natural-person': NP.toUpperCase(), persona: PERSONA }],
    ['short key', { 'natural-person': 'ab', persona: PERSONA }],
    ['missing persona', { 'natural-person': NP }],
  ])('rejects %s', (_n, pubkeys) => {
    expect(parseBundleReply(JSON.stringify({ v: 1, pubkeys, owner: true }), ctx)).toBeNull();
  });
  it('rejects owner:false, junk and a create:false reply that differs from expect', () => {
    expect(parseBundleReply(JSON.stringify({ v: 1, pubkeys: { 'natural-person': NP, persona: PERSONA }, owner: false }), ctx)).toBeNull();
    expect(parseBundleReply('nope', ctx)).toBeNull();
    expect(parseBundleReply('[]', ctx)).toBeNull();
    // m10: the firmware always sends owner:true, so a reply without it is not a success.
    expect(parseBundleReply(JSON.stringify({ v: 1, pubkeys: { 'natural-person': NP, persona: PERSONA } }), ctx)).toBeNull();
    const raw = JSON.stringify({ v: 1, pubkeys: { 'natural-person': NP, persona: PERSONA }, owner: true });
    expect(parseBundleReply(raw, { ...ctx, expect: { persona: 'd'.repeat(64) } })).toBeNull();
    expect(parseBundleReply(raw, { ...ctx, expect: { persona: PERSONA, naturalPerson: NP } })).not.toBeNull();
  });
});

describe('classifyBundleError', () => {
  it.each([
    ['unauthorised', 'continue', PAIRING_PROBLEM_COPY.strict],
    ['unauthorised: pairing has a kinds list', 'continue', PAIRING_PROBLEM_COPY.everything],
    ['unauthorised: pairing asks for every request', 'continue', PAIRING_PROBLEM_COPY.everything],
    ['unauthorised: pairing shared by another device', 'continue', PAIRING_PROBLEM_COPY.shared],
    // M1: the firmware's real text (heartwood-esp32 common/src/escalate.rs DEVICE_APPROVAL_REQUIRED).
    ['this request must be approved at the device; a guardian verdict cannot answer it', 'continue', PAIRING_PROBLEM_COPY.phoneMayOk],
    ['DEVICE_APPROVAL_REQUIRED', 'continue', PAIRING_PROBLEM_COPY.phoneMayOk],
    // M4: transient refusals say Try again, never fall silently into today's flow.
    ['signer is busy with another approval; retry shortly', 'retry', FULL_ACCESS_COPY.busy],
    ['approval changed while waiting; send the request again', 'retry', FULL_ACCESS_COPY.changed],
    ['approval_changed: pairing or permissions changed; send the request again', 'retry', FULL_ACCESS_COPY.changed],
    ['identity approved; send the request again', 'retry', FULL_ACCESS_COPY.changed],
    ['storage full', 'continue', DEVICE_LIMIT_COPY.storageFull],
    ['no persona tree on this master', 'continue', DEVICE_LIMIT_COPY.noPersonaTree],
    ['method list full', 'continue', DEVICE_LIMIT_COPY.methodListFull],
    ['approval list full', 'silent', ''],
    ['pubkey mismatch', 'mismatch', FULL_ACCESS_COPY.pairingMismatch],
    ['persona missing', 'mismatch', FULL_ACCESS_COPY.personaMissing],
    ['malformed bundle', 'silent', ''],
    ['bundle names a child', 'silent', ''],
    ['user denied', 'retry', FULL_ACCESS_COPY.declined],
    ['timeout', 'retry', FULL_ACCESS_COPY.declined],
    ['something unforeseen', 'silent', ''],
  ])('%s', (err, action, message) => {
    expect(classifyBundleError(err)).toMatchObject({ action, message });
  });
  it('our own expiry and a transport failure', () => {
    // m3: our own expiry is "no answer", which does not claim nothing changed.
    expect(classifyBundleError(new BunkerRequestTimeoutError('heartwood_approve_bundle')))
      .toMatchObject({ action: 'retry', code: 'no-answer', message: FULL_ACCESS_COPY.noAnswer });
    expect(FULL_ACCESS_COPY.noAnswer).not.toMatch(/Nothing changed/);
    expect(classifyBundleError(new Error('publish failed')))
      .toMatchObject({ action: 'retry', message: FULL_ACCESS_COPY.unreachable });
  });
});

describe('runApproveBundle', () => {
  const okReply = JSON.stringify({ v: 1, pubkeys: { 'natural-person': NP, persona: PERSONA }, act_as: ['persona'], owner: true, style: 'everyday' });
  it('sends exactly one request with the 140 s timeout and returns the reply', async () => {
    const request = vi.fn().mockResolvedValue(okReply);
    const out = await runApproveBundle(request, { create: true, actAsNaturalPerson: false, style: 'everyday', masterPubkey: MASTER });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('heartwood_approve_bundle');
    expect(request.mock.calls[0][2]).toBe(BUNDLE_TIMEOUT_MS);
    expect(out).toMatchObject({ ok: true, reply: { persona: PERSONA } });
  });
  it('a refusal comes back as a failure, not a throw, and is not retried', async () => {
    const request = vi.fn().mockRejectedValue('unauthorised');
    const out = await runApproveBundle(request, { create: true, actAsNaturalPerson: false, style: 'everyday', masterPubkey: MASTER });
    expect(out).toMatchObject({ ok: false, failure: { code: 'strict' } });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('an unusable reply is a silent failure', async () => {
    const request = vi.fn().mockResolvedValue('{"v":1}');
    const out = await runApproveBundle(request, { create: true, actAsNaturalPerson: false, style: 'everyday', masterPubkey: MASTER });
    expect(out).toMatchObject({ ok: false, failure: { code: 'bad-reply' } });
  });
});

describe('owner status and narrow', () => {
  it('parses status and defaults the style', () => {
    expect(parseOwnerStatus('{"owner":true,"style":"careful"}')).toEqual({ owner: true, style: 'careful' });
    expect(parseOwnerStatus('{"owner":false}')).toEqual({ owner: false, style: 'everyday' });
    expect(parseOwnerStatus('{"owner":"yes"}')).toBeNull();
    expect(parseOwnerStatus('x')).toBeNull();
  });
  it('fetchOwnerStatus turns any failure into null (unknown, not off)', async () => {
    expect(await fetchOwnerStatus(vi.fn().mockRejectedValue(new Error('x')))).toBeNull();
    expect(await fetchOwnerStatus(vi.fn().mockResolvedValue('{"owner":true,"style":"everyday"}'))).toEqual({ owner: true, style: 'everyday' });
  });
  it('narrow sends the careful style only', async () => {
    const request = vi.fn().mockResolvedValue('{"style":"careful","changed":true}');
    expect(await narrowToCareful(request)).toEqual({ ok: true, changed: true });
    expect(request.mock.calls[0][0]).toBe('heartwood_owner_narrow');
    expect(JSON.parse(request.mock.calls[0][1][0])).toEqual({ v: 1, style: 'careful' });
  });
  it('narrow on an unmarked pairing says so', async () => {
    const out = await narrowToCareful(vi.fn().mockRejectedValue('unauthorised'));
    expect(out.ok).toBe(false);
  });
});

describe('capability gate and press preview', () => {
  it('only a list naming the bundle method counts', () => {
    expect(supportsApproveBundle(['sign_event', 'heartwood_approve_bundle'])).toBe(true);
    expect(supportsApproveBundle(['sign_event'])).toBe(false);
    expect(supportsApproveBundle(null)).toBe(false);
  });
  it('names the child in the two-press line when this phone has full access', () => {
    expect(addChildPressPreview(' Sam ', true)).toBe('Your Heartwood will ask twice: first for Sam\'s real-name key, then for Sam\'s persona key.');
  });
  it('does not promise "twice" without the mark (m1)', () => {
    const line = addChildPressPreview('Sam', false);
    expect(line).toContain('more than twice');
    expect(line).not.toContain('ask twice');
  });
});

describe('negotiateFullAccess (A1)', () => {
  const okReply = JSON.stringify({ v: 1, pubkeys: { 'natural-person': NP, persona: PERSONA }, owner: true, style: 'everyday' });
  const base = { clientPubkeyHex: VECTOR_CLIENT, masterPubkey: MASTER };

  it('asks nothing and sends nothing without a UI', async () => {
    const request = vi.fn();
    const probe = vi.fn().mockResolvedValue(['heartwood_approve_bundle']);
    const out = await negotiateFullAccess({ ...base, ui: undefined, probe, request });
    expect(out).toEqual({ mode: 'separate' });
    expect(probe).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['firmware without the method', ['sign_event', 'heartwood_derive_persona']],
    ['no answer to the probe', null],
  ])('%s: today\'s flow, UI never shown', async (_n, methods) => {
    const ui = { chooseFullAccess: vi.fn() };
    const request = vi.fn();
    const out = await negotiateFullAccess({ ...base, ui, probe: async () => methods, request });
    expect(out).toEqual({ mode: 'separate' });
    expect(ui.chooseFullAccess).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('a probe that throws is treated as no capability', async () => {
    const ui = { chooseFullAccess: vi.fn() };
    const out = await negotiateFullAccess({ ...base, ui, probe: () => Promise.reject(new Error('x')), request: vi.fn() });
    expect(out).toEqual({ mode: 'separate' });
  });

  it('offers the words and sends NO bundle until the screen runs it', async () => {
    const request = vi.fn().mockResolvedValue(okReply);
    const ui = { chooseFullAccess: vi.fn().mockResolvedValue({ mode: 'separate' }) };
    const out = await negotiateFullAccess({ ...base, ui, probe: async () => ['heartwood_approve_bundle'], request });
    expect(out).toEqual({ mode: 'separate' });
    expect(ui.chooseFullAccess).toHaveBeenCalledTimes(1);
    expect(ui.chooseFullAccess.mock.calls[0][0].words).toEqual(pairWordsForClient(VECTOR_CLIENT));
    expect(request).not.toHaveBeenCalled();
  });

  it('the screen\'s tap runs one create:true bundle for the persona only', async () => {
    const request = vi.fn().mockResolvedValue(okReply);
    const ui = {
      chooseFullAccess: vi.fn(async (offer: FullAccessOffer) => {
        const r = await offer.run('careful');
        return r.ok ? { mode: 'bundle' as const, reply: r.reply, style: 'careful' as const } : { mode: 'separate' as const };
      }),
    };
    const out = await negotiateFullAccess({ ...base, ui, probe: async () => ['heartwood_approve_bundle'], request });
    expect(out).toMatchObject({ mode: 'bundle', reply: { naturalPerson: NP, persona: PERSONA } });
    expect(request).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(request.mock.calls[0][1][0]);
    expect(sent).toMatchObject({ create: true, act_as: ['persona'], style: 'careful', personas: ['natural-person', 'persona'] });
  });
});

describe('A7 timeouts', () => {
  it('anything that may raise a card waits at least 45 s; the bundle waits 140 s', () => {
    expect(CARD_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000);
    expect(SIGNER_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000);
    expect(BUNDLE_TIMEOUT_MS).toBe(140_000);
  });
  it('status and narrow never raise a card, so a short wait is fine', () => {
    expect(OWNER_QUICK_TIMEOUT_MS).toBeLessThan(CARD_REQUEST_TIMEOUT_MS);
  });
});

describe('ownerOfferState (A8, M2, m2)', () => {
  const base = {
    supported: true, everHadFullAccess: true, statusOwner: null as boolean | null,
    awaitingFirstStatus: false, vaultNeedsApproval: false, dismissed: false,
  };
  it('holds backups only while the first status answer is pending', () => {
    expect(ownerOfferState({ ...base, awaitingFirstStatus: true }).holdBackups).toBe(true);
  });
  it('M2: once owner:false is known the offer shows but backups run (a deliberate Forget approvals must not stall every start)', () => {
    const s = ownerOfferState({ ...base, statusOwner: false });
    expect(s).toEqual({ lost: true, offer: true, holdBackups: false });
  });
  it('never holds backups for an install that never ran the hold, or on old firmware', () => {
    expect(ownerOfferState({ ...base, everHadFullAccess: false, awaitingFirstStatus: true }).holdBackups).toBe(false);
    expect(ownerOfferState({ ...base, supported: false, awaitingFirstStatus: true, statusOwner: false })).toEqual({ lost: false, offer: false, holdBackups: false });
  });
  it('"Not now" ends the offer for the session', () => {
    expect(ownerOfferState({ ...base, statusOwner: false, dismissed: true }).offer).toBe(false);
  });
  it('m2: a refused backup offers the hold only when the mark is not known to be there', () => {
    expect(ownerOfferState({ ...base, vaultNeedsApproval: true, statusOwner: null }).offer).toBe(true);
    expect(ownerOfferState({ ...base, vaultNeedsApproval: true, statusOwner: false }).offer).toBe(true);
    expect(ownerOfferState({ ...base, vaultNeedsApproval: true, statusOwner: true }).offer).toBe(false);
  });
});

describe('addChildRaisesCards (m1, D4)', () => {
  it('shows the preview when keys are made on the device and nothing says otherwise', () => {
    expect(addChildRaisesCards({ deviceDerive: true, ownSlotMethods: null })).toBe(true);
    expect(addChildRaisesCards({ deviceDerive: true, ownSlotMethods: ['sign_event'] })).toBe(true);
  });
  it('shows nothing when the operator has listed derive on this pairing: no card comes up', () => {
    expect(addChildRaisesCards({ deviceDerive: true, ownSlotMethods: ['sign_event', 'heartwood_derive_persona'] })).toBe(false);
  });
  it('shows nothing when keys are not made on the device', () => {
    expect(addChildRaisesCards({ deviceDerive: false, ownSlotMethods: null })).toBe(false);
  });
});
