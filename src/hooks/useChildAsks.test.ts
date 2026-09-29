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

import { listChildRules, saveChildRule } from '../lib/db';
import { buildAskEvent, openVerdictEvent, type ChildSignAsk } from '../lib/child-sign-asks';
import { childRuleId } from '../lib/child-rules';
import { buildPersonaFirstDependant } from '../lib/dependant-record';
import type { ChildRule } from '../types/child-rules';
import type { DependantIdentity } from '../types';
import type { NostrEvent } from 'signet-protocol';
import { useChildAsks, type ChildAskTransport, type UseChildAsksOpts } from './useChildAsks';

const mListRules = vi.mocked(listChildRules), mSaveRule = vi.mocked(saveChildRule);
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
  const pushCeiling = vi.fn(async (_d: string, _k?: number): Promise<'ok' | 'failed'> => 'ok');
  const onRulesChanged = vi.fn();
  const onNewAsk = vi.fn();
  const props = (): UseChildAsksOpts => ({
    dependants: [dep], relays: ['wss://fallback.example.com'], encryptionKey: KEY, pushCeiling, onRulesChanged, onNewAsk,
    transport: t, now: () => clock, ...over,
  });
  const hook = renderHook(() => useChildAsks(props()));
  return { hook, pushCeiling, onRulesChanged, onNewAsk };
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
});
afterEach(() => { vi.useRealTimers(); });

describe('useChildAsks — inbox', () => {
  it('listens on the paired rail relay for the child client, addressed to the rail key', async () => {
    setup();
    await flush();
    expect(t.handlers).toHaveLength(1);
    expect(t.handlers[0].relays).toEqual([RELAY]);
    expect(t.handlers[0].filters[0]).toMatchObject({ kinds: [30078], authors: [CLIENT], '#p': [RAIL] });
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
    expect(s.pushCeiling).toHaveBeenCalledWith(dep.id.toLowerCase(), 30311);
    expect(order).toEqual(['push', 'publish']);
    expect(await verdictOf(t.published[0].ev, s.a.id)).toMatchObject({ verdict: 'once' });
  });

  it('a kind already inside the ceiling needs no push', async () => {
    mListRules.mockResolvedValue([{ id: '1'.repeat(32), dependantId: dep.id, persona: '*', scope: 'sign-in', target: '*', decision: 'allow', createdAt: 1, updatedAt: 1 }]);
    const a = ask({ scope: 'sign-in' }, 21236);
    const s = await withAsk({}, a);
    await act(async () => { await s.hook.result.current.decide(a.id, 'once'); });
    expect(s.pushCeiling).not.toHaveBeenCalled();
    expect(await verdictOf(t.published[0].ev, a.id)).toMatchObject({ verdict: 'once' });
  });

  it('pushCeiling failed → deny with device-unreachable, and the guardian is told', async () => {
    const s = await withAsk();
    s.pushCeiling.mockResolvedValue('failed');
    let r;
    await act(async () => { r = await s.hook.result.current.decide(s.a.id, 'once'); });
    expect(r).toEqual({ sent: true, reason: 'device-unreachable' });
    expect(await verdictOf(t.published[0].ev, s.a.id)).toMatchObject({ verdict: 'deny', reason: 'device-unreachable' });
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
});
