// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';

const store = new Map<string, unknown>();
vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/db')>();
  return {
    ...actual,
    listChildRules: vi.fn(async () => []),
    saveChildRule: vi.fn(async () => {}),
    loadChildAskHistory: vi.fn(async () => (store.get('history') as unknown[]) ?? []),
    saveChildAskHistory: vi.fn(async (e: unknown[]) => { store.set('history', e); }),
  };
});

import { listChildRules, saveChildRule, saveChildAskHistory } from '../lib/db';
import { buildAskEvent, buildVerdictEvent, openVerdictEvent, type ChildSignAsk } from '../lib/child-sign-asks';
import { childRuleId } from '../lib/child-rules';
import { compileChildDirectPolicy } from '../lib/policy-compiler';
import { buildPersonaFirstDependant } from '../lib/dependant-record';
import type { ChildRule } from '../types/child-rules';
import type { DependantIdentity } from '../types';
import type { NostrEvent } from 'signet-protocol';
import { useChildAsks, type ChildAskTransport, type UseChildAsksOpts } from './useChildAsks';
import { CHILD_ASK_COPY } from '../lib/child-device-copy';

const mListRules = vi.mocked(listChildRules), mSaveRule = vi.mocked(saveChildRule), mSaveHistory = vi.mocked(saveChildAskHistory);
const RELAY = 'wss://rail.example.com';
const KEY = 'k'.repeat(64);

class FakeTransport implements ChildAskTransport {
  handlers: { relays: string[]; filters: unknown[]; cb: (ev: NostrEvent) => void }[] = [];
  published: { ev: NostrEvent; relays: string[] }[] = [];
  ok = true;
  subscribe(filters: unknown[], relays: string[], cb: (ev: NostrEvent) => void) {
    const h = { relays, filters, cb };
    this.handlers.push(h);
    return () => { this.handlers = this.handlers.filter(x => x !== h); };
  }
  async publish(ev: NostrEvent, relays: string[]) { this.published.push({ ev, relays }); return { ok: this.ok, message: '' }; }
  deliver(ev: NostrEvent) { for (const h of [...this.handlers]) h.cb(ev); }
}

const railSk = generateSecretKey(), clientSk = generateSecretKey();
const RAIL = getPublicKey(railSk), CLIENT = getPublicKey(clientSk);
const CLIENT_PRIV = bytesToHex(clientSk);
const personaSk = generateSecretKey();
const PERSONA = getPublicKey(personaSk);
const APP = 'a1'.repeat(32);

function makeDep(over: Partial<DependantIdentity> = {}): DependantIdentity {
  const d = buildPersonaFirstDependant({
    guardianPubkey: 'f'.repeat(64), enteredName: 'Lily', derivationPath: 'dependant-0',
    naturalPerson: { publicKey: getPublicKey(generateSecretKey()), privateKey: '' },
    persona: { publicKey: PERSONA, privateKey: '', displayName: 'Lil' } as never,
    createdAt: 1,
  });
  return {
    ...d,
    autonomyStage: 'request-approve',
    bunkerEndpoint: { publicKey: RAIL, privateKey: bytesToHex(railSk), createdAt: 1, authorizedClientPubkey: CLIENT },
    childDevice: { mode: 'heartwood-direct', slotLabel: 'l', secretFingerprint: 'ab'.repeat(32), slotIndex: 4, clientPubkey: CLIENT,
      boundPersona: PERSONA, pairedAt: 1, railRelay: RELAY },
    ...over,
  };
}

let clock: number;
let t: FakeTransport;
let dep: DependantIdentity;
let n = 0;

function ask(over: Partial<ChildSignAsk> = {}, kind = 30311): ChildSignAsk {
  const nowS = Math.floor(clock / 1000);
  const id = (n++).toString(16).padStart(32, '0');
  return {
    v: 1, id, dependantId: dep.id.toLowerCase(), persona: PERSONA, scope: null, kind, method: 'sign_event',
    target: `app:${APP}`, targetLabel: 'Game', template: { kind, pubkey: PERSONA, created_at: nowS, tags: [], content: 'hi' },
    createdAt: nowS, expiresAt: nowS + 600, ...over,
  };
}
const askEv = (a: ChildSignAsk) => buildAskEvent(a, CLIENT_PRIV, RAIL);

function setup(over: Partial<UseChildAsksOpts> = {}) {
  const pushCeiling = vi.fn(async (_d: string, _k?: { kind: number; until: number }): Promise<'ok' | 'failed'> => 'ok');
  const dropOnce = vi.fn(async (_d: string, _e: { kind: number; until: number }) => {});
  const onRulesChanged = vi.fn();
  const onNewAsk = vi.fn();
  const props = (): UseChildAsksOpts => ({
    dependants: [dep], relays: ['wss://fallback.example.com'], encryptionKey: KEY, pushCeiling, dropOnce, onRulesChanged, onNewAsk,
    transport: t, now: () => clock, ...over,
  });
  const hook = renderHook(() => useChildAsks(props()));
  return { hook, pushCeiling, dropOnce, onRulesChanged, onNewAsk };
}
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const verdictOf = (ev: NostrEvent, id: string) => openVerdictEvent(ev, CLIENT_PRIV, { railPubkey: RAIL, id });

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_800_000_000_000;
  vi.setSystemTime(clock);
  t = new FakeTransport();
  dep = makeDep();
  store.clear();
  mListRules.mockReset(); mListRules.mockResolvedValue([]);
  mSaveRule.mockReset(); mSaveRule.mockResolvedValue(undefined);
  mSaveHistory.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

