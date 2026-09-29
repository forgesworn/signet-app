// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import type { PairedChildRecord } from '../types';
import type { ChildRule } from '../types/child-rules';
import type { ChildRulesPayload } from '../lib/child-rules-wire';
import { buildVerdictEvent, openAskEvent, templateHash, type ChildSignVerdict } from '../lib/child-sign-asks';
import type { ChildActivityEntry } from '../lib/child-activity';
import {
  useChildGate, nextRequestCreatedAt, resetRequestCreatedAtForTests, CHILD_GATE_MAX_HELD, type ChildGateTransport,
} from './useChildGate';

const DEP = 'ef'.repeat(32);
const railSk = generateSecretKey(), railPriv = bytesToHex(railSk), railPub = getPublicKey(railSk);
const clientSk = generateSecretKey(), clientPriv = bytesToHex(clientSk), clientPub = getPublicKey(clientSk);
const PERSONA = getPublicKey(generateSecretKey());
const APP = 'a1'.repeat(32);
const NOW = 1_900_000_000_000;

function record(over: Partial<PairedChildRecord> = {}): PairedChildRecord {
  return {
    id: DEP, bunkerUri: `bunker://${PERSONA}?relay=wss%3A%2F%2Fhw.example`,
    clientKeypair: { publicKey: clientPub, privateKey: clientPriv },
    dependantPubkey: DEP, dependantName: 'Alice', pairedAt: 1, hasPaired: true,
    mode: 'heartwood-direct', railPubkey: railPub, personaPubkey: PERSONA,
    hwRelays: ['wss://hw.example'], railRelay: 'wss://rail.example', ...over,
  };
}

function rules(over: Partial<ChildRulesPayload> = {}): ChildRulesPayload {
  return { v: 1, dependantId: DEP, stage: 'request-approve', ceilingKinds: [1], rules: [], disconnectedApps: [], updatedAt: 1, ...over };
}

function allowApp(): ChildRule {
  return { id: 'b2'.repeat(16), dependantId: DEP, persona: '*', scope: '*', target: `app:${APP}`, decision: 'allow', createdAt: 1, updatedAt: 1 };
}

const note = (content = 'gg'): UnsignedEvent => ({ kind: 1, created_at: 1_899_999_000, tags: [], content, pubkey: '' });

function fakeTransport(publishOk = true) {
  const published: { ev: NostrEvent; relays: string[] }[] = [];
  const subs: { filters: { '#d'?: string[] }[]; relays: string[]; onEvent: (e: NostrEvent) => void; closed: boolean }[] = [];
  const t: ChildGateTransport = {
    publish: async (ev, relays) => { published.push({ ev, relays }); return { ok: publishOk, message: '' }; },
    subscribe: (filters, relays, onEvent) => {
      const s = { filters: filters as never, relays, onEvent, closed: false };
      subs.push(s);
      return () => { s.closed = true; };
    },
  };
  return { t, published, subs };
}

function setup(opts: { rules?: ChildRulesPayload | null; unpaired?: boolean; publishOk?: boolean; askTimeoutMs?: number } = {}) {
  const tr = fakeTransport(opts.publishOk);
  const clock = { t: NOW };
  const activity: ChildActivityEntry[] = [];
  const hook = renderHook((p: { unpaired: boolean; rules: ChildRulesPayload | null }) => useChildGate({
    record: record(), rules: p.rules, relays: ['wss://rail.example'], unpaired: p.unpaired,
    onActivity: (e) => activity.push(e), transport: tr.t, now: () => clock.t, askTimeoutMs: opts.askTimeoutMs,
  }), { initialProps: { unpaired: opts.unpaired ?? false, rules: opts.rules === undefined ? rules() : opts.rules } });
  return { ...tr, activity, hook, clock };
}

async function openLastAsk(published: { ev: NostrEvent }[]) {
  const ask = await openAskEvent(published[published.length - 1].ev, railPriv, {
    clientPubkey: clientPub, dependantId: DEP, personas: [PERSONA], nowS: Math.floor(NOW / 1000),
  });
  if (!ask) throw new Error('ask did not open');
  return ask;
}

async function sendVerdict(subs: ReturnType<typeof fakeTransport>['subs'], id: string, verdict: ChildSignVerdict['verdict']) {
  const ev = await buildVerdictEvent({ v: 1, id, verdict, decidedAt: Math.floor(NOW / 1000) }, railPriv, clientPub);
  const sub = subs.find(s => !s.closed && s.filters[0]['#d']?.[0]?.endsWith(id));
  if (!sub) throw new Error('no verdict subscription');
  await act(async () => { sub.onEvent(ev); await new Promise(r => setTimeout(r, 0)); });
}

beforeEach(() => resetRequestCreatedAtForTests());

