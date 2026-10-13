// @vitest-environment jsdom
/**
 * Part B: My Signet's own relay-mode Sign in with Signet on a direct-paired
 * child. The real gate, the real answer seal pass, a local persona key and
 * the real `signAuthChallenge` / `wrapAuthResponse` the app uses — so each
 * case counts the asks the guardian would actually see.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { decrypt, getConversationKey } from 'nostr-tools/nip44';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import type { PairedChildRecord } from '../types';
import type { ChildRule } from '../types/child-rules';
import type { ChildRulesPayload } from '../lib/child-rules-wire';
import { buildVerdictEvent, openAskEvent, type ChildSignAsk, type ChildSignVerdict } from '../lib/child-sign-asks';
import { LocalSigningBackend } from '../lib/signing-backend';
import { answerSealingBackend, ANSWER_SEAL_PASS_LIFETIME_MS } from '../lib/answer-seal-pass';
import { childSignInBackend } from '../lib/child-bunker';
import { signAuthChallenge } from '../lib/signet';
import { wrapAuthResponse, type AuthResponse } from '../lib/relay-publish';
import { useChildGate, resetRequestCreatedAtForTests, type ChildGateTransport } from './useChildGate';

const DEP = 'ef'.repeat(32);
const railSk = generateSecretKey(), railPriv = bytesToHex(railSk), railPub = getPublicKey(railSk);
const clientSk = generateSecretKey(), clientPriv = bytesToHex(clientSk), clientPub = getPublicKey(clientSk);
const personaSk = generateSecretKey(), PERSONA = getPublicKey(personaSk);
const sessionSk = generateSecretKey(), SESSION = getPublicKey(sessionSk);
const OUTSIDE_APP = getPublicKey(generateSecretKey());
const ORIGIN = 'https://twang.example';
const CHALLENGE = 'cd'.repeat(32);

function record(): PairedChildRecord {
  return {
    id: DEP, bunkerUri: `bunker://${PERSONA}?relay=wss%3A%2F%2Fhw.example`,
    clientKeypair: { publicKey: clientPub, privateKey: clientPriv },
    dependantPubkey: DEP, dependantName: 'TapKid', pairedAt: 1, hasPaired: true,
    mode: 'heartwood-direct', railPubkey: railPub, personaPubkey: PERSONA,
    hwRelays: ['wss://hw.example'], railRelay: 'wss://rail.example',
  };
}
function rules(over: Partial<ChildRulesPayload> = {}): ChildRulesPayload {
  return { v: 1, dependantId: DEP, stage: 'request-approve', ceilingKinds: [1], rules: [], disconnectedApps: [], updatedAt: 1, ...over };
}

function setup(opts: { rules?: ChildRulesPayload } = {}) {
  const published: NostrEvent[] = [];
  const subs: { filters: { '#d'?: string[] }[]; onEvent: (e: NostrEvent) => void; closed: boolean }[] = [];
  const t: ChildGateTransport = {
    publish: async (ev) => { published.push(ev); return { ok: true, message: '' }; },
    subscribe: (filters, _relays, onEvent) => {
      const s = { filters: filters as never, onEvent, closed: false };
      subs.push(s);
      return () => { s.closed = true; };
    },
  };
  const clock = { t: Date.now() };
  /** The rules payload the child holds; change it and `hook.rerender()` (a rule arriving on the rules rail). */
  const cfg = { rules: opts.rules ?? rules() };
  const hook = renderHook(() => useChildGate({
    record: record(), rules: cfg.rules, relays: ['wss://rail.example'], unpaired: false,
    onActivity: () => {}, transport: t, now: () => clock.t,
  }));
  const asks = async (): Promise<ChildSignAsk[]> => {
    const out: ChildSignAsk[] = [];
    for (const ev of published) {
      const a = await openAskEvent(ev, railPriv, { clientPubkey: clientPub, dependantId: DEP, personas: [PERSONA], nowS: Math.floor(clock.t / 1000) });
      if (!a) throw new Error('ask did not open');
      out.push(a);
    }
    return out;
  };
  /** Answer the newest ask as the guardian would. */
  const answer = async (verdict: ChildSignVerdict['verdict'], extra: Partial<ChildSignVerdict> = {}) => {
    const all = await asks();
    const a = all[all.length - 1];
    const ev = await buildVerdictEvent({ v: 1, id: a.id, verdict, decidedAt: Math.floor(clock.t / 1000), ...extra }, railPriv, clientPub);
    const sub = subs.find(s => !s.closed && s.filters[0]['#d']?.[0]?.endsWith(a.id));
    if (!sub) throw new Error('no verdict subscription');
    await act(async () => { sub.onEvent(ev); await new Promise(r => setTimeout(r, 0)); });
  };
  const gate = {
    authorise: (r: Parameters<typeof hook.result.current.authorise>[0]) => hook.result.current.authorise(r),
    forwardPassed: (r: Parameters<typeof hook.result.current.forwardPassed>[0]) => hook.result.current.forwardPassed(r),
  };
  return { hook, published, asks, answer, gate, clock, cfg };
}

