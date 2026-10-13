// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent, UnsignedEvent } from 'signet-protocol';
import type { PairedChildRecord } from '../types';
import type { ChildRule } from '../types/child-rules';
import type { ChildRulesPayload } from '../lib/child-rules-wire';
import { buildVerdictEvent, openAskEvent, type ChildSignVerdict } from '../lib/child-sign-asks';
import type { ChildActivityEntry } from '../lib/child-activity';
import { withRequestCreatedAt, type DecryptingSigningBackend } from '../lib/signing-backend';
import { useChildGate, resetRequestCreatedAtForTests, type ChildGateTransport } from './useChildGate';

const DEP = 'ef'.repeat(32);
const railSk = generateSecretKey(), railPriv = bytesToHex(railSk), railPub = getPublicKey(railSk);
const clientSk = generateSecretKey(), clientPriv = bytesToHex(clientSk), clientPub = getPublicKey(clientSk);
const PERSONA = getPublicKey(generateSecretKey());
const SESSION = getPublicKey(generateSecretKey());
const NOW = 1_900_000_000_000;
const ORIGIN = 'https://twang.example';
const CLAIM = { permission: 'online-play' as const, name: 'Twang Thang', origin: ORIGIN, reason: 'To play online with others.' };

function record(): PairedChildRecord {
  return {
    id: DEP, bunkerUri: `bunker://${PERSONA}?relay=wss%3A%2F%2Fhw.example`,
    clientKeypair: { publicKey: clientPub, privateKey: clientPriv },
    dependantPubkey: DEP, dependantName: 'Alice', pairedAt: 1, hasPaired: true,
    mode: 'heartwood-direct', railPubkey: railPub, personaPubkey: PERSONA,
    hwRelays: ['wss://hw.example'], railRelay: 'wss://rail.example',
  };
}
function rules(over: Partial<ChildRulesPayload> = {}): ChildRulesPayload {
  return { v: 1, dependantId: DEP, stage: 'request-approve', ceilingKinds: [1], rules: [], disconnectedApps: [], updatedAt: 1, ...over };
}
const statement = (): UnsignedEvent => ({
  kind: 30420, created_at: 1_899_999_000, content: '', pubkey: '',
  tags: [['d', 'twang'], ['p', SESSION], ['valid_from', '1899999000'], ['valid_until', '1900000000'], ['v', '1'], ['role', 'player'], ['expiration', '1900000000']],
});
const seal = (): UnsignedEvent => ({ kind: 13, created_at: 1_899_999_000, content: 'ciphertext', tags: [], pubkey: '' });

function setup(opts: { rules?: ChildRulesPayload | null; beforeStamp?: (p: string) => Promise<boolean>; publishOk?: boolean } = {}) {
  const published: { ev: NostrEvent }[] = [];
  const subs: { filters: { '#d'?: string[] }[]; onEvent: (e: NostrEvent) => void; closed: boolean }[] = [];
  const t: ChildGateTransport = {
    publish: async (ev) => { published.push({ ev }); return { ok: opts.publishOk !== false, message: '' }; },
    subscribe: (filters, _relays, onEvent) => {
      const s = { filters: filters as never, onEvent, closed: false };
      subs.push(s);
      return () => { s.closed = true; };
    },
  };
  const activity: ChildActivityEntry[] = [];
  const clock = { t: NOW };
  const hook = renderHook((p: { rules: ChildRulesPayload | null }) => useChildGate({
    record: record(), rules: p.rules, relays: ['wss://rail.example'], unpaired: false,
    onActivity: (e) => activity.push(e), transport: t, now: () => clock.t, beforeStamp: opts.beforeStamp,
  }), { initialProps: { rules: opts.rules === undefined ? rules() : opts.rules } });
  return { hook, published, subs, activity, clock };
}