describe('useChildGate', () => {
  it('an allow rule forwards at once with the persona on the template and a forced created_at', async () => {
    const s = setup({ rules: rules({ rules: [allowApp()] }) });
    let out: Awaited<ReturnType<typeof s.hook.result.current.authorise>> | undefined;
    await act(async () => {
      out = await s.hook.result.current.authorise({ persona: PERSONA, appId: APP, appLabel: 'Blocks', method: 'sign_event', template: note() });
    });
    expect(out).toMatchObject({ ok: true, requestCreatedAt: Math.floor(NOW / 1000) });
    expect(out!.ok && out!.template?.pubkey).toBe(PERSONA);
    expect(s.published).toHaveLength(0);
    expect(s.activity).toEqual([expect.objectContaining({ outcome: 'signed', persona: PERSONA, kind: 1, appId: APP, requestCreatedAt: Math.floor(NOW / 1000) })]);
  });

  it('asks the guardian on the rail relay and forwards after a once verdict, only the template it asked about', async () => {
    const s = setup();
    let p!: ReturnType<typeof s.hook.result.current.authorise>;
    act(() => { p = s.hook.result.current.authorise({ persona: PERSONA, appId: APP, appLabel: 'Blocks', method: 'sign_event', template: note('hello') }); });
    await waitFor(() => expect(s.published).toHaveLength(1));
    expect(s.published[0].relays).toEqual(['wss://rail.example']);
    const ask = await openLastAsk(s.published);
    expect(ask).toMatchObject({ persona: PERSONA, kind: 1, method: 'sign_event', target: `app:${APP}`, targetLabel: 'Blocks' });
    await waitFor(() => expect(s.hook.result.current.pendingAsks).toHaveLength(1));
    await sendVerdict(s.subs, ask.id, 'once');
    const out = await p;
    expect(out.ok).toBe(true);
    if (out.ok) expect(templateHash(out.template!)).toBe(ask.templateHash);
    expect(s.hook.result.current.pendingAsks).toHaveLength(0);
    expect(s.activity.map(a => a.outcome)).toEqual(['asked', 'approved']);
    expect(s.activity[1].requestCreatedAt).toBeGreaterThan(0);
  });

  it('a deny verdict is denied', async () => {
    const s = setup();
    let p!: ReturnType<typeof s.hook.result.current.authorise>;
    act(() => { p = s.hook.result.current.authorise({ persona: PERSONA, appId: APP, appLabel: 'Blocks', method: 'sign_event', template: note() }); });
    await waitFor(() => expect(s.published).toHaveLength(1));
    const ask = await openLastAsk(s.published);
    await sendVerdict(s.subs, ask.id, 'deny');
    expect(await p).toEqual({ ok: false, error: 'denied' });
    expect(s.activity.map(a => a.outcome)).toEqual(['asked', 'denied']);
  });

  it('an unanswered ask expires', async () => {
    const s = setup({ askTimeoutMs: 20 });
    let out: Awaited<ReturnType<typeof s.hook.result.current.authorise>> | undefined;
    await act(async () => {
      out = await s.hook.result.current.authorise({ persona: PERSONA, appId: APP, appLabel: 'Blocks', method: 'sign_event', template: note() });
    });
    expect(out).toEqual({ ok: false, error: 'expired' });
    expect(s.activity.map(a => a.outcome)).toEqual(['asked', 'expired']);
    expect(s.subs.every(x => x.closed)).toBe(true);
  });

  it('Review Focus 5: unpairing rejects a held ask with unpaired and forwards nothing', async () => {
    const s = setup();
    let p!: ReturnType<typeof s.hook.result.current.authorise>;
    act(() => { p = s.hook.result.current.authorise({ persona: PERSONA, appId: APP, appLabel: 'Blocks', method: 'sign_event', template: note() }); });
    await waitFor(() => expect(s.published).toHaveLength(1));
    const ask = await openLastAsk(s.published);
    s.hook.rerender({ unpaired: true, rules: rules() });
    expect(await p).toEqual({ ok: false, error: 'unpaired' });
    // A verdict arriving afterwards changes nothing.
    const stale = s.subs.find(x => x.filters[0]['#d']?.[0]?.endsWith(ask.id));
    expect(stale?.closed).toBe(true);
    let again: Awaited<typeof p> | undefined;
    await act(async () => {
      again = await s.hook.result.current.authorise({ persona: PERSONA, appId: APP, appLabel: 'Blocks', method: 'sign_event', template: note() });
    });
    expect(again).toEqual({ ok: false, error: 'unpaired' });
  });

  it(`holds at most ${CHILD_GATE_MAX_HELD} asks; the next is busy`, async () => {
    const s = setup();
    // One a minute, so the 10/min rate limit never trips.
    for (let i = 0; i < CHILD_GATE_MAX_HELD; i++) {
      s.clock.t += 61_000;
      act(() => { void s.hook.result.current.authorise({ persona: PERSONA, appId: 'nip55:com.game' + i, appLabel: 'Game', method: 'sign_event', template: note(String(i)) }); });
    }
    s.clock.t += 61_000;
    await waitFor(() => expect(s.hook.result.current.pendingAsks).toHaveLength(CHILD_GATE_MAX_HELD));
    let out: Awaited<ReturnType<typeof s.hook.result.current.authorise>> | undefined;
    await act(async () => {
      out = await s.hook.result.current.authorise({ persona: PERSONA, appId: 'nip55:com.late', appLabel: 'Late', method: 'sign_event', template: note('late') });
    });
    expect(out).toEqual({ ok: false, error: 'busy' });
  });

  it('Review Focus 4: with no rules at all it asks (fails closed), never signs', async () => {
    const s = setup({ rules: null, askTimeoutMs: 20 });
    let out: Awaited<ReturnType<typeof s.hook.result.current.authorise>> | undefined;
    await act(async () => {
      out = await s.hook.result.current.authorise({ persona: PERSONA, appId: APP, appLabel: 'Blocks', method: 'sign_event', template: note() });
    });
    expect(s.published).toHaveLength(1);
    expect(out).toEqual({ ok: false, error: 'expired' });
  });

  it('a deny rule and a disconnected app are denied without asking', async () => {
    const deny: ChildRule = { ...allowApp(), decision: 'deny' };
    const s = setup({ rules: rules({ rules: [deny] }) });
    let out: Awaited<ReturnType<typeof s.hook.result.current.authorise>> | undefined;
    await act(async () => {
      out = await s.hook.result.current.authorise({ persona: PERSONA, appId: APP, appLabel: 'Blocks', method: 'sign_event', template: note() });
    });
    expect(out).toEqual({ ok: false, error: 'denied' });
    expect(s.published).toHaveLength(0);
    expect(s.activity[0].outcome).toBe('denied');
  });

  it('a nip44 ask targets the peer with dm-private and no template', async () => {
    const s = setup();
    const peer = getPublicKey(generateSecretKey());
    act(() => { void s.hook.result.current.authorise({ persona: PERSONA, appId: APP, appLabel: 'Chat', method: 'nip44_decrypt', peer }); });
    await waitFor(() => expect(s.published).toHaveLength(1));
    const ask = await openLastAsk(s.published);
    expect(ask).toMatchObject({ method: 'nip44_decrypt', scope: 'dm-private', target: `peer:${peer}` });
    expect(ask.template).toBeUndefined();
  });

  it('wait:false raises the ask and returns at once (NIP-55 content provider)', async () => {
    const s = setup();
    let out: Awaited<ReturnType<typeof s.hook.result.current.authorise>> | undefined;
    await act(async () => {
      out = await s.hook.result.current.authorise({ persona: PERSONA, appId: 'nip55:com.game', appLabel: 'Game', method: 'sign_event', template: note(), wait: false });
    });
    expect(out).toEqual({ ok: false, error: 'asked' });
    expect(s.published).toHaveLength(1);
  });

  it('the caller-side rate limit denies the 11th request in a minute', async () => {
    const s = setup({ rules: rules({ rules: [allowApp()] }) });
    const outs: boolean[] = [];
    await act(async () => {
      for (let i = 0; i < 11; i++) {
        const o = await s.hook.result.current.authorise({ persona: PERSONA, appId: APP, appLabel: 'Blocks', method: 'sign_event', template: note(String(i)) });
        outs.push(o.ok);
      }
    });
    expect(outs.slice(0, 10).every(Boolean)).toBe(true);
    expect(outs[10]).toBe(false);
  });

  it('noteConnectedApp keeps one entry per app with firstSeen/lastUsed', async () => {
    const s = setup();
    act(() => {
      s.hook.result.current.noteConnectedApp({ appId: APP, kind: 'nip46', label: 'Blocks', persona: PERSONA, firstSeen: 10, lastUsed: 10 });
      s.hook.result.current.noteConnectedApp({ appId: APP, kind: 'nip46', label: 'Blocks 2', persona: PERSONA, firstSeen: 20, lastUsed: 20 });
    });
    expect(s.hook.result.current.connectedApps).toEqual([
      { appId: APP, kind: 'nip46', label: 'Blocks 2', persona: PERSONA, firstSeen: 10, lastUsed: 20 },
    ]);
  });
});

describe('nextRequestCreatedAt', () => {
  it('is at least now and strictly increasing per persona, independent across personas', () => {
    const a1 = nextRequestCreatedAt(PERSONA, NOW);
    const a2 = nextRequestCreatedAt(PERSONA, NOW);
    const a3 = nextRequestCreatedAt(PERSONA, NOW - 5000);
    expect(a1).toBe(Math.floor(NOW / 1000));
    expect(a2).toBe(a1 + 1);
    expect(a3).toBe(a2 + 1);
    expect(nextRequestCreatedAt('cd'.repeat(32), NOW)).toBe(Math.floor(NOW / 1000));
    expect(nextRequestCreatedAt(PERSONA, NOW + 60_000)).toBe(Math.floor(NOW / 1000) + 60);
  });
});