describe('useChildAsks — inbox', () => {
  it('listens on the paired rail relay for the child client, addressed to the rail key', async () => {
    setup();
    await flush();
    expect(t.handlers).toHaveLength(1);
    expect(t.handlers[0].relays).toEqual([RELAY]);
    expect(t.handlers[0].filters[0]).toMatchObject({ kinds: [30078], authors: [CLIENT], '#p': [RAIL] });
    // A35: the rail key's own replies (any guardian device) on the same subscription.
    expect(t.handlers[0].filters[1]).toMatchObject({ kinds: [30078], authors: [RAIL], '#p': [CLIENT] });
  });

  it('an ask appears once; a duplicate event is ignored; onNewAsk fires once', async () => {
    const s = setup();
    await flush();
    const ev = await askEv(ask());
    t.deliver(ev); await flush();
    t.deliver(ev); await flush();
    expect(s.hook.result.current.asks).toHaveLength(1);
    expect(s.hook.result.current.asks[0]).toMatchObject({ dependantName: dep.displayName, dependantId: dep.id.toLowerCase() });
    expect(s.hook.result.current.asks[0].personaName.length).toBeGreaterThan(0);
    expect(s.onNewAsk).toHaveBeenCalledTimes(1);
  });

  it('an out-of-scope ask (persona not in the inventory) is never listed', async () => {
    const s = setup();
    await flush();
    const stranger = getPublicKey(generateSecretKey());
    const a = ask({ persona: stranger });
    a.template = { ...a.template!, pubkey: stranger };
    t.deliver(await askEv(a)); await flush();
    expect(s.hook.result.current.asks).toHaveLength(0);
  });

  it('a phone-paired dependant is not listened to', async () => {
    dep = { ...dep, childDevice: undefined };
    setup();
    await flush();
    expect(t.handlers).toHaveLength(0);
  });
});

describe('useChildAsks — rail key still encrypted at rest', () => {
  // The at-rest form of a 64-hex key (salt + iv + ct + tag, base64): 144 chars, not hex.
  const BLOB = 'Zm9v'.repeat(36);
  const encrypted = () => makeDep({ bunkerEndpoint: { publicKey: RAIL, privateKey: BLOB, createdAt: 1, authorizedClientPubkey: CLIENT } });

  it('does not subscribe with the encrypted blob, then arms with the decrypted key once it arrives', async () => {
    expect(BLOB).toHaveLength(144);
    let current = encrypted();
    const pushCeiling = vi.fn(async (): Promise<'ok' | 'failed'> => 'ok');
    const onNewAsk = vi.fn();
    const hook = renderHook(() => useChildAsks({
      dependants: [current], relays: ['wss://fallback.example.com'], encryptionKey: KEY, pushCeiling, onRulesChanged: vi.fn(), onNewAsk,
      transport: t, now: () => clock,
    }));
    await flush();
    expect(t.handlers).toHaveLength(0);

    current = makeDep(); // the same dependant, decrypted
    hook.rerender();
    await flush();
    expect(t.handlers).toHaveLength(1);
    t.deliver(await askEv(ask()));
    await flush();
    expect(hook.result.current.asks).toHaveLength(1);
    expect(onNewAsk).toHaveBeenCalledTimes(1);
  });
});