async function lastAsk(published: { ev: NostrEvent }[]) {
  const a = await openAskEvent(published[published.length - 1].ev, railPriv, {
    clientPubkey: clientPub, dependantId: DEP, personas: [PERSONA], nowS: Math.floor(NOW / 1000),
  });
  if (!a) throw new Error('ask did not open');
  return a;
}
async function sendVerdict(subs: ReturnType<typeof setup>['subs'], id: string, verdict: ChildSignVerdict['verdict'], extra: Partial<ChildSignVerdict> = {}) {
  const ev = await buildVerdictEvent({ v: 1, id, verdict, decidedAt: Math.floor(NOW / 1000), ...extra }, railPriv, clientPub);
  const sub = subs.find(s => !s.closed && s.filters[0]['#d']?.[0]?.endsWith(id));
  if (!sub) throw new Error('no verdict subscription');
  await act(async () => { sub.onEvent(ev); await new Promise(r => setTimeout(r, 0)); });
}
const allowEverything = (): ChildRule => ({ id: 'b2'.repeat(16), dependantId: DEP, persona: '*', scope: '*', target: '*', decision: 'allow', createdAt: 1, updatedAt: 1 });

beforeEach(() => resetRequestCreatedAtForTests());

describe('useChildGate — app-permission asks (D4/D6)', () => {
  it('a 30420 with the claim asks the guardian on site:<origin>, even at full autonomy with an allow-all rule', async () => {
    const s = setup({ rules: rules({ stage: 'full-autonomy', ceilingKinds: [], rules: [allowEverything()] }) });
    let out: Awaited<ReturnType<typeof s.hook.result.current.authorise>> | undefined;
    let done: Promise<void> = Promise.resolve();
    await act(async () => {
      done = s.hook.result.current.authorise({
        persona: PERSONA, appId: 'mysignet', appLabel: 'Twang Thang', siteOrigin: ORIGIN, method: 'sign_event',
        template: statement(), appPermission: CLAIM,
      }).then((o) => { out = o; });
      await new Promise(r => setTimeout(r, 0));
    });
    expect(s.published).toHaveLength(1);
    const a = await lastAsk(s.published);
    expect(a).toMatchObject({ scope: 'app-permission', kind: 30420, target: `site:${ORIGIN}`, appPermission: CLAIM });
    expect(a.template?.pubkey).toBe(PERSONA);
    await sendVerdict(s.subs, a.id, 'once');
    await act(async () => { await done; });
    expect(out).toMatchObject({ ok: true });
    expect(out!.ok && out!.template?.kind).toBe(30420);
  });

  it('without the claim the 30420 still asks — a generic ask on the app', async () => {
    const s = setup({ rules: rules({ stage: 'full-autonomy', ceilingKinds: [] }) });
    await act(async () => {
      void s.hook.result.current.authorise({ persona: PERSONA, appId: 'mysignet', appLabel: 'My Signet', method: 'sign_event', template: statement() });
      await new Promise(r => setTimeout(r, 0));
    });
    const a = await lastAsk(s.published);
    expect(a).toMatchObject({ scope: 'app-permission', target: 'app:mysignet' });
    expect(a.appPermission).toBeUndefined();
  });

  it('a claim on any other request is ignored', async () => {
    const s = setup({ rules: rules({ ceilingKinds: [] }) });
    await act(async () => {
      void s.hook.result.current.authorise({ persona: PERSONA, appId: 'mysignet', appLabel: 'My Signet', method: 'sign_event', template: seal(), appPermission: CLAIM });
      await new Promise(r => setTimeout(r, 0));
    });
    const a = await lastAsk(s.published);
    expect(a.scope).toBe('dm-private');
    expect(a.appPermission).toBeUndefined();
  });

  it('a deny rule on the origin refuses at once, nothing asked', async () => {
    const deny: ChildRule = { id: 'c3'.repeat(16), dependantId: DEP, persona: PERSONA, scope: 'app-permission', target: `site:${ORIGIN}`, decision: 'deny', createdAt: 1, updatedAt: 1 };
    const s = setup({ rules: rules({ stage: 'full-autonomy', ceilingKinds: [], rules: [deny] }) });
    let out: unknown;
    await act(async () => {
      out = await s.hook.result.current.authorise({
        persona: PERSONA, appId: 'mysignet', appLabel: 'Twang Thang', siteOrigin: ORIGIN, method: 'sign_event', template: statement(), appPermission: CLAIM,
      });
    });
    expect(out).toEqual({ ok: false, error: 'denied' });
    expect(s.published).toHaveLength(0);
  });
});

