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
import { buildPersonaFirstDependant } from '../lib/dependant-record';
import type { ChildRule } from '../types/child-rules';
import type { DependantIdentity } from '../types';
import type { NostrEvent } from 'signet-protocol';
import { useChildAsks, type ChildAskTransport, type UseChildAsksOpts } from './useChildAsks';

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
    expect(await verdictOf(t.published[0].ev, s.a.id)).toMatchObject({ verdict: 'once' });
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