const inner = () => new LocalSigningBackend(bytesToHex(personaSk));
/** The wrapper the relay-mode sign-in builds on a direct child (App.tsx). */
const signInWrapper = (s: ReturnType<typeof setup>, sharesHandle = true) => answerSealingBackend({
  inner: inner(), gate: s.gate, persona: PERSONA, appLabel: 'Twang Thang', siteOrigin: ORIGIN,
  sessionPubkey: SESSION, eligibleKind: 21236, responseField: 'authEvent', signIn: { sharesHandle }, now: () => s.clock.t,
});

/** Run `fn`, letting the gate publish, and hand back its (still pending) promise. */
async function start<T>(fn: () => Promise<T>): Promise<{ p: Promise<T> }> {
  let p!: Promise<T>;
  await act(async () => { p = fn(); p.catch(() => {}); await new Promise(r => setTimeout(r, 0)); });
  return { p };
}

const response = (authEvent: NostrEvent): AuthResponse => ({ type: 'signet-auth-response', requestId: CHALLENGE, authEvent, displayName: 'Tap' });

beforeEach(() => resetRequestCreatedAtForTests());

describe('Part B: the sign-in ask carries the marker', () => {
  it('a marked 21236 asks on site:<origin>, saying whether the handle is shared', async () => {
    for (const sharesHandle of [true, false]) {
      const s = setup();
      const w = signInWrapper(s, sharesHandle);
      void await start(() => signAuthChallenge(w, CHALLENGE, ORIGIN, undefined, 'Twang Thang'));
      const [a] = await s.asks();
      expect(a).toMatchObject({ scope: 'sign-in', kind: 21236, target: `site:${ORIGIN}`, targetLabel: 'Twang Thang', signIn: { sharesHandle } });
    }
  });

  it('the marker never rides on another request, even when the caller passes it', async () => {
    const s = setup();
    const seal: UnsignedEvent = { kind: 13, pubkey: PERSONA, created_at: 1, tags: [], content: 'x' };
    void await start(() => s.gate.authorise({ persona: PERSONA, appId: 'mysignet', appLabel: 'x', siteOrigin: ORIGIN, method: 'sign_event', template: seal, signIn: { sharesHandle: true } }));
    void await start(() => s.gate.authorise({ persona: PERSONA, appId: 'mysignet', appLabel: 'x', method: 'nip44_encrypt', peer: SESSION, signIn: { sharesHandle: true } }));
    const all = await s.asks();
    expect(all).toHaveLength(2);
    for (const a of all) expect(a.signIn).toBeUndefined();
  });

  it('an outside NIP-46 app\'s 21236 is unmarked (its route never passes one)', async () => {
    const s = setup();
    const t: UnsignedEvent = { kind: 21236, pubkey: PERSONA, created_at: 1, tags: [['challenge', CHALLENGE], ['origin', ORIGIN]], content: '' };
    void await start(() => s.gate.authorise({ persona: PERSONA, appId: OUTSIDE_APP, appLabel: 'Some app', method: 'sign_event', template: t }));
    const [a] = await s.asks();
    expect(a.scope).toBe('sign-in');
    expect(a.signIn).toBeUndefined();
  });

  it('redirect mode (today\'s childSignInBackend) is unmarked', async () => {
    const s = setup();
    const w = childSignInBackend({ inner: inner(), origin: ORIGIN, siteLabel: 'Twang Thang', authorise: s.gate.authorise, touch: () => {} });
    void await start(() => signAuthChallenge(w, CHALLENGE, ORIGIN));
    const [a] = await s.asks();
    expect(a.signIn).toBeUndefined();
  });
});