describe('useChildGate.forwardPassed (D7)', () => {
  it('forwards without a decision: a kind 13 outside the ceiling at full-control is stamped, not asked', async () => {
    const s = setup({ rules: rules({ stage: 'full-control', ceilingKinds: [1] }) });
    let out: Awaited<ReturnType<typeof s.hook.result.current.forwardPassed>> | undefined;
    await act(async () => {
      out = await s.hook.result.current.forwardPassed({ persona: PERSONA, appId: 'mysignet', appLabel: 'My Signet', method: 'sign_event', template: seal() });
    });
    expect(out).toMatchObject({ ok: true, requestCreatedAt: Math.floor(NOW / 1000) });
    // A12: the persona is put on the template.
    expect(out!.ok && out!.template).toEqual({ ...seal(), pubkey: PERSONA });
    expect(s.published).toHaveLength(0);
  });

  it('forwards an encrypt (peer checked, no decision)', async () => {
    const s = setup({ rules: rules({ stage: 'full-control' }) });
    let out: unknown;
    await act(async () => {
      out = await s.hook.result.current.forwardPassed({ persona: PERSONA, appId: 'mysignet', appLabel: 'My Signet', method: 'nip44_encrypt', peer: SESSION });
    });
    expect(out).toMatchObject({ ok: true });
    let bad: unknown;
    await act(async () => {
      bad = await s.hook.result.current.forwardPassed({ persona: PERSONA, appId: 'mysignet', appLabel: 'My Signet', method: 'nip44_encrypt', peer: 'zz' });
    });
    expect(bad).toEqual({ ok: false, error: 'denied' });
  });

  it('keeps the preflight: a disconnected app and the rate limit refuse', async () => {
    const s = setup({ rules: rules({ disconnectedApps: ['mysignet'] }) });
    let out: unknown;
    await act(async () => {
      out = await s.hook.result.current.forwardPassed({ persona: PERSONA, appId: 'mysignet', appLabel: 'My Signet', method: 'sign_event', template: seal() });
    });
    expect(out).toEqual({ ok: false, error: 'denied' });
    expect(s.activity).toEqual([expect.objectContaining({ outcome: 'denied', kind: 13 })]);

    const r = setup({ rules: rules() });
    const outs: unknown[] = [];
    await act(async () => {
      for (let i = 0; i < 11; i++) {
        outs.push(await r.hook.result.current.forwardPassed({ persona: PERSONA, appId: 'mysignet', appLabel: 'My Signet', method: 'nip44_encrypt', peer: SESSION }));
      }
    });
    expect(outs.slice(0, 10).every(o => (o as { ok: boolean }).ok)).toBe(true);
    // I1: a local rate limit is not the guardian's "No".
    expect(outs[10]).toEqual({ ok: false, error: 'rate-limited' });
  });

  it('keeps the beforeStamp probe (a refused probe blocks) and the persona check', async () => {
    const probe = vi.fn(async () => false);
    const s = setup({ beforeStamp: probe });
    let out: unknown;
    await act(async () => {
      out = await s.hook.result.current.forwardPassed({ persona: PERSONA, appId: 'mysignet', appLabel: 'My Signet', method: 'sign_event', template: seal() });
    });
    expect(probe).toHaveBeenCalledWith(PERSONA);
    expect(out).toEqual({ ok: false, error: 'blocked' });
    let bad: unknown;
    await act(async () => {
      bad = await s.hook.result.current.forwardPassed({ persona: 'nope', appId: 'mysignet', appLabel: 'My Signet', method: 'sign_event', template: seal() });
    });
    expect(bad).toEqual({ ok: false, error: 'denied' });
  });

  it('stamps strictly increasing with authorise, and is recorded as approved once the Heartwood answers', async () => {
    const s = setup({ rules: rules({ stage: 'full-control' }) });
    const stamps: number[] = [];
    await act(async () => {
      for (let i = 0; i < 2; i++) {
        const o = await s.hook.result.current.forwardPassed({ persona: PERSONA, appId: 'mysignet', appLabel: 'My Signet', method: 'nip44_encrypt', peer: SESSION });
        if (o.ok) stamps.push(o.requestCreatedAt);
      }
    });
    expect(stamps[1]).toBe(stamps[0] + 1);
    expect(s.activity).toEqual([]);
    const heartwood = {
      activePublicKeyHex: PERSONA,
      stamped: () => ({ signEvent: async () => ({}) as never, nip44Encrypt: async () => 'x', nip44Decrypt: async () => 'x' }),
    } as unknown as DecryptingSigningBackend;
    await act(async () => { await withRequestCreatedAt(heartwood, stamps[0]).nip44Encrypt(SESSION, 'x'); });
    expect(s.activity).toEqual([expect.objectContaining({ outcome: 'approved', method: 'nip44_encrypt', persona: PERSONA, requestCreatedAt: stamps[0] })]);
  });
});