describe('useChildAsks — verdicts', () => {
  async function withAsk(over: Partial<UseChildAsksOpts> = {}, a: ChildSignAsk = ask()) {
    const s = setup(over);
    await flush();
    t.deliver(await askEv(a)); await flush();
    expect(s.hook.result.current.asks).toHaveLength(1);
    return { ...s, a };
  }

  it('always → persona-specific rule saved, rules reloaded, verdict published with the rule id', async () => {
    const s = await withAsk();
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'always'); });
    expect(r).toEqual({ sent: true });
    const rule = mSaveRule.mock.calls[0][0] as ChildRule;
    expect(rule).toMatchObject({ persona: PERSONA, scope: 'kind:30311', target: `app:${APP}`, decision: 'allow', label: 'Game',
      id: childRuleId(dep.id, PERSONA, 'kind:30311', `app:${APP}`) });
    expect(s.onRulesChanged).toHaveBeenCalled();
    expect(t.published[0].relays).toEqual([RELAY]);
    const v = await verdictOf(t.published[0].ev, s.a.id);
    expect(v).toMatchObject({ verdict: 'always', ruleId: rule.id });
    expect(s.hook.result.current.asks).toHaveLength(0);
  });

  it('out-of-ceiling once → pushCeiling(dep, kind) BEFORE the verdict is published', async () => {
    const s = await withAsk();
    const order: string[] = [];
    s.pushCeiling.mockImplementation(async () => { order.push('push'); return 'ok'; });
    const pub = t.publish.bind(t);
    t.publish = async (ev, relays) => { order.push('publish'); return pub(ev, relays); };
    await act(async () => { await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(s.pushCeiling).toHaveBeenCalledWith(dep.id.toLowerCase(), { kind: 30311, until: Math.floor(clock / 1000) + 600 });
    expect(order).toEqual(['push', 'publish']);
    const v0 = await verdictOf(t.published[0].ev, s.a.id);
    expect(v0).toMatchObject({ verdict: 'once' });
    // An ordinary kind opens nothing else: the verdict reports nothing more.
    expect(v0?.alsoOpened).toBeUndefined();
  });

  it('A33: a kind the LOCAL compile already holds still calls pushCeiling (once and always)', async () => {
    mListRules.mockResolvedValue([{ id: '1'.repeat(32), dependantId: dep.id, persona: '*', scope: 'sign-in', target: '*', decision: 'allow', createdAt: 1, updatedAt: 1 }]);
    const a = ask({ scope: 'sign-in' }, 21236);
    const s = await withAsk({}, a);
    await act(async () => { await s.hook.result.current.decide(a.id, 'once'); });
    expect(s.pushCeiling).toHaveBeenCalledWith(dep.id.toLowerCase(), { kind: 21236, until: Math.floor(clock / 1000) + 600 });
    expect(await verdictOf(t.published[0].ev, a.id)).toMatchObject({ verdict: 'once' });
    const b = ask({ scope: 'sign-in' }, 21236);
    t.deliver(await askEv(b)); await flush();
    await act(async () => { await s.hook.result.current.decide(b.id, 'always'); });
    expect(s.pushCeiling).toHaveBeenCalledTimes(2);
    expect(s.pushCeiling.mock.calls[1]).toEqual([dep.id.toLowerCase()]);
  });

  it('pushCeiling failed → deny with device-unreachable, and the guardian is told', async () => {
    const s = await withAsk();
    s.pushCeiling.mockResolvedValue('failed');
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(r).toEqual({ sent: true, reason: 'device-unreachable' });
    expect(await verdictOf(t.published[0].ev, s.a.id)).toMatchObject({ verdict: 'deny', reason: 'device-unreachable' });
  });

  it('A47: "Send again" of a once converted to device-unreachable re-attempts the original choice', async () => {
    const s = await withAsk();
    s.pushCeiling.mockResolvedValue('failed');
    t.ok = false; // the converted deny does not reach the child either
    await act(async () => { await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(await verdictOf(t.published[0].ev, s.a.id)).toMatchObject({ verdict: 'deny', reason: 'device-unreachable' });
    // The button names the original choice, and a later push that works sends `once`.
    s.pushCeiling.mockResolvedValue('ok');
    t.ok = true;
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(s.pushCeiling).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ sent: true });
    expect(await verdictOf(t.published[t.published.length - 1].ev, s.a.id)).toMatchObject({ verdict: 'once' });
  });

  it('A47: if the push fails again the resend is deny / device-unreachable; a plain deny resends deny', async () => {
    const s = await withAsk();
    s.pushCeiling.mockResolvedValue('failed');
    t.ok = false;
    await act(async () => { await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(s.hook.result.current.asks[0].unsent).toEqual({ verdict: 'once' });
    t.ok = true;
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(s.pushCeiling).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ sent: true, reason: 'device-unreachable' });
    expect(await verdictOf(t.published[t.published.length - 1].ev, s.a.id)).toMatchObject({ verdict: 'deny', reason: 'device-unreachable' });

    const d = await withAsk();
    t.ok = false;
    await act(async () => { await d.hook.result.current.decide(d.a.id, 'deny'); });
    t.ok = true;
    const before = d.pushCeiling.mock.calls.length;
    await act(async () => { await d.hook.result.current.decide(d.a.id, 'deny'); });
    expect(d.pushCeiling.mock.calls.length).toBe(before);
    expect(await verdictOf(t.published[t.published.length - 1].ev, d.a.id)).toMatchObject({ verdict: 'deny' });
  });

  it('A5: an Always that would need a 65th kind is refused and answered deny; no rule saved, no push', async () => {
    // request-approve lists only 22242 on its own; 63 kind rules fill the 64.
    const full: ChildRule[] = Array.from({ length: 63 }, (_, i) => ({
      id: String(i).padStart(32, '0'), dependantId: dep.id, persona: '*', scope: `kind:${40000 + i}`, target: '*', decision: 'allow',
      createdAt: 1, updatedAt: 1 + i,
    }));
    mListRules.mockResolvedValue(full);
    const s = await withAsk();
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'always'); });
    expect(r).toEqual({ sent: true, reason: 'ceiling-full' });
    expect(mSaveRule).not.toHaveBeenCalled();
    expect(s.pushCeiling).not.toHaveBeenCalled();
    expect(await verdictOf(t.published[0].ev, s.a.id)).toMatchObject({ verdict: 'deny' });
  });

  it('deny with "Always deny" saves a deny rule', async () => {
    const s = await withAsk();
    await act(async () => { await s.hook.result.current.decide(s.a.id, 'deny', { alwaysDeny: true }); });
    expect((mSaveRule.mock.calls[0][0] as ChildRule).decision).toBe('deny');
    expect(await verdictOf(t.published[0].ev, s.a.id)).toMatchObject({ verdict: 'deny', alwaysDeny: true });
  });

  it('a second decide on the same id no-ops', async () => {
    const s = await withAsk();
    await act(async () => {
      const [a, b] = await Promise.all([s.hook.result.current.decide(s.a.id, 'deny'), s.hook.result.current.decide(s.a.id, 'once')]);
      expect(a.sent).toBe(true);
      expect(b).toEqual({ sent: false, reason: 'already-decided' });
    });
    let c;
    await act(async () => { c = await s.hook.result.current.decide(s.a.id, 'always'); });
    expect(c).toEqual({ sent: false, reason: 'already-decided' });
    expect(t.published).toHaveLength(1);
  });

  it('full-control: Always is unavailable and nothing is sent', async () => {
    dep = makeDep({ autonomyStage: 'full-control' });
    const s = await withAsk();
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'always'); });
    expect(r).toEqual({ sent: false, reason: 'always-unavailable' });
    expect(t.published).toHaveLength(0);
  });

  it('history persists across a remount, and an answered ask is not raised again', async () => {
    const s = await withAsk();
    const ev = await askEv(s.a);
    await act(async () => { await s.hook.result.current.decide(s.a.id, 'deny'); });
    expect(s.hook.result.current.history).toHaveLength(1);
    expect(s.hook.result.current.history[0].ask.template).toBeUndefined();
    s.hook.unmount();
    const again = setup();
    await flush();
    expect(again.hook.result.current.history).toHaveLength(1);
    expect(again.hook.result.current.history[0].verdict.verdict).toBe('deny');
    t.deliver(ev); await flush();
    expect(again.hook.result.current.asks).toHaveLength(0);
  });

  it('A34: the chosen verdict is saved BEFORE any side effect; a failed publish offers only "Send again" of the same verdict', async () => {
    const s = await withAsk();
    const order: string[] = [];
    mSaveHistory.mockImplementation(async (e: unknown[]) => { order.push(`save:${(e[0] as { sent: boolean }).sent}`); store.set('history', e); });
    s.pushCeiling.mockImplementation(async () => { order.push('push'); return 'ok'; });
    t.ok = false;
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(r).toEqual({ sent: false, reason: 'publish-failed' });
    expect(order[0]).toBe('save:false');
    expect(order.indexOf('save:false')).toBeLessThan(order.indexOf('push'));
    const first = (store.get('history') as { chosen: string; sent: boolean }[])[0];
    expect(first).toMatchObject({ chosen: 'once', sent: false });
    // The ask stays, marked with the chosen verdict; the once entry it widened with is given back.
    expect(s.hook.result.current.asks[0].unsent).toEqual({ verdict: 'once' });
    expect(s.dropOnce).toHaveBeenCalledWith(dep.id.toLowerCase(), { kind: 30311, until: Math.floor(clock / 1000) + 600 });
    // A different verdict is refused; the same one is sent again (and re-widens the ceiling first).
    let other;
    await act(async () => { other = await s.hook.result.current.decide(s.a.id, 'deny'); });
    expect(other).toEqual({ sent: false, reason: 'already-decided' });
    t.ok = true;
    let again;
    await act(async () => { again = await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(again).toEqual({ sent: true });
    expect(s.pushCeiling).toHaveBeenCalledTimes(2);
    const v1 = await verdictOf(t.published[0].ev, s.a.id), v2 = await verdictOf(t.published[1].ev, s.a.id);
    expect(v1).toMatchObject({ verdict: 'once' });
    expect(v2).toEqual(v1);
    expect(s.hook.result.current.asks).toHaveLength(0);
    expect(s.hook.result.current.history[0]).toMatchObject({ sent: true, chosen: 'once' });
  });

  it('A34: an unsent answer survives a restart — the ask comes back with only "Send again"', async () => {
    const s = await withAsk();
    const ev = await askEv(s.a);
    t.ok = false;
    await act(async () => { await s.hook.result.current.decide(s.a.id, 'deny'); });
    s.hook.unmount();
    t.ok = true;
    const again = setup();
    await flush();
    t.deliver(ev); await flush();
    expect(again.hook.result.current.asks).toHaveLength(1);
    expect(again.hook.result.current.asks[0].unsent).toEqual({ verdict: 'deny' });
    expect(again.onNewAsk).not.toHaveBeenCalled();
    let r;
    await act(async () => { r = await again.hook.result.current.decide(s.a.id, 'deny'); });
    expect(r).toEqual({ sent: true });
    expect(await verdictOf(t.published[t.published.length - 1].ev, s.a.id)).toMatchObject({ verdict: 'deny' });
  });

  it('A34: when the choice cannot be saved nothing else happens', async () => {
    const s = await withAsk();
    mSaveHistory.mockRejectedValueOnce(new Error('quota'));
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(r).toEqual({ sent: false, reason: 'save-failed' });
    expect(s.pushCeiling).not.toHaveBeenCalled();
    expect(t.published).toHaveLength(0);
    expect(s.hook.result.current.asks[0].unsent).toBeUndefined();
  });

  it('A35: a reply already on the relay (another guardian device) marks the ask answered — no second publish', async () => {
    const s = await withAsk();
    const reply = await buildVerdictEvent({ v: 1, id: s.a.id, verdict: 'always', decidedAt: Math.floor(clock / 1000) }, bytesToHex(railSk), CLIENT);
    t.deliver(reply); await flush();
    expect(s.hook.result.current.asks).toHaveLength(0);
    expect(s.hook.result.current.history[0]).toMatchObject({ sent: true, verdict: { verdict: 'always' } });
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(r).toEqual({ sent: false, reason: 'already-decided' });
    expect(t.published).toHaveLength(0);
    expect(s.pushCeiling).not.toHaveBeenCalled();
  });

  it('A35: a reply that lands before the ask means the ask is never listed', async () => {
    const s = setup();
    await flush();
    const a = ask();
    t.deliver(await buildVerdictEvent({ v: 1, id: a.id, verdict: 'deny', decidedAt: Math.floor(clock / 1000) }, bytesToHex(railSk), CLIENT)); await flush();
    t.deliver(await askEv(a)); await flush();
    expect(s.hook.result.current.asks).toHaveLength(0);
    expect(s.onNewAsk).not.toHaveBeenCalled();
  });

  it('A35: a reply arriving while this device is deciding stops the publish and gives the once entry back', async () => {
    const s = await withAsk();
    const reply = await buildVerdictEvent({ v: 1, id: s.a.id, verdict: 'deny', decidedAt: Math.floor(clock / 1000) }, bytesToHex(railSk), CLIENT);
    s.pushCeiling.mockImplementation(async () => { t.deliver(reply); await new Promise(r => setTimeout(r, 0)); return 'ok'; });
    let r;
    await act(async () => { const p = s.hook.result.current.decide(s.a.id, 'once'); await vi.advanceTimersByTimeAsync(10); r = await p; });
    expect(r).toEqual({ sent: false, reason: 'already-decided' });
    expect(t.published).toHaveLength(0);
    expect(s.dropOnce).toHaveBeenCalled();
    expect(s.hook.result.current.asks).toHaveLength(0);
  });

  it('A37: an expired ask leaves the list on time and is never answerable', async () => {
    const s = await withAsk();
    clock += 601_000;
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(r).toEqual({ sent: false, reason: 'expired' });
    expect(t.published).toHaveLength(0);
    expect(s.pushCeiling).not.toHaveBeenCalled();
    expect(s.hook.result.current.asks).toHaveLength(0);
  });

  it('A37: the list drops an ask at its expiry without any action', async () => {
    const s = await withAsk();
    clock += 601_000;
    await flush(601_000);
    expect(s.hook.result.current.asks).toHaveLength(0);
  });
});