describe('Part B: one card for the sign-in', () => {
  it('positive path: the 21236 approved on the card with the seal opened — the encrypt and the seal go without another ask', async () => {
    const s = setup();
    const w = signInWrapper(s);
    const signing = (await start(() => signAuthChallenge(w, CHALLENGE, ORIGIN, undefined, 'Twang Thang'))).p;
    await s.answer('once', { alsoOpened: [13] });
    const { authEvent } = await signing;
    expect(authEvent.kind).toBe(21236);
    const wrap = await wrapAuthResponse(response(authEvent), w, SESSION);
    expect(wrap).not.toBeNull();
    expect(s.published).toHaveLength(1); // the one sign-in card, nothing more
    // The consumer opens it: seal and rumor by the persona, carrying the signed sign-in.
    const seal = JSON.parse(decrypt(wrap!.content, getConversationKey(sessionSk, wrap!.pubkey))) as NostrEvent;
    expect(seal).toMatchObject({ kind: 13, pubkey: PERSONA, tags: [] });
    expect(verifyEvent(seal as never)).toBe(true);
    const rumor = JSON.parse(decrypt(seal.content, getConversationKey(sessionSk, PERSONA)));
    expect(rumor.pubkey).toBe(PERSONA);
    expect(JSON.parse(rumor.content).authEvent).toEqual(authEvent);
  });

  it('an older guardian (Allow once, no alsoOpened): no pass — the encrypt asks, as today', async () => {
    const s = setup();
    const w = signInWrapper(s);
    const signing = (await start(() => signAuthChallenge(w, CHALLENGE, ORIGIN))).p;
    await s.answer('once');
    const { authEvent } = await signing;
    void await start(() => wrapAuthResponse(response(authEvent), w, SESSION));
    const all = await s.asks();
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ method: 'nip44_encrypt', scope: 'dm-private', target: `peer:${SESSION}` });
  });

  it('signed under an allow rule (no card): no pass — the encrypt asks', async () => {
    const allowSite: ChildRule = { id: 'b2'.repeat(16), dependantId: DEP, persona: PERSONA, scope: 'sign-in', target: `site:${ORIGIN}`, decision: 'allow', createdAt: 1, updatedAt: 1 };
    const s = setup({ rules: rules({ rules: [allowSite], ceilingKinds: [1, 21236] }) });
    const w = signInWrapper(s);
    const { authEvent } = await signAuthChallenge(w, CHALLENGE, ORIGIN);
    expect(s.published).toHaveLength(0); // no card for the sign-in itself
    void await start(() => wrapAuthResponse(response(authEvent), w, SESSION));
    const all = await s.asks();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ method: 'nip44_encrypt' });
  });

  it('M6: "Always" on the card with the seal opened — THIS answer\'s encrypt and seal go without another ask; a later sign-in under the rule mints no pass', async () => {
    const s = setup();
    const w = signInWrapper(s);
    const signing = (await start(() => signAuthChallenge(w, CHALLENGE, ORIGIN, undefined, 'Twang Thang'))).p;
    await s.answer('always', { ruleId: '3'.repeat(32), alsoOpened: [13] });
    const { authEvent } = await signing;
    const wrap = await wrapAuthResponse(response(authEvent), w, SESSION);
    expect(wrap).not.toBeNull();
    expect(s.published).toHaveLength(1); // the one sign-in card, nothing more

    // The rule reaches the child (scope sign-in → 21236 only). The next sign-in to that site signs with no card and no verdict — so no pass.
    const allowSite: ChildRule = { id: '3'.repeat(32), dependantId: DEP, persona: PERSONA, scope: 'sign-in', target: `site:${ORIGIN}`, decision: 'allow', createdAt: 1, updatedAt: 1 };
    s.cfg.rules = rules({ rules: [allowSite], ceilingKinds: [1, 21236] });
    s.hook.rerender();
    const w2 = signInWrapper(s);
    const { authEvent: again } = await signAuthChallenge(w2, CHALLENGE, ORIGIN);
    expect(s.published).toHaveLength(1); // no card for the sign-in itself
    void await start(() => wrapAuthResponse(response(again), w2, SESSION));
    const all = await s.asks();
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ method: 'nip44_encrypt', scope: 'dm-private', target: `peer:${SESSION}` });
  });

  it('"Always" on the card from an older guardian (a rule, no alsoOpened): no pass — the encrypt asks', async () => {
    const s = setup();
    const w = signInWrapper(s);
    const signing = (await start(() => signAuthChallenge(w, CHALLENGE, ORIGIN))).p;
    await s.answer('always', { ruleId: '3'.repeat(32) });
    const { authEvent } = await signing;
    void await start(() => wrapAuthResponse(response(authEvent), w, SESSION));
    expect((await s.asks())[1]).toMatchObject({ method: 'nip44_encrypt' });
  });
});