describe('useChildGate — only the guardian\'s own No is "denied" (I1)', () => {
  const ask = (s: ReturnType<typeof setup>, extra: { abort?: AbortSignal } = {}) => s.hook.result.current.authorise({
    persona: PERSONA, appId: 'mysignet', appLabel: 'Twang Thang', siteOrigin: ORIGIN, method: 'sign_event',
    template: statement(), appPermission: CLAIM, ...extra,
  });

  it('a guardian Deny is denied', async () => {
    const s = setup();
    let p!: ReturnType<typeof ask>;
    await act(async () => { p = ask(s); await new Promise(r => setTimeout(r, 0)); });
    await sendVerdict(s.subs, (await lastAsk(s.published)).id, 'deny');
    expect(await p).toEqual({ ok: false, error: 'denied' });
  });

  it('a guardian Allow whose device push failed (deny + device-unreachable) is device-unreachable', async () => {
    const s = setup();
    let p!: ReturnType<typeof ask>;
    await act(async () => { p = ask(s); await new Promise(r => setTimeout(r, 0)); });
    await sendVerdict(s.subs, (await lastAsk(s.published)).id, 'deny', { reason: 'device-unreachable' });
    expect(await p).toEqual({ ok: false, error: 'device-unreachable' });
  });

  it('a deny the guardian\'s phone sent because the ask ran out is expired', async () => {
    const s = setup();
    let p!: ReturnType<typeof ask>;
    await act(async () => { p = ask(s); await new Promise(r => setTimeout(r, 0)); });
    await sendVerdict(s.subs, (await lastAsk(s.published)).id, 'deny', { reason: 'expired' });
    expect(await p).toEqual({ ok: false, error: 'expired' });
  });

  it('an ask that could not be published is unsent, not denied', async () => {
    const s = setup({ publishOk: false });
    let out: unknown;
    await act(async () => { out = await ask(s); });
    expect(s.published).toHaveLength(1);
    expect(out).toEqual({ ok: false, error: 'unsent' });
  });

  it('the rate limit is rate-limited, not denied', async () => {
    const s = setup({ rules: rules({ disconnectedApps: [] }) });
    const outs: unknown[] = [];
    await act(async () => {
      for (let i = 0; i < 11; i++) {
        outs.push(await s.hook.result.current.authorise({ persona: PERSONA, appId: 'mysignet', appLabel: 'My Signet', method: 'nip44_decrypt', peer: SESSION, wait: false }));
      }
    });
    expect(outs[10]).toEqual({ ok: false, error: 'rate-limited' });
  });

  it('a matching "Always deny" rule is still denied at once', async () => {
    const deny: ChildRule = { id: 'c3'.repeat(16), dependantId: DEP, persona: '*', scope: 'app-permission', target: `site:${ORIGIN}`, decision: 'deny', createdAt: 1, updatedAt: 1 };
    const s = setup({ rules: rules({ rules: [deny] }) });
    let out: unknown;
    await act(async () => { out = await ask(s); });
    expect(out).toEqual({ ok: false, error: 'denied' });
    expect(s.published).toHaveLength(0);
  });
});