describe('useChildAsks — app-permission (D5)', () => {
  const ORIGIN = 'https://twang.example';
  const CLAIM = { permission: 'online-play' as const, name: 'Twang Thang', origin: ORIGIN, reason: 'To play online with others.' };
  const INSTALL = getPublicKey(generateSecretKey());
  const STATEMENT_TAGS = [['d', 'twang'], ['p', INSTALL], ['valid_from', '1800000000'], ['valid_until', '1800086400'], ['v', '1'], ['role', 'player'], ['expiration', '1800086400']];
  function permissionAsk(): ChildSignAsk {
    const nowS = Math.floor(clock / 1000);
    const id = (n++).toString(16).padStart(32, '0');
    return {
      v: 1, id, dependantId: dep.id.toLowerCase(), persona: PERSONA, scope: 'app-permission', kind: 30420, method: 'sign_event',
      target: `site:${ORIGIN}`, targetLabel: 'Twang Thang', appPermission: CLAIM,
      template: { kind: 30420, pubkey: PERSONA, created_at: nowS, tags: STATEMENT_TAGS, content: '' },
      createdAt: nowS, expiresAt: nowS + 600,
    };
  }
  async function withPermissionAsk(over: Partial<UseChildAsksOpts> = {}) {
    const s = setup(over);
    await flush();
    const a = permissionAsk();
    t.deliver(await askEv(a)); await flush();
    expect(s.hook.result.current.asks).toHaveLength(1);
    return { ...s, a };
  }
  it('the refusal has its own plain line, with no stage wording', () => {
    expect(CHILD_ASK_COPY.reasons['always-app-permission']).toBe('App permissions are asked for every time.');
  });
  const both = () => [{ kind: 30420, until: Math.floor(clock / 1000) + 600 }, { kind: 13, until: Math.floor(clock / 1000) + 600 }];

  for (const stage of ['request-approve', 'autonomous-alerts', 'autonomous-logging'] as const) {
    it(`${stage}: "Always" is refused, nothing saved, pushed or sent`, async () => {
      dep = makeDep({ autonomyStage: stage });
      const s = await withPermissionAsk();
      let r;
      await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'always'); });
      expect(r).toEqual({ sent: false, reason: 'always-app-permission' });
      expect(mSaveRule).not.toHaveBeenCalled();
      expect(s.pushCeiling).not.toHaveBeenCalled();
      expect(t.published).toHaveLength(0);
      expect(s.hook.result.current.asks).toHaveLength(1);
    });
  }

  it('full autonomy: remembers an exact bounded grant and opens only this answer seal', async () => {
    dep = makeDep({ autonomyStage: 'full-autonomy' });
    const s = await withPermissionAsk();
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'always'); });
    expect(r).toEqual({ sent: true });
    expect(mSaveRule.mock.calls[0][0]).toMatchObject({ scope: 'app-permission', persona: PERSONA, target: `site:${ORIGIN}`, appPermission: { v: 1, appId: 'twang', installKey: INSTALL }, expiresAt: 1800086400000 });
    expect(s.pushCeiling).toHaveBeenCalledWith(dep.id.toLowerCase(), { kind: 13, until: Math.floor(clock / 1000) + 600 });
    expect(await verdictOf(t.published[0].ev, s.a.id)).toMatchObject({ verdict: 'always', alsoOpened: [13] });
  });

  it('refuses to remember a stale or future-dated statement even at full autonomy', async () => {
    dep = makeDep({ autonomyStage: 'full-autonomy' });
    const s = await withPermissionAsk();
    clock += 301000;
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'always'); });
    expect(r).toEqual({ sent: false, reason: 'always-app-permission' });
    expect(mSaveRule).not.toHaveBeenCalled();
  });

  it('"Allow once" pushes approved-once for the 30420 AND the kind-13 seal, same window, in one push, before the verdict', async () => {
    const s = await withPermissionAsk();
    const order: string[] = [];
    s.pushCeiling.mockImplementation(async () => { order.push('push'); return 'ok'; });
    const pub = t.publish.bind(t);
    t.publish = async (ev, relays) => { order.push('publish'); return pub(ev, relays); };
    await act(async () => { await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(s.pushCeiling).toHaveBeenCalledTimes(1);
    expect(s.pushCeiling).toHaveBeenCalledWith(dep.id.toLowerCase(), both());
    expect(order).toEqual(['push', 'publish']);
    // Part B: the verdict reports the seal it opened.
    expect(await verdictOf(t.published[0].ev, s.a.id)).toMatchObject({ verdict: 'once', alsoOpened: [13] });
  });

  it('a failed push answers deny / device-unreachable (the pusher removed both entries)', async () => {
    const s = await withPermissionAsk();
    s.pushCeiling.mockResolvedValue('failed');
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(r).toEqual({ sent: true, reason: 'device-unreachable' });
    expect(await verdictOf(t.published[0].ev, s.a.id)).toMatchObject({ verdict: 'deny', reason: 'device-unreachable' });
  });

  it('a once whose verdict did not reach the child gives BOTH entries back', async () => {
    const s = await withPermissionAsk();
    t.ok = false;
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(r).toEqual({ sent: false, reason: 'publish-failed' });
    expect(s.dropOnce).toHaveBeenCalledWith(dep.id.toLowerCase(), both());
  });

  it('A5: when the ceiling cannot hold both kinds it is refused, nothing pushed', async () => {
    // request-approve lists 22242 and 21235 (venue entry is auto there); 61 kind rules make 63 — room for one more kind, not two.
    mListRules.mockResolvedValue(Array.from({ length: 61 }, (_, i) => ({
      id: String(i).padStart(32, '0'), dependantId: dep.id, persona: '*', scope: `kind:${40000 + i}`, target: '*', decision: 'allow' as const,
      createdAt: 1, updatedAt: 1 + i,
    })));
    const s = await withPermissionAsk();
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(r).toEqual({ sent: true, reason: 'ceiling-full' });
    expect(s.pushCeiling).not.toHaveBeenCalled();
    expect(await verdictOf(t.published[0].ev, s.a.id)).toMatchObject({ verdict: 'deny' });
  });

  it('"Always deny this" saves a deny rule on the app\'s origin for this scope', async () => {
    const s = await withPermissionAsk();
    await act(async () => { await s.hook.result.current.decide(s.a.id, 'deny', { alwaysDeny: true }); });
    expect(mSaveRule.mock.calls[0][0]).toMatchObject({ decision: 'deny', scope: 'app-permission', target: `site:${ORIGIN}`, persona: PERSONA });
    expect(await verdictOf(t.published[0].ev, s.a.id)).toMatchObject({ verdict: 'deny', alwaysDeny: true });
  });

  it('a 30420 ask without the claim (generic card): no "Always", and "Allow once" opens only its own kind — no seal', async () => {
    const s = setup();
    await flush();
    const a = { ...permissionAsk(), target: `app:${APP}` as const };
    delete (a as Partial<ChildSignAsk>).appPermission;
    t.deliver(await askEv(a)); await flush();
    let r;
    await act(async () => { r = await s.hook.result.current.decide(a.id, 'always'); });
    expect(r).toEqual({ sent: false, reason: 'always-app-permission' });
    await act(async () => { await s.hook.result.current.decide(a.id, 'once'); });
    expect(s.pushCeiling).toHaveBeenCalledTimes(1);
    expect(s.pushCeiling).toHaveBeenCalledWith(dep.id.toLowerCase(), { kind: 30420, until: Math.floor(clock / 1000) + 600 });
    expect((await verdictOf(t.published[0].ev, a.id))?.alsoOpened).toBeUndefined();
  });

  it('a claim whose template no longer passes the one-shape check: only its own kind, no seal', async () => {
    const s = setup();
    await flush();
    const a = permissionAsk();
    a.template = { ...a.template!, tags: STATEMENT_TAGS.map(t => (t[0] === 'role' ? ['role', 'admin'] : t)) };
    t.deliver(await askEv(a)); await flush();
    expect(s.hook.result.current.asks).toHaveLength(1);
    await act(async () => { await s.hook.result.current.decide(a.id, 'once'); });
    expect(s.pushCeiling).toHaveBeenCalledWith(dep.id.toLowerCase(), { kind: 30420, until: Math.floor(clock / 1000) + 600 });
  });
});

