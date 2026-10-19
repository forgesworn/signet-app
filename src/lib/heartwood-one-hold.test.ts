import { describe, it, expect, vi } from 'vitest';
import { WORDLIST } from 'spoken-token';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  pairWordsForClient, cardLines, buildBundleParam, parseBundleReply, classifyBundleError,
  runApproveBundle, parseOwnerStatus, fetchOwnerStatus, narrowToCareful, supportsApproveBundle,
  addChildPressPreview, negotiateFullAccess, cardLabelLine, CARD_LABEL_PLACEHOLDER, separatelyHint, separateCardCount, ownerOfferState, addChildRaisesCards, realNameFirstUseAsks, wordPages, requestedActAs, type FullAccessOffer, BUNDLE_TIMEOUT_MS, CARD_REQUEST_TIMEOUT_MS, OWNER_QUICK_TIMEOUT_MS, PAIRING_PROBLEM_COPY, FULL_ACCESS_COPY, DEVICE_LIMIT_COPY,
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
    const expected = [0, 1, 2, 3, 4].map(i => WORDLIST[((d[2 * i] << 8) | d[2 * i + 1]) % 2048]);
    expect(pairWordsForClient(VECTOR_CLIENT)).toEqual(expected);
  });

  it('pins the five words for the vector key (W1): the first three are the old three', () => {
    // The same vector is pinned in heartwood-esp32 (common/src/owner_pairing.rs).
    expect(pairWordsForClient(VECTOR_CLIENT)).toEqual(PINNED_WORDS);
    expect(PINNED_WORDS.slice(0, 3)).toEqual(['nice', 'never', 'repair']);
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

const PINNED_WORDS = ['nice', 'never', 'repair', 'area', 'upgrade'];

describe('cardLines', () => {
  const words = ['one', 'two', 'three', 'four', 'five'];
  it('everyday, persona only', () => {
    expect(cardLines({ words, label: 'my signet', realName: false, style: 'everyday' })).toEqual({
      header: 'FULL ACCESS', label: 'my signet', labelKnown: true,
      wordPages: [{ label: '1-2 of 5', words: 'one two' }, { label: '3-4 of 5', words: 'three four' }, { label: '5 of 5', words: 'five' }],
      scope: 'PERSONA ONLY', powers: ['SIGN IN, POST, BACKUP'], hold: 'HOLD 5 SECONDS',
    });
  });
  it('extra careful with the real name', () => {
    const c = cardLines({ words, realName: true, style: 'careful' });
    expect(c.scope).toBe('PERSONA + REAL NAME');
    // W9: never claim less than what signs alone (backups, app data under a granted identity, relay logins).
    expect(c.powers).toEqual(['SIGNS ALONE: BACKUPS, APP DATA', 'ASKS: EVERYTHING ELSE']);
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

describe('wordPages (W2)', () => {
  it('pages five words two at a time, like the Heartwood', () => {
    expect(wordPages(['a', 'b', 'c', 'd', 'e'])).toEqual([
      { label: '1-2 of 5', words: 'a b' }, { label: '3-4 of 5', words: 'c d' }, { label: '5 of 5', words: 'e' },
    ]);
  });
});

describe('five-word copy (W2, W9, W10)', () => {
  it('no longer says the words appear while the button is held', () => {
    for (const text of [FULL_ACCESS_COPY.expect, FULL_ACCESS_COPY.holding]) {
      expect(text).not.toMatch(/while you hold|appear on/i);
      expect(text).toMatch(/five words, two at a time/);
      expect(text).toMatch(/hold its button for 5 seconds/);
      expect(text).toMatch(/If any word doesn't match, don't hold/);
    }
    expect(FULL_ACCESS_COPY.expect).toBe('Your Heartwood will show FULL ACCESS and five words, two at a time. Check every word matches the ones here. When they\'ve all shown, hold its button for 5 seconds. If any word doesn\'t match, don\'t hold.');
  });
  it('the Everyday line says the phone can sign anything and read messages', () => {
    expect(FULL_ACCESS_COPY.covers).toMatch(/sign anything and read your messages as your persona \(and your real name, if you use it\)/);
  });
  it('Extra careful says what really signs alone (W9)', () => {
    expect(FULL_ACCESS_COPY.careful.body).toBe('Backups, app data and relay logins happen on their own, and reading messages still works. Signing in to sites, posting and sending messages ask on your Heartwood, so they wait until you\'re home.');
  });
  it('Sapwood labels are the ones Sapwood shows (W10)', () => {
    expect(PAIRING_PROBLEM_COPY.phoneMayOk).toContain('Approve from my phone');
    expect(PAIRING_PROBLEM_COPY.phoneMayOk).not.toContain('Phone may OK');
    expect(FULL_ACCESS_COPY.sapwoodForget).toContain('Withdraw all for this client');
    expect(FULL_ACCESS_COPY.sapwoodForget).toMatch(/Edit or Remove/);
    expect(FULL_ACCESS_COPY.sapwoodForget).not.toContain('Forget approvals');
  });
  it('the onboarding no-answer line does not point to Settings', () => {
    expect(FULL_ACCESS_COPY.noAnswer).toContain('Settings, Advanced');
    expect(FULL_ACCESS_COPY.noAnswerOnboarding).not.toMatch(/Settings|Advanced/);
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
  const keys = { 'natural-person': NP, persona: PERSONA };
  const reply = (act_as: unknown) => JSON.stringify({ v: 1, pubkeys: keys, act_as, owner: true, style: 'everyday' });
  it('note 1: the act_as echo is checked against what was asked and kept', () => {
    const both = { ...ctx, requestedActAs: ['natural-person', 'persona'] };
    expect(parseBundleReply(reply(['natural-person', 'persona']), both)?.actAs).toEqual(['natural-person', 'persona']);
    // Narrower than asked is the truth about the grant: accepted, recorded as it is.
    expect(parseBundleReply(reply(['persona']), both)?.actAs).toEqual(['persona']);
    // Wider than asked, or a name nobody asked for, is not a success.
    expect(parseBundleReply(reply(['natural-person', 'persona']), { ...ctx, requestedActAs: ['persona'] })).toBeNull();
    expect(parseBundleReply(reply(['persona', 'dependant-1']), both)).toBeNull();
    // No persona, no list, or a list of junk: unusable.
    expect(parseBundleReply(reply(['natural-person']), both)).toBeNull();
    expect(parseBundleReply(reply(undefined), both)).toBeNull();
    expect(parseBundleReply(reply([1, 'persona']), both)).toBeNull();
  });
  it('requestedActAs matches what buildBundleParam sends (W6: only two names)', () => {
    for (const actAsNaturalPerson of [true, false]) {
      expect(requestedActAs({ actAsNaturalPerson })).toEqual(JSON.parse(buildBundleParam({ create: true, actAsNaturalPerson, style: 'everyday' })).act_as);
    }
  });
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
    const raw = JSON.stringify({ v: 1, pubkeys: { 'natural-person': NP, persona: PERSONA }, act_as: ['persona'], owner: true });
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
    // W3: one full-access card at a time. Both are retry, with a "try again in a minute" line.
    ['unauthorised: another full access request arrived', 'retry', FULL_ACCESS_COPY.anotherCard],
    ['unauthorised: full access card shown recently', 'retry', FULL_ACCESS_COPY.cardShownRecently],
    // The -4 save failures (nip46_handler.rs persist_bind_or_rollback).
    ['could not persist client policy; request was not applied', 'retry', FULL_ACCESS_COPY.saveFailed],
    ['user denied', 'retry', FULL_ACCESS_COPY.declined],
    ['timeout', 'retry', FULL_ACCESS_COPY.declined],
    ['something unforeseen', 'silent', ''],
  ])('%s', (err, action, message) => {
    expect(classifyBundleError(err)).toMatchObject({ action, message });
  });
  it('W3 codes, and the retry copy tells the owner to wait a minute', () => {
    expect(classifyBundleError('unauthorised: another full access request arrived').code).toBe('another-card');
    expect(classifyBundleError('unauthorised: full access card shown recently').code).toBe('card-recent');
    // The bare "unauthorised" is still a strict pairing.
    expect(classifyBundleError('unauthorised').code).toBe('strict');
    for (const text of [FULL_ACCESS_COPY.declined, FULL_ACCESS_COPY.anotherCard, FULL_ACCESS_COPY.cardShownRecently]) {
      expect(text).toMatch(/try again in a minute/i);
    }
  });
  it('note 3: a failed save says so and says nothing changed; the fatal one does not', () => {
    expect(classifyBundleError('could not persist client policy; request was not applied'))
      .toMatchObject({ action: 'retry', code: 'save-failed', message: 'Your Heartwood couldn\'t save that. Nothing changed.' });
    const fatal = classifyBundleError('fatal storage error: could not restore prior client policy; take the device offline for USB recovery');
    expect(fatal.code).toBe('save-failed');
    expect(fatal.message).not.toMatch(/Nothing changed/);
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
  it('create:false with a missing or empty key sends nothing and says why (m9)', async () => {
    const base = { create: false, actAsNaturalPerson: false, style: 'everyday' as const, masterPubkey: MASTER };
    for (const keys of [
      undefined,
      { naturalPerson: '', persona: PERSONA },
      { naturalPerson: NP, persona: '' },
      { naturalPerson: NP },
      { naturalPerson: 'nothex', persona: PERSONA },
    ]) {
      const request = vi.fn().mockResolvedValue(okReply);
      const out = await runApproveBundle(request, { ...base, expect: keys });
      expect(request).not.toHaveBeenCalled();
      expect(out).toMatchObject({ ok: false, failure: { action: 'continue', code: 'missing-key', message: FULL_ACCESS_COPY.missingKey } });
    }
    expect(FULL_ACCESS_COPY.missingKey).not.toBe('');
  });
  it('create:false with both keys on file is sent', async () => {
    const request = vi.fn().mockResolvedValue(okReply);
    const out = await runApproveBundle(request, {
      create: false, actAsNaturalPerson: false, style: 'everyday', masterPubkey: MASTER,
      expect: { naturalPerson: NP, persona: PERSONA },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true);
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
    expect(parseOwnerStatus('{"owner":true,"style":"custom"}')).toEqual({ owner: true, style: 'custom' });
    expect(parseOwnerStatus('{"owner":true,"style":"weird"}')).toEqual({ owner: true, style: 'everyday' });
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
  it('W4: narrowing a custom slot changes nothing and says so', async () => {
    const out = await narrowToCareful(vi.fn().mockResolvedValue('{"style":"custom","changed":false}'));
    expect(out).toEqual({ ok: false, message: FULL_ACCESS_COPY.customNarrow, style: 'custom' });
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
  const okReply = JSON.stringify({ v: 1, pubkeys: { 'natural-person': NP, persona: PERSONA }, act_as: ['persona'], owner: true, style: 'everyday' });
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

describe('onboarding no-answer (A1)', () => {
  it('replaces the Settings pointer with the onboarding line', async () => {
    let seen: unknown;
    const ui = { chooseFullAccess: vi.fn(async (offer: FullAccessOffer) => { seen = await offer.run('everyday'); return { mode: 'separate' as const }; }) };
    await negotiateFullAccess({
      ui, clientPubkeyHex: VECTOR_CLIENT, masterPubkey: MASTER, probe: async () => ['heartwood_approve_bundle'],
      request: vi.fn().mockRejectedValue(new BunkerRequestTimeoutError('heartwood_approve_bundle')),
    });
    expect(seen).toMatchObject({ ok: false, failure: { code: 'no-answer', message: FULL_ACCESS_COPY.noAnswerOnboarding } });
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
    bunkerMode: true, routerSettled: true,
    supported: true, everHadFullAccess: true, statusOwner: null as boolean | null,
    awaitingFirstStatus: false, vaultNeedsApproval: false, dismissed: false,
  };
  it('holds backups while the first status answer is pending', () => {
    expect(ownerOfferState({ ...base, awaitingFirstStatus: true }).holdBackups).toBe(true);
  });
  it('review 2: also holds them until the router probe has settled, before `supported` can be known', () => {
    const early = { ...base, routerSettled: false, supported: false, awaitingFirstStatus: false };
    expect(ownerOfferState(early).holdBackups).toBe(true);
    // The router is in but the first status answer has not come.
    expect(ownerOfferState({ ...base, awaitingFirstStatus: true }).holdBackups).toBe(true);
    // Both settled: backups run.
    expect(ownerOfferState(base).holdBackups).toBe(false);
  });
  it('review 2: a failed probe, a router with no bundle method or a failed status releases the hold', () => {
    // Probe gave up (settled, no router): supported false, nothing to wait for.
    expect(ownerOfferState({ ...base, supported: false }).holdBackups).toBe(false);
    // Status failed: the answer is still "settled" (awaitingFirstStatus false), unknown is not off.
    expect(ownerOfferState({ ...base, statusOwner: null, awaitingFirstStatus: false }).holdBackups).toBe(false);
  });
  it('review 2: only for a bunker install with a style on file', () => {
    expect(ownerOfferState({ ...base, routerSettled: false, bunkerMode: false }).holdBackups).toBe(false);
    expect(ownerOfferState({ ...base, routerSettled: false, everHadFullAccess: false }).holdBackups).toBe(false);
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

describe('realNameFirstUseAsks (A2, review 3)', () => {
  it('keeps today\'s answer when nothing is stored', () => {
    expect(realNameFirstUseAsks({ supported: true, storedActAs: undefined, ownerOn: true })).toBe(true);
    expect(realNameFirstUseAsks({ supported: false, storedActAs: undefined, ownerOn: null })).toBe(false);
  });
  it('a grant that covers natural-person promises no card', () => {
    expect(realNameFirstUseAsks({ supported: true, storedActAs: ['natural-person', 'persona'], ownerOn: true })).toBe(false);
    expect(realNameFirstUseAsks({ supported: true, storedActAs: ['natural-person', 'persona'], ownerOn: null })).toBe(false);
  });
  it('a persona-only grant, or a mark the device has dropped, still asks once', () => {
    expect(realNameFirstUseAsks({ supported: true, storedActAs: ['persona'], ownerOn: true })).toBe(true);
    expect(realNameFirstUseAsks({ supported: true, storedActAs: ['natural-person', 'persona'], ownerOn: false })).toBe(true);
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