describe('useChildGate — withdrawing an ask (M2)', () => {
  const ask = (s: ReturnType<typeof setup>, abort: AbortSignal) => s.hook.result.current.authorise({
    persona: PERSONA, appId: 'mysignet', appLabel: 'Twang Thang', siteOrigin: ORIGIN, method: 'sign_event',
    template: statement(), appPermission: CLAIM, abort,
  });

  it('a held ask is withdrawn on abort, and a later Allow is never forwarded', async () => {
    const probe = vi.fn(async () => true);
    const s = setup({ beforeStamp: probe });
    const ctrl = new AbortController();
    let p!: ReturnType<typeof ask>;
    await act(async () => { p = ask(s, ctrl.signal); await new Promise(r => setTimeout(r, 0)); });
    const a = await lastAsk(s.published);
    const sub = s.subs.find(x => x.filters[0]['#d']?.[0]?.endsWith(a.id))!;
    await act(async () => { ctrl.abort(); await new Promise(r => setTimeout(r, 0)); });
    expect(await p).toEqual({ ok: false, error: 'withdrawn' });
    expect(sub.closed).toBe(true);
    expect(s.hook.result.current.pendingAsks).toEqual([]);
    expect(s.hook.result.current.askHistory[0]).toMatchObject({ id: a.id, state: 'withdrawn' });
    // The guardian's card may still be answered: nothing reaches the Heartwood.
    const ev = await buildVerdictEvent({ v: 1, id: a.id, verdict: 'once', decidedAt: Math.floor(NOW / 1000) }, railPriv, clientPub);
    await act(async () => { sub.onEvent(ev); await new Promise(r => setTimeout(r, 0)); });
    expect(probe).not.toHaveBeenCalled();
    expect(s.activity.map(e => e.outcome)).not.toContain('approved');
  });

  it('an already-withdrawn request asks nothing, and forwardPassed refuses it', async () => {
    const s = setup();
    const ctrl = new AbortController();
    ctrl.abort();
    let out: unknown;
    let passed: unknown;
    await act(async () => {
      out = await ask(s, ctrl.signal);
      passed = await s.hook.result.current.forwardPassed({ persona: PERSONA, appId: 'mysignet', appLabel: 'My Signet', method: 'nip44_encrypt', peer: SESSION, abort: ctrl.signal });
    });
    expect(out).toEqual({ ok: false, error: 'withdrawn' });
    expect(passed).toEqual({ ok: false, error: 'withdrawn' });
    expect(s.published).toHaveLength(0);
  });

  it('withdrawn while the approved request waits on the ALLOW AS probe: not forwarded', async () => {
    let release!: (v: boolean) => void;
    const probe = vi.fn(() => new Promise<boolean>(r => { release = r; }));
    const s = setup({ beforeStamp: probe });
    const ctrl = new AbortController();
    let p!: ReturnType<typeof ask>;
    await act(async () => { p = ask(s, ctrl.signal); await new Promise(r => setTimeout(r, 0)); });
    await sendVerdict(s.subs, (await lastAsk(s.published)).id, 'once');
    expect(probe).toHaveBeenCalledTimes(1);
    await act(async () => { ctrl.abort(); release(true); await new Promise(r => setTimeout(r, 0)); });
    expect(await p).toEqual({ ok: false, error: 'withdrawn' });
  });
});

