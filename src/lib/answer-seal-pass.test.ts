import { describe, it, expect, vi } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { decrypt, getConversationKey } from 'nostr-tools/nip44';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import { LocalSigningBackend, type DecryptingSigningBackend } from './signing-backend';
import { giftWrap } from './relay-publish';
import { buildAppPermissionApprovedRumor } from './app-permission';
import { ChildGateRefusedError, gatedSigningBackend, ungatedInner, type ChildGateOutcome } from './child-bunker';
import type { ChildGateRequest } from '../hooks/useChildGate';
import { answerSealingBackend, ANSWER_SEAL_PASS_LIFETIME_MS } from './answer-seal-pass';

const personaSk = generateSecretKey();
const PERSONA = getPublicKey(personaSk);
const sessionSk = generateSecretKey();
const SESSION = getPublicKey(sessionSk);
const OTHER = getPublicKey(generateSecretKey());
const CHALLENGE = 'cd'.repeat(32);
const ORIGIN = 'https://twang.example';
const CLAIM = { permission: 'online-play' as const, name: 'Twang Thang', origin: ORIGIN, reason: 'To play online.' };
const T0 = 1_900_000_000_000;

const statement = (): UnsignedEvent => ({
  kind: 30420, pubkey: PERSONA, created_at: 1_900_000_000, content: '',
  tags: [['d', 'twang'], ['p', OTHER], ['valid_from', '1900000000'], ['valid_until', '1900086400'], ['v', '1'], ['role', 'player'], ['expiration', '1900086400']],
});

/** A gate that allows everything; the spies tell which entry each operation took. */
function setup(opts: { refuse?: boolean; responseField?: 'event' | 'authEvent' } = {}) {
  const clock = { t: T0 };
  const outcome = (req: ChildGateRequest): ChildGateOutcome => (opts.refuse
    ? { ok: false, error: 'denied' }
    : { ok: true, requestCreatedAt: 1_900_000_000, ...(req.template ? { template: { ...req.template, pubkey: req.persona } } : {}) });
  const gate = {
    authorise: vi.fn(async (req: ChildGateRequest) => outcome(req)),
    forwardPassed: vi.fn(async (req: ChildGateRequest) => ({ ok: true as const, requestCreatedAt: 1_900_000_000, ...(req.template ? { template: { ...req.template, pubkey: req.persona } } : {}) })),
  };
  const inner = new LocalSigningBackend(bytesToHex(personaSk));
  const w = answerSealingBackend({
    inner, gate, persona: PERSONA, appLabel: 'Twang Thang', siteOrigin: ORIGIN, appPermission: CLAIM,
    sessionPubkey: SESSION, eligibleKind: 30420, responseField: opts.responseField ?? 'event', now: () => clock.t,
  });
  /** Which entry each call took, in order. */
  const took = () => [
    ...gate.authorise.mock.calls.map((c, i) => ({ via: 'authorise', order: gate.authorise.mock.invocationCallOrder[i], method: c[0].method, kind: c[0].template?.kind })),
    ...gate.forwardPassed.mock.calls.map((c, i) => ({ via: 'passed', order: gate.forwardPassed.mock.invocationCallOrder[i], method: c[0].method, kind: c[0].template?.kind })),
  ].sort((a, b) => a.order - b.order).map(({ via, method, kind }) => (kind === undefined ? `${via}:${method}` : `${via}:${method}:${kind}`));
  return { w, gate, clock, inner, took };
}

const rumorFor = (event: NostrEvent | { id: string }, over: Partial<UnsignedEvent> = {}) =>
  ({ ...buildAppPermissionApprovedRumor({ persona: PERSONA, challenge: CHALLENGE, permission: 'online-play', event: event as NostrEvent, nowS: 1_900_000_000 }), ...over });