describe('Part B: every §8.1 / §10 fallback still asks', () => {
  async function minted() {
    const s = setup();
    const w = signInWrapper(s);
    const signing = (await start(() => signAuthChallenge(w, CHALLENGE, ORIGIN))).p;
    await s.answer('once', { alsoOpened: [13] });
    const { authEvent } = await signing;
    return { s, w, authEvent };
  }
  const rumorJson = (authEvent: NostrEvent, over: Record<string, unknown> = {}) => JSON.stringify({
    kind: 29999, pubkey: PERSONA, created_at: 1, tags: [['session', CHALLENGE], ['status', 'approved']],
    content: JSON.stringify(response(authEvent)), id: 'ab'.repeat(32), ...over,
  });
  const sealOf = (content: string, over: Partial<UnsignedEvent> = {}): UnsignedEvent => ({ kind: 13, pubkey: PERSONA, created_at: 1, tags: [], content, ...over });
  const lastAsk = async (s: ReturnType<typeof setup>) => (await s.asks()).at(-1)!;

  it('an unrelated encrypt (another peer) asks', async () => {
    const { s, w, authEvent } = await minted();
    void await start(() => w.nip44Encrypt(OUTSIDE_APP, rumorJson(authEvent)));
    expect(s.published).toHaveLength(2);
    expect(await lastAsk(s)).toMatchObject({ method: 'nip44_encrypt', target: `peer:${OUTSIDE_APP}` });
  });

  it('an encrypt to the session key with other plaintext asks', async () => {
    const { s, w, authEvent } = await minted();
    void await start(() => w.nip44Encrypt(SESSION, 'hello'));
    void await start(() => w.nip44Encrypt(SESSION, rumorJson({ ...authEvent, id: 'ef'.repeat(32) })));
    void await start(() => w.nip44Encrypt(SESSION, rumorJson(authEvent, { tags: [['session', CHALLENGE], ['status', 'rejected']] })));
    expect(s.published).toHaveLength(4);
  });

  it('an unrelated seal (other content, or tags) asks', async () => {
    const { s, w, authEvent } = await minted();
    let c!: string;
    await act(async () => { c = await w.nip44Encrypt(SESSION, rumorJson(authEvent)); });
    expect(s.published).toHaveLength(1); // the matching encrypt passed
    void await start(() => w.signEvent(sealOf(c + 'x')));
    void await start(() => w.signEvent(sealOf(c, { tags: [['p', SESSION]] })));
    void await start(() => w.signEvent(sealOf('something else')));
    expect(s.published).toHaveLength(4);
    expect(await lastAsk(s)).toMatchObject({ kind: 13, scope: 'dm-private' });
  });

  it('a second use of the pass asks', async () => {
    const { s, w, authEvent } = await minted();
    await act(async () => { await wrapAuthResponse(response(authEvent), w, SESSION); });
    expect(s.published).toHaveLength(1);
    // a rebuilt wrap (the app never does this: it keeps the one wrap for retries) asks again
    void await start(() => wrapAuthResponse(response(authEvent), w, SESSION));
    expect(s.published).toHaveLength(2);
    expect(await lastAsk(s)).toMatchObject({ method: 'nip44_encrypt' });
  });

  it('an expired pass asks', async () => {
    const { s, w, authEvent } = await minted();
    s.clock.t += ANSWER_SEAL_PASS_LIFETIME_MS + 1;
    void await start(() => wrapAuthResponse(response(authEvent), w, SESSION));
    expect(s.published).toHaveLength(2);
    expect(await lastAsk(s)).toMatchObject({ method: 'nip44_encrypt' });
  });

  it('an outside app\'s encrypt and seal to the same session key ask (they never reach the pass)', async () => {
    const { s, w, authEvent } = await minted();
    let c!: string;
    await act(async () => { c = await w.nip44Encrypt(SESSION, rumorJson(authEvent)); });
    // the same bytes, from an outside NIP-46 app through the gate's authorise
    void await start(() => s.gate.authorise({ persona: PERSONA, appId: OUTSIDE_APP, appLabel: 'Some app', method: 'nip44_encrypt', peer: SESSION }));
    void await start(() => s.gate.authorise({ persona: PERSONA, appId: OUTSIDE_APP, appLabel: 'Some app', method: 'sign_event', template: sealOf(c) }));
    expect(s.published).toHaveLength(3);
  });

  it('a denied sign-in mints nothing', async () => {
    const s = setup();
    const w = signInWrapper(s);
    const signing = (await start(() => signAuthChallenge(w, CHALLENGE, ORIGIN))).p;
    await s.answer('deny');
    await expect(signing).rejects.toThrow();
    const fake = { id: 'ab'.repeat(32) } as NostrEvent;
    void await start(() => w.nip44Encrypt(SESSION, rumorJson(fake)));
    expect(s.published).toHaveLength(2);
  });
});