describe('useChildAsks — My Signet\'s own sign-in, marked (Part B)', () => {
  const ORIGIN = 'https://twang.example';
  function signInAsk(marked: boolean | undefined): ChildSignAsk {
    const nowS = Math.floor(clock / 1000);
    const id = (n++).toString(16).padStart(32, '0');
    return {
      v: 1, id, dependantId: dep.id.toLowerCase(), persona: PERSONA, scope: 'sign-in', kind: 21236, method: 'sign_event',
      target: `site:${ORIGIN}`, targetLabel: 'Twang Thang',
      template: { kind: 21236, pubkey: PERSONA, created_at: nowS, tags: [['challenge', 'c'.repeat(64)], ['origin', ORIGIN], ['app', 'Twang Thang']], content: '' },
      createdAt: nowS, expiresAt: nowS + 600, ...(marked === undefined ? {} : { signIn: { sharesHandle: marked } }),
    };
  }
  async function withAsk(marked: boolean | undefined, over: Partial<UseChildAsksOpts> = {}) {
    const s = setup(over);
    await flush();
    const a = signInAsk(marked);
    t.deliver(await askEv(a)); await flush();
    expect(s.hook.result.current.asks).toHaveLength(1);
    expect(s.hook.result.current.asks[0].ask.signIn).toEqual(marked === undefined ? undefined : { sharesHandle: marked });
    return { ...s, a };
  }
  const both = () => [{ kind: 21236, until: Math.floor(clock / 1000) + 600 }, { kind: 13, until: Math.floor(clock / 1000) + 600 }];

  for (const sharesHandle of [true, false]) {
    it(`marked (sharesHandle ${sharesHandle}): "Allow once" opens 21236 AND 13, same window, one push, before a verdict that says so`, async () => {
      const s = await withAsk(sharesHandle);
      const order: string[] = [];
      s.pushCeiling.mockImplementation(async () => { order.push('push'); return 'ok'; });
      const pub = t.publish.bind(t);
      t.publish = async (ev, relays) => { order.push('publish'); return pub(ev, relays); };
      let r;
      await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'once'); });
      expect(r).toEqual({ sent: true });
      expect(s.pushCeiling).toHaveBeenCalledTimes(1);
      expect(s.pushCeiling).toHaveBeenCalledWith(dep.id.toLowerCase(), both());
      expect(order).toEqual(['push', 'publish']);
      expect(await verdictOf(t.published[0].ev, s.a.id)).toEqual({ v: 1, id: s.a.id, verdict: 'once', alsoOpened: [13], decidedAt: Math.floor(clock / 1000) });
    });
  }

  it('the verdict with its alsoOpened is saved before it is published (A34)', async () => {
    const s = await withAsk(true);
    let savedAtPublish: unknown;
    const pub = t.publish.bind(t);
    t.publish = async (ev, relays) => { savedAtPublish = structuredClone(store.get('history')); return pub(ev, relays); };
    await act(async () => { await s.hook.result.current.decide(s.a.id, 'once'); });
    const row = (savedAtPublish as { ask: { id: string }; verdict: { alsoOpened?: number[] } }[]).find(e => e.ask.id === s.a.id);
    expect(row?.verdict.alsoOpened).toEqual([13]);
  });

  it('unmarked (an older child, or an outside app): today\'s single entry, and the verdict says nothing more', async () => {
    const s = await withAsk(undefined);
    await act(async () => { await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(s.pushCeiling).toHaveBeenCalledWith(dep.id.toLowerCase(), { kind: 21236, until: Math.floor(clock / 1000) + 600 });
    const v = await verdictOf(t.published[0].ev, s.a.id);
    expect(v).toMatchObject({ verdict: 'once' });
    expect(v?.alsoOpened).toBeUndefined();
  });

  it('M1: a marked ask without a site target (shown on the generic card) opens only 21236, and the verdict reports nothing more', async () => {
    const s = setup();
    await flush();
    const nowS = Math.floor(clock / 1000);
    const a: ChildSignAsk = {
      ...signInAsk(true), target: 'app:mysignet', targetLabel: 'My Signet',
      template: { kind: 21236, pubkey: PERSONA, created_at: nowS, tags: [['challenge', 'c'.repeat(64)]], content: '' },
    };
    t.deliver(await askEv(a)); await flush();
    expect(s.hook.result.current.asks).toHaveLength(1);
    expect(s.hook.result.current.asks[0].ask.signIn).toEqual({ sharesHandle: true });
    let r;
    await act(async () => { r = await s.hook.result.current.decide(a.id, 'once'); });
    expect(r).toEqual({ sent: true });
    expect(s.pushCeiling).toHaveBeenCalledTimes(1);
    expect(s.pushCeiling).toHaveBeenCalledWith(dep.id.toLowerCase(), { kind: 21236, until: nowS + 600 });
    const v = await verdictOf(t.published[0].ev, a.id);
    expect(v).toMatchObject({ verdict: 'once' });
    expect(v?.alsoOpened).toBeUndefined();
  });

  it('a failed push answers deny / device-unreachable — neither kind opened, nothing reported', async () => {
    const s = await withAsk(true);
    s.pushCeiling.mockResolvedValue('failed');
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(r).toEqual({ sent: true, reason: 'device-unreachable' });
    const v = await verdictOf(t.published[0].ev, s.a.id);
    expect(v).toMatchObject({ verdict: 'deny', reason: 'device-unreachable' });
    expect(v?.alsoOpened).toBeUndefined();
  });

  it('A5: when the ceiling cannot hold both kinds it is refused, nothing pushed', async () => {
    mListRules.mockResolvedValue(Array.from({ length: 61 }, (_, i) => ({
      id: String(i).padStart(32, '0'), dependantId: dep.id, persona: '*', scope: `kind:${40000 + i}`, target: '*', decision: 'allow' as const,
      createdAt: 1, updatedAt: 1 + i,
    })));
    const s = await withAsk(true);
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(r).toEqual({ sent: true, reason: 'ceiling-full' });
    expect(s.pushCeiling).not.toHaveBeenCalled();
    expect(await verdictOf(t.published[0].ev, s.a.id)).toMatchObject({ verdict: 'deny' });
  });

  it('a once that did not reach the child gives both back; "Send again" re-pushes both and reports the seal', async () => {
    const s = await withAsk(true);
    t.ok = false;
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(r).toEqual({ sent: false, reason: 'publish-failed' });
    expect(s.dropOnce).toHaveBeenCalledWith(dep.id.toLowerCase(), both());
    t.ok = true;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(r).toEqual({ sent: true });
    expect(s.pushCeiling).toHaveBeenCalledTimes(2);
    expect(s.pushCeiling).toHaveBeenLastCalledWith(dep.id.toLowerCase(), both());
    expect(await verdictOf(t.published[t.published.length - 1].ev, s.a.id)).toMatchObject({ verdict: 'once', alsoOpened: [13] });
  });

  it('"Send again" whose second push fails sends deny with no alsoOpened', async () => {
    const s = await withAsk(true);
    t.ok = false;
    await act(async () => { await s.hook.result.current.decide(s.a.id, 'once'); });
    t.ok = true;
    s.pushCeiling.mockResolvedValue('failed');
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(r).toEqual({ sent: true, reason: 'device-unreachable' });
    const v = await verdictOf(t.published[t.published.length - 1].ev, s.a.id);
    expect(v).toMatchObject({ verdict: 'deny', reason: 'device-unreachable' });
    expect(v?.alsoOpened).toBeUndefined();
  });

  /** The kinds a set of allow rules adds to the slot's ceiling (no approved-once entries). */
  const ruleKinds = (rs: ChildRule[]) => {
    const kinds = (rules: ChildRule[]) => compileChildDirectPolicy({
      stage: dep.autonomyStage, paused: false, rules, approvedOnceKinds: [], boundPersona: PERSONA,
      auditVisible: false, nowSeconds: Math.floor(clock / 1000),
    }).allowedKinds;
    const base = kinds([]);
    return kinds(rs).filter(k => !base.includes(k));
  };
  const once13 = () => ({ kind: 13, until: Math.floor(clock / 1000) + 600 });

  it('M6: marked "Always" saves a sign-in rule (21236 only) and, in the same push, ONE approved-once 13 — before a verdict that reports it', async () => {
    const s = await withAsk(true);
    const order: string[] = [];
    s.pushCeiling.mockImplementation(async () => { order.push('push'); return 'ok'; });
    const pub = t.publish.bind(t);
    t.publish = async (ev, relays) => { order.push('publish'); return pub(ev, relays); };
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'always'); });
    expect(r).toEqual({ sent: true });
    const rule = mSaveRule.mock.calls[0][0] as ChildRule;
    expect(rule).toMatchObject({ decision: 'allow', scope: 'sign-in', target: `site:${ORIGIN}`, persona: PERSONA });
    // The standing rule never makes 13 part of the ceiling: it adds 21236 alone.
    expect(ruleKinds([rule])).toEqual([21236]);
    expect(s.pushCeiling).toHaveBeenCalledTimes(1);
    expect(s.pushCeiling).toHaveBeenCalledWith(dep.id.toLowerCase(), once13());
    expect(order).toEqual(['push', 'publish']);
    expect(await verdictOf(t.published[0].ev, s.a.id)).toEqual({
      v: 1, id: s.a.id, verdict: 'always', ruleId: rule.id, alsoOpened: [13], decidedAt: Math.floor(clock / 1000),
    });
  });

  it('M6: unmarked "Always" is unchanged — the rule\'s own push, no seal, nothing reported', async () => {
    const s = await withAsk(undefined);
    await act(async () => { await s.hook.result.current.decide(s.a.id, 'always'); });
    expect(mSaveRule.mock.calls[0][0]).toMatchObject({ decision: 'allow', scope: 'sign-in', target: `site:${ORIGIN}` });
    expect(s.pushCeiling).toHaveBeenCalledTimes(1);
    expect(s.pushCeiling).toHaveBeenCalledWith(dep.id.toLowerCase());
    const v = await verdictOf(t.published[0].ev, s.a.id);
    expect(v).toMatchObject({ verdict: 'always' });
    expect(v?.alsoOpened).toBeUndefined();
  });

  it('M6: a failed push on a marked "Always" answers deny / device-unreachable, nothing reported', async () => {
    const s = await withAsk(true);
    s.pushCeiling.mockResolvedValue('failed');
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'always'); });
    expect(r).toEqual({ sent: true, reason: 'device-unreachable' });
    const v = await verdictOf(t.published[0].ev, s.a.id);
    expect(v).toMatchObject({ verdict: 'deny', reason: 'device-unreachable' });
    expect(v?.alsoOpened).toBeUndefined();
  });

  it('M6: A5 — a marked "Always" the ceiling cannot hold (with the seal) is refused; no rule, no push', async () => {
    mListRules.mockResolvedValue(Array.from({ length: 61 }, (_, i) => ({
      id: String(i).padStart(32, '0'), dependantId: dep.id, persona: '*', scope: `kind:${40000 + i}`, target: '*', decision: 'allow' as const,
      createdAt: 1, updatedAt: 1 + i,
    })));
    const s = await withAsk(true);
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'always'); });
    expect(r).toEqual({ sent: true, reason: 'ceiling-full' });
    expect(mSaveRule).not.toHaveBeenCalled();
    expect(s.pushCeiling).not.toHaveBeenCalled();
    expect((await verdictOf(t.published[0].ev, s.a.id))?.alsoOpened).toBeUndefined();
  });

  it('M6: a marked "Always" that did not reach the child gives the one-time 13 back; "Send again" re-pushes it and reports it', async () => {
    const s = await withAsk(true);
    t.ok = false;
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'always'); });
    expect(r).toEqual({ sent: false, reason: 'publish-failed' });
    expect(s.dropOnce).toHaveBeenCalledWith(dep.id.toLowerCase(), once13());
    t.ok = true;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'always'); });
    expect(r).toEqual({ sent: true });
    expect(s.pushCeiling).toHaveBeenCalledTimes(2);
    expect(s.pushCeiling).toHaveBeenLastCalledWith(dep.id.toLowerCase(), once13());
    expect(await verdictOf(t.published[t.published.length - 1].ev, s.a.id)).toMatchObject({ verdict: 'always', alsoOpened: [13] });
  });

  it('Deny is unchanged', async () => {
    const s = await withAsk(true);
    await act(async () => { await s.hook.result.current.decide(s.a.id, 'deny'); });
    expect(s.pushCeiling).not.toHaveBeenCalled();
    const v = await verdictOf(t.published[0].ev, s.a.id);
    expect(v).toMatchObject({ verdict: 'deny' });
    expect(v?.alsoOpened).toBeUndefined();
  });
});