const rumorJson = (r: UnsignedEvent) => JSON.stringify({ ...r, id: 'ab'.repeat(32) });
const sealOf = (content: string, over: Partial<UnsignedEvent> = {}): UnsignedEvent => ({ kind: 13, pubkey: PERSONA, created_at: 1_900_000_000, tags: [], content, ...over });

describe('answerSealingBackend — the positive path', () => {
  it('sign 30420 (gated) → encrypt the matching rumor → seal the exact ciphertext: the last two forward without a decision', async () => {
    const s = setup();
    const signed = await s.w.signEvent(statement());
    expect(signed.pubkey).toBe(PERSONA);
    const wrap = await giftWrap(rumorFor(signed), SESSION, s.w);
    expect(s.took()).toEqual(['authorise:sign_event:30420', 'passed:nip44_encrypt', 'passed:sign_event:13']);
    // The app opens it: seal by the persona, rumor by the persona, carrying the signed statement.
    const seal = JSON.parse(decrypt(wrap.content, getConversationKey(sessionSk, wrap.pubkey))) as NostrEvent;
    expect(seal.kind).toBe(13);
    expect(seal.pubkey).toBe(PERSONA);
    expect(verifyEvent(seal as never)).toBe(true);
    const rumor = JSON.parse(decrypt(seal.content, getConversationKey(sessionSk, PERSONA)));
    expect(rumor.pubkey).toBe(PERSONA);
    expect(JSON.parse(rumor.content).event).toEqual(signed);
  });

  it('the claim goes to the gate on the 30420 only, as the app\'s own act on the site', async () => {
    const s = setup();
    const signed = await s.w.signEvent(statement());
    await giftWrap(rumorFor(signed), SESSION, s.w);
    expect(s.gate.authorise).toHaveBeenCalledWith(expect.objectContaining({
      persona: PERSONA, appId: 'mysignet', appLabel: 'Twang Thang', siteOrigin: ORIGIN, method: 'sign_event', appPermission: CLAIM,
    }));
    for (const [req] of s.gate.forwardPassed.mock.calls) {
      expect(req).toMatchObject({ persona: PERSONA, appId: 'mysignet', siteOrigin: ORIGIN });
      expect(req.appPermission).toBeUndefined();
    }
  });

  it('a re-encrypt before the seal replaces the recorded ciphertext', async () => {
    const s = setup();
    const signed = await s.w.signEvent(statement());
    const pt = rumorJson(rumorFor(signed));
    const c1 = await s.w.nip44Encrypt(SESSION, pt);
    const c2 = await s.w.nip44Encrypt(SESSION, pt);
    expect(c1).not.toBe(c2);
    // The first ciphertext no longer passes…
    await s.w.signEvent(sealOf(c1));
    // …the second does.
    await s.w.signEvent(sealOf(c2));
    expect(s.took()).toEqual([
      'authorise:sign_event:30420', 'passed:nip44_encrypt', 'passed:nip44_encrypt', 'authorise:sign_event:13', 'passed:sign_event:13',
    ]);
  });

  it('the `authEvent` field works for a sign-in answer (Part B shape)', async () => {
    const s = setup({ responseField: 'authEvent' });
    const signed = await s.w.signEvent(statement());
    const r = { kind: 29999, pubkey: PERSONA, created_at: 1, tags: [['session', CHALLENGE], ['status', 'approved']], content: JSON.stringify({ authEvent: signed }) };
    const c = await s.w.nip44Encrypt(SESSION, rumorJson(r));
    await s.w.signEvent(sealOf(c));
    expect(s.took()).toEqual(['authorise:sign_event:30420', 'passed:nip44_encrypt', 'passed:sign_event:13']);
  });
});

describe('answerSealingBackend — every mismatch takes the ordinary gated path', () => {
  async function minted() {
    const s = setup();
    const signed = await s.w.signEvent(statement());
    return { ...s, signed };
  }

  it('an unrelated encrypt (another peer)', async () => {
    const s = await minted();
    await s.w.nip44Encrypt(OTHER, rumorJson(rumorFor(s.signed)));
    expect(s.took()).toEqual(['authorise:sign_event:30420', 'authorise:nip44_encrypt']);
  });

  it('an encrypt to the session key with different plaintext', async () => {
    const s = await minted();
    await s.w.nip44Encrypt(SESSION, 'hello');
    await s.w.nip44Encrypt(SESSION, rumorJson(rumorFor({ id: 'ef'.repeat(32) })));
    await s.w.nip44Encrypt(SESSION, rumorJson(rumorFor(s.signed, { kind: 29998 })));
    await s.w.nip44Encrypt(SESSION, rumorJson(rumorFor(s.signed, { pubkey: OTHER })));
    await s.w.nip44Encrypt(SESSION, rumorJson(rumorFor(s.signed, { tags: [['status', 'approved']] })));
    await s.w.nip44Encrypt(SESSION, rumorJson(rumorFor(s.signed, { content: JSON.stringify({ authEvent: s.signed }) })));
    await s.w.nip44Encrypt(SESSION, rumorJson(rumorFor(s.signed, { content: 'not json' })));
    expect(s.took().slice(1)).toEqual(Array(7).fill('authorise:nip44_encrypt'));
  });

  it('a rumor with status rejected (or both statuses)', async () => {
    const s = await minted();
    await s.w.nip44Encrypt(SESSION, rumorJson(rumorFor(s.signed, { tags: [['session', CHALLENGE], ['status', 'rejected']] })));
    await s.w.nip44Encrypt(SESSION, rumorJson(rumorFor(s.signed, { tags: [['session', CHALLENGE], ['status', 'approved'], ['status', 'rejected']] })));
    expect(s.took().slice(1)).toEqual(['authorise:nip44_encrypt', 'authorise:nip44_encrypt']);
  });

  it('a seal over other content, or with tags, or by another key, or another kind', async () => {
    const s = await minted();
    const c = await s.w.nip44Encrypt(SESSION, rumorJson(rumorFor(s.signed)));
    await s.w.signEvent(sealOf(c + 'x'));
    await s.w.signEvent(sealOf(c, { tags: [['p', SESSION]] }));
    await s.w.signEvent(sealOf(c, { kind: 14 }));
    // (the gate puts the persona on every template, so a seal "by another key" is checked on what the caller asked for)
    await s.w.signEvent(sealOf(c, { pubkey: OTHER }));
    expect(s.took()).toEqual([
      'authorise:sign_event:30420', 'passed:nip44_encrypt',
      'authorise:sign_event:13', 'authorise:sign_event:13', 'authorise:sign_event:14', 'authorise:sign_event:13',
    ]);
  });

  it('a seal before any encrypt', async () => {
    const s = await minted();
    await s.w.signEvent(sealOf('anything'));
    expect(s.took()).toEqual(['authorise:sign_event:30420', 'authorise:sign_event:13']);
  });

  it('a second seal after the pass is used, and an encrypt after it', async () => {
    const s = await minted();
    const c = await s.w.nip44Encrypt(SESSION, rumorJson(rumorFor(s.signed)));
    await s.w.signEvent(sealOf(c));
    await s.w.signEvent(sealOf(c));
    await s.w.nip44Encrypt(SESSION, rumorJson(rumorFor(s.signed)));
    expect(s.took()).toEqual([
      'authorise:sign_event:30420', 'passed:nip44_encrypt', 'passed:sign_event:13', 'authorise:sign_event:13', 'authorise:nip44_encrypt',
    ]);
  });

  it('an expired pass (more than 60 s after the mint)', async () => {
    const s = await minted();
    const c = await s.w.nip44Encrypt(SESSION, rumorJson(rumorFor(s.signed)));
    s.clock.t = T0 + ANSWER_SEAL_PASS_LIFETIME_MS + 1;
    await s.w.signEvent(sealOf(c));
    await s.w.nip44Encrypt(SESSION, rumorJson(rumorFor(s.signed)));
    expect(ANSWER_SEAL_PASS_LIFETIME_MS).toBe(60_000);
    expect(s.took()).toEqual(['authorise:sign_event:30420', 'passed:nip44_encrypt', 'authorise:sign_event:13', 'authorise:nip44_encrypt']);
  });

  it('a wrapper with no mint (the eligible signature never happened)', async () => {
    const s = setup();
    const fake = { id: 'ab'.repeat(32) };
    const c = await s.w.nip44Encrypt(SESSION, rumorJson(rumorFor(fake)));
    await s.w.signEvent(sealOf(c));
    expect(s.took()).toEqual(['authorise:nip44_encrypt', 'authorise:sign_event:13']);
  });

  it('a refused eligible signature mints nothing', async () => {
    const s = setup({ refuse: true });
    await expect(s.w.signEvent(statement())).rejects.toBeInstanceOf(ChildGateRefusedError);
    s.gate.authorise.mockImplementation(async (req) => ({ ok: true, requestCreatedAt: 1, ...(req.template ? { template: { ...req.template, pubkey: PERSONA } } : {}) }));
    const c = await s.w.nip44Encrypt(SESSION, rumorJson(rumorFor({ id: 'ab'.repeat(32) })));
    await s.w.signEvent(sealOf(c));
    expect(s.took()).toEqual(['authorise:sign_event:30420', 'authorise:nip44_encrypt', 'authorise:sign_event:13']);
  });

  it('one mint per wrapper: a second 30420 does not re-arm it', async () => {
    const s = await minted();
    const second = await s.w.signEvent({ ...statement(), created_at: 1_900_000_100 });
    expect(second.id).not.toBe(s.signed.id);
    await s.w.nip44Encrypt(SESSION, rumorJson(rumorFor(second)));
    expect(s.took()).toEqual(['authorise:sign_event:30420', 'authorise:sign_event:30420', 'authorise:nip44_encrypt']);
  });

  it('a mismatch is never refused by the wrapper itself — the gate decides (here: refuses)', async () => {
    const s = await minted();
    s.gate.authorise.mockResolvedValue({ ok: false, error: 'denied' });
    await expect(s.w.nip44Encrypt(OTHER, 'x')).rejects.toBeInstanceOf(ChildGateRefusedError);
    await expect(s.w.signEvent(sealOf('x'))).rejects.toBeInstanceOf(ChildGateRefusedError);
  });

  it('decrypt is always the ordinary path', async () => {
    const s = await minted();
    const c = await s.w.nip44Encrypt(SESSION, rumorJson(rumorFor(s.signed)));
    await expect(s.w.nip44Decrypt(SESSION, c)).resolves.toBeTypeOf('string');
    expect(s.took().at(-1)).toBe('authorise:nip44_decrypt');
  });

  it('re-gating the wrapper collapses to the ordinary gate (never a pass through another gate)', async () => {
    const s = await minted();
    expect(ungatedInner(s.w as DecryptingSigningBackend)).toBe(s.inner);
    const outer = vi.fn(async (): Promise<ChildGateOutcome> => ({ ok: true, requestCreatedAt: 1 }));
    const regated = gatedSigningBackend(s.w, outer);
    await regated.nip44Encrypt(SESSION, rumorJson(rumorFor(s.signed)));
    expect(outer).toHaveBeenCalledTimes(1);
    expect(s.gate.forwardPassed).not.toHaveBeenCalled();
  });

  it('refuses to build over a backend for another persona', () => {
    const s = setup();
    expect(() => answerSealingBackend({
      inner: new LocalSigningBackend(bytesToHex(generateSecretKey())), gate: s.gate, persona: PERSONA, appLabel: 'x',
      sessionPubkey: SESSION, eligibleKind: 30420, responseField: 'event',
    })).toThrow();
  });
});
