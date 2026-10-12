// @vitest-environment jsdom
// Tap mode of the guardian pairing: the offer and the request cross an NFC tap + Bluetooth link
// (in-memory fakes), every guardian check is the same code as in QR mode, and the child side runs
// the real `runChildDirectPairing` over the same link.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'signet-protocol';

vi.mock('../lib/heartwood-mgmt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/heartwood-mgmt')>();
  return { ...actual, nostrconnectV2: vi.fn(), listClients: vi.fn(), revokeClient: vi.fn() };
});
vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/db')>();
  return { ...actual, listChildRules: vi.fn(), saveChildRule: vi.fn() };
});

import { nostrconnectV2, listClients, revokeClient, type HeartwoodMgmtClient } from '../lib/heartwood-mgmt';
import { listChildRules, saveChildRule } from '../lib/db';
import type { DeviceClientSlot, DeviceStatus } from '../lib/heartwood-mgmt-types';
import { buildPersonaFirstDependant } from '../lib/dependant-record';
import { childDirectSlotLabel } from '../lib/policy-compiler';
import type { DependantIdentity } from '../types';
import { resetScanThrottleForTests } from '../lib/handshake-nearby';
import { ChildPairTap, LINK_ACK_TIMEOUT_MS } from '../lib/child-pair-tap';
import { writeChildPairCode } from '../lib/child-pair-nfc';
import { createHandshakeSession } from '../lib/handshake-reveal';
import { fakeNfcPhone, radio, tapTogether, type FakeNfcPhone, type FakeBluetooth } from '../lib/child-pair-tap-testkit';
import { awaitTapOffer, childTapDeps, runChildDirectPairing, ChildDirectPairError, type ChildDirectPairingDeps } from '../lib/child-direct-pairing';
import { CHILD_DEVICE_COPY } from '../lib/child-device-copy';
import { PAIR_REQUEST_MAX_AGE_S, useChildDevicePairing, type PairingTransport, type UseChildDevicePairingOpts } from './useChildDevicePairing';

const mMint = vi.mocked(nostrconnectV2), mList = vi.mocked(listClients), mRevoke = vi.mocked(revokeClient);
const mListRules = vi.mocked(listChildRules), mSaveRule = vi.mocked(saveChildRule);

const GUARDIAN = 'f'.repeat(64);
const RAIL_RELAY = 'wss://rail.example.com', HW_RELAY = 'wss://hw.example.com';
const STATUS: DeviceStatus = { capabilities: ['pairing_identity_v1', 'client_policy_flags_v1'], masterNpubHex: 'e'.repeat(64), truncated: false };
const operator = { isOpen: true } as unknown as HeartwoodMgmtClient;

function makeDep(): DependantIdentity {
  const npSk = generateSecretKey(), pSk = generateSecretKey();
  return buildPersonaFirstDependant({
    guardianPubkey: GUARDIAN, enteredName: 'Lily', derivationPath: 'dependant-0',
    naturalPerson: { publicKey: getPublicKey(npSk), privateKey: '' },
    persona: { publicKey: getPublicKey(pSk), privateKey: '' },
    createdAt: 1_700_000_000,
  });
}
function slot(over: Partial<DeviceClientSlot>): DeviceClientSlot {
  return { slotIndex: 0, label: 'x', secretFingerprint: 'f0', autoApprove: true, signingApproved: true, strictPermissions: true,
    currentPubkey: null, authorizedPubkeys: [], allowedKinds: [], allowedMethods: [], escalate: false, petitionOnDeny: false,
    auditChildWrap: false, boundIdentity: null, ...over };
}

/** A relay that records publishes and hands them to its subscribers (and on to another relay view). */
class Relay implements PairingTransport {
  handlers: ((ev: NostrEvent) => void)[] = [];
  filters: unknown[] = [];
  published: NostrEvent[] = [];
  forwardTo?: Relay;
  subscribe(filters: unknown[], _relays: string[], onEvent: (ev: NostrEvent) => void) {
    this.filters.push(...filters); this.handlers.push(onEvent);
    return () => { this.handlers = this.handlers.filter(h => h !== onEvent); };
  }
  async publish(ev: NostrEvent) {
    this.published.push(ev);
    setTimeout(() => { for (const h of [...(this.forwardTo?.handlers ?? [])]) h(ev); }, 0);
    return { ok: true, message: '' };
  }
}

let clock: number;
let dependant: DependantIdentity;
let guardianRelay: Relay, childRelay: Relay;
let gNfc: FakeNfcPhone, cNfc: FakeNfcPhone, gBt: FakeBluetooth, cBt: FakeBluetooth;
const nowS = () => Math.floor(clock / 1000);
const kit = () => ({ clock: () => clock });
void kit;

beforeEach(() => {
  clock = 1_800_000_000_000;
  guardianRelay = new Relay(); childRelay = new Relay(); guardianRelay.forwardTo = childRelay;
  const air = radio(); gBt = air.phone(); cBt = air.phone();
  gNfc = fakeNfcPhone(); cNfc = fakeNfcPhone();
  dependant = makeDep();
  resetScanThrottleForTests();
  mMint.mockReset(); mList.mockReset(); mRevoke.mockReset(); mListRules.mockReset(); mSaveRule.mockReset();
  mList.mockResolvedValue([]); mRevoke.mockResolvedValue(undefined); mListRules.mockResolvedValue([]); mSaveRule.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

function guardian() {
  const onDependantUpdated = vi.fn(async (d: DependantIdentity) => { dependant = d; });
  const awake = vi.fn();
  const props = (): UseChildDevicePairingOpts => ({
    dependant, operator, operatorStatus: STATUS, guardianNpPubkey: GUARDIAN, railRelay: RAIL_RELAY, hwRelays: [HW_RELAY],
    encryptionKey: 'k'.repeat(64), grants: [], onDependantUpdated, transport: guardianRelay, now: () => clock,
    nearby: { nfc: gNfc, native: gBt, nowMs: () => clock, awake },
  });
  const hook = renderHook(() => useChildDevicePairing(props()));
  return { hook, onDependantUpdated, awake };
}
type Guardian = ReturnType<typeof guardian>;
const phase = (g: Guardian) => g.hook.result.current.state.phase;

/** The guardian offers by tap; the child opens its own tap session; the phones touch and link. */
async function tapped() {
  const g = guardian();
  act(() => g.hook.result.current.start('tap'));
  await waitFor(() => expect(phase(g)).toBe('offer'));
  const childTap = new ChildPairTap(() => ({ nfc: cNfc, native: cBt, nowMs: () => clock, awake: vi.fn() }));
  await childTap.begin({ askToEnable: false });
  await act(async () => { tapTogether(gNfc, cNfc); });
  await waitFor(() => expect(g.hook.result.current.nearby.phase).toBe('linked'), { timeout: 4000 });
  await waitFor(() => expect(childTap.state.phase).toBe('linked'), { timeout: 4000 });
  return { g, childTap };
}

/** The child side: wait for the offer over the link, then run the real ceremony over the link + its relay. */
function childRun(childTap: ChildPairTap, opts: { onCheckWords?: (w: string[]) => void } = {}) {
  const words = vi.fn(opts.onCheckWords ?? (() => {}));
  const requestSent = vi.fn();
  const result = (async () => {
    const offer = await awaitTapOffer(childTap, nowS, { timeoutMs: 10_000 });
    const base: Pick<ChildDirectPairingDeps, 'subscribe'> = { subscribe: (f, r, cb) => childRelay.subscribe(f, r, cb) };
    const deps: ChildDirectPairingDeps = {
      ...childTapDeps(base, childTap),
      handshake: async () => 'bunker://persona?relay=wss%3A%2F%2Fhw.example.com',
      nowS,
    };
    return runChildDirectPairing(offer, deps, { onCheckWords: words, via: 'tap', timeoutMs: 15_000, onRequestSent: requestSent });
  })();
  result.catch(() => {});
  return { result, words, requestSent };
}

async function toConfirm() {
  const t = await tapped();
  const run = childRun(t.childTap);
  await waitFor(() => expect(phase(t.g)).toBe('confirm'), { timeout: 4000 });
  const st = t.g.hook.result.current.state;
  if (st.phase !== 'confirm') throw new Error('expected confirm');
  return { ...t, run, client: st.clientPubkey, confirmState: st };
}
function mintOk(client: string, persona: string) {
  const label = childDirectSlotLabel(dependant.id);
  mMint.mockImplementation(async (_op, req) => ({ slotIndex: 3, secretFingerprint: 'ab'.repeat(32), label: req.label, boundIdentity: persona }));
  mList.mockImplementation(async () => {
    const policy = mMint.mock.calls[0]?.[1].policy;
    return policy ? [slot({ slotIndex: 3, label, secretFingerprint: 'ab'.repeat(32), currentPubkey: client, boundIdentity: persona,
      allowedKinds: policy.allowedKinds, allowedMethods: policy.allowedMethods })] : [];
  });
}

describe('useChildDevicePairing - tap mode', () => {
  it('pairs end to end over the link: no relay subscription, no QR, one-tap confirm, reply over the link', async () => {
    const { g, childTap, run, client, confirmState } = await toConfirm();
    // Built exactly as for the QR: same offer URI, and the guardian never listened on the relay for requests.
    expect(guardianRelay.filters).toEqual([]);
    expect(confirmState.via).toBe('tap');
    expect(g.awake).toHaveBeenCalledWith(true);
    // The child showed no check words and knows its request was delivered.
    expect(run.words).not.toHaveBeenCalled();
    expect(run.requestSent).toHaveBeenCalledTimes(1);

    mintOk(client, dependant.persona.publicKey);
    await act(async () => { await g.hook.result.current.confirmMatch(); });
    const paired = await run.result;
    expect(g.hook.result.current.state).toEqual({ phase: 'paired', clientPubkey: client });
    expect(paired.clientKeypair.publicKey).toBe(client);
    expect(paired.personas.map(p => p.pubkey)).toContain(dependant.persona.publicKey);
    expect(mMint).toHaveBeenCalledTimes(1);
    expect(mMint.mock.calls[0][1].clientPubkey).toBe(client);
    // The reply travelled the link, so nothing was published on the rail relay.
    expect(guardianRelay.published).toEqual([]);
    // Everything is closed afterwards.
    await waitFor(() => expect(g.hook.result.current.nearby.phase).toBe('idle'));
    expect(gNfc.stopped).toBeGreaterThan(0);
    expect(g.awake).toHaveBeenLastCalledWith(false);
    childTap.end();
  });

  it('the offer is the same one the QR path would build (a fresh code, TTL and rail key)', async () => {
    const g = guardian();
    act(() => g.hook.result.current.start('tap'));
    await waitFor(() => expect(phase(g)).toBe('offer'));
    const tapOffer = g.hook.result.current.state;
    const q = guardian();
    act(() => q.hook.result.current.start());
    await waitFor(() => expect(phase(q)).toBe('offer'));
    const qrOffer = q.hook.result.current.state;
    if (tapOffer.phase !== 'offer' || qrOffer.phase !== 'offer') throw new Error('expected offers');
    expect(tapOffer.via).toBe('tap');
    expect(qrOffer.via).toBe('qr');
    const strip = (u: string) => u.replace(/code=[0-9a-f]+/, 'code=X');
    expect(strip(tapOffer.uri)).toBe(strip(qrOffer.uri));
    expect(tapOffer.expiresAt).toBe(qrOffer.expiresAt);
  });

  it('falls back to the rail relay with the SAME reply when the link is gone before the reply', async () => {
    const { g, childTap, run, client } = await toConfirm();
    mintOk(client, dependant.persona.publicKey);
    // The phones drop out of range / the screen goes off between the confirm and the reply.
    act(() => g.hook.result.current.nearby.end());
    await act(async () => { await g.hook.result.current.confirmMatch(); });
    const paired = await run.result;
    expect(paired.clientKeypair.publicKey).toBe(client);
    expect(guardianRelay.published).toHaveLength(1);
    expect(guardianRelay.published[0].kind).toBe(30078);
    expect(g.hook.result.current.state.phase).toBe('paired');
    childTap.end();
  });

  it('falls back to the relay when the link does not ACK within the timeout', async () => {
    const { g, childTap, run, client } = await toConfirm();
    mintOk(client, dependant.persona.publicKey);
    // Swallow the child's frames so the guardian's link send never gets an ACK.
    cBt.handlers = { ...cBt.handlers!, frame: () => {} };
    const timers: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      timers.push(ms ?? 0);
      return realSetTimeout(fn, ms === LINK_ACK_TIMEOUT_MS ? 50 : ms, ...rest);
    }) as typeof setTimeout);
    await act(async () => { await g.hook.result.current.confirmMatch(); });
    vi.restoreAllMocks();
    expect(timers).toContain(LINK_ACK_TIMEOUT_MS);
    expect(guardianRelay.published).toHaveLength(1);
    expect(g.hook.result.current.state.phase).toBe('paired');
    void run; childTap.end();
  });

  it('ignores a second tapped phone and says so; the first keeps the link', async () => {
    const { g, childTap } = await tapped();
    const other = writeChildPairCode(createHandshakeSession(), nowS());
    act(() => gNfc.hear(other));
    expect(g.hook.result.current.nearby.secondPhone).toBe(true);
    expect(g.hook.result.current.nearby.phase).toBe('linked');
    expect(phase(g)).toBe('offer');
    childTap.end();
  });

  it('an SGH2 tap is "wrong screen", and nothing links', async () => {
    const g = guardian();
    act(() => g.hook.result.current.start('tap'));
    await waitFor(() => expect(phase(g)).toBe('offer'));
    act(() => gNfc.hear('SGH2:ABCDEF'));
    expect(g.hook.result.current.nearby.wrongScreen).toBe('handshake');
    expect(g.hook.result.current.nearby.phase).toBe('waiting');
    expect(phase(g)).toBe('offer');
  });

  it('"They don\'t match" burns the code, tells the child over the link, and closes everything', async () => {
    const { g, childTap, run } = await toConfirm();
    await act(async () => { g.hook.result.current.rejectMatch(); });
    await expect(run.result).rejects.toMatchObject({ code: 'refused', reason: 'check-mismatch' });
    expect(g.hook.result.current.state).toEqual({ phase: 'aborted', reason: 'mismatch' });
    await act(async () => { await g.hook.result.current.confirmMatch(); });
    expect(mMint).not.toHaveBeenCalled();
    expect(guardianRelay.published).toEqual([]);
    await waitFor(() => expect(g.hook.result.current.nearby.phase).toBe('idle'));
    expect(gNfc.stopped).toBeGreaterThan(0);
    childTap.end();
  });

  it('a request older than 240 s at confirm is refused as stale in tap mode; nothing minted', async () => {
    const { g, childTap, run } = await toConfirm();
    clock += (PAIR_REQUEST_MAX_AGE_S + 1) * 1000;
    await act(async () => { await g.hook.result.current.confirmMatch(); });
    expect(mMint).not.toHaveBeenCalled();
    expect(g.hook.result.current.state).toEqual({ phase: 'error', message: CHILD_DEVICE_COPY.errors.stale });
    await expect(run.result).rejects.toMatchObject({ code: 'refused', reason: 'stale' });
    childTap.end();
  });

  it('a client key the Heartwood already knows is refused (client-reused) in tap mode', async () => {
    const { g, childTap, run, client } = await toConfirm();
    mList.mockResolvedValue([slot({ slotIndex: 1, label: 'other', secretFingerprint: '11'.repeat(32), authorizedPubkeys: [client] })]);
    await act(async () => { await g.hook.result.current.confirmMatch(); });
    expect(mMint).not.toHaveBeenCalled();
    expect(g.hook.result.current.state).toEqual({ phase: 'error', message: CHILD_DEVICE_COPY.errors.clientReused });
    await expect(run.result).rejects.toMatchObject({ code: 'refused', reason: 'client-reused' });
    childTap.end();
  });

  it('marks the code used before minting: a second confirm does not mint twice', async () => {
    const { g, childTap, run, client } = await toConfirm();
    mintOk(client, dependant.persona.publicKey);
    await act(async () => { await Promise.all([g.hook.result.current.confirmMatch(), g.hook.result.current.confirmMatch()]); });
    await run.result;
    expect(mMint).toHaveBeenCalledTimes(1);
    childTap.end();
  });

  it('cancel and unmount close the link and stop NFC', async () => {
    const { g, childTap } = await tapped();
    act(() => g.hook.result.current.cancel());
    expect(g.hook.result.current.nearby.phase).toBe('idle');
    expect(gNfc.stopped).toBeGreaterThan(0);
    expect(g.awake).toHaveBeenLastCalledWith(false);

    const h = guardian();
    act(() => h.hook.result.current.start('tap'));
    await waitFor(() => expect(phase(h)).toBe('offer'));
    const before = gNfc.stopped;
    h.hook.unmount();
    expect(gNfc.stopped).toBeGreaterThan(before);
    childTap.end();
  });

  it('the offer expiring ends the attempt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const g = guardian();
    act(() => g.hook.result.current.start('tap'));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(phase(g)).toBe('offer');
    await act(async () => { await vi.advanceTimersByTimeAsync(601_000); });
    expect(phase(g)).toBe('expired');
    expect(g.hook.result.current.nearby.phase).toBe('idle');
    expect(gNfc.stopped).toBeGreaterThan(0);
  });

  it('with NFC off, start("tap") errors cleanly and the QR path stays available', async () => {
    gNfc.statusValue = { supported: true, enabled: false };
    const g = guardian();
    await act(async () => { await g.hook.result.current.nearby.probe(); });
    expect(g.hook.result.current.nearby).toMatchObject({ available: false, reason: 'off' });
    act(() => g.hook.result.current.start('tap'));
    await waitFor(() => expect(phase(g)).toBe('error'));
    act(() => g.hook.result.current.start());
    await waitFor(() => expect(phase(g)).toBe('offer'));
    expect(g.hook.result.current.state).toMatchObject({ phase: 'offer', via: 'qr' });
    expect(guardianRelay.filters.length).toBe(1);
  });
});

describe('child tap deps', () => {
  it('a refused publish (no link) fails the request; a bad offer is refused; abort cancels', async () => {
    const dead = { sendEvent: async () => false, onEvent: () => () => {} };
    const deps = childTapDeps({ subscribe: () => () => {} }, dead);
    expect((await deps.publish({} as NostrEvent, [])).ok).toBe(false);

    const bad = { onOffer: (h: (u: string) => void) => { h('https://evil.example'); return () => {}; } };
    await expect(awaitTapOffer(bad, nowS)).rejects.toBeInstanceOf(ChildDirectPairError);
    const ac = new AbortController();
    const never = { onOffer: () => () => {} };
    const p = awaitTapOffer(never, nowS, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('link events are filtered by the subscription filter before reaching the reply handler', async () => {
    const handlers: ((e: NostrEvent) => void)[] = [];
    const channel = { sendEvent: async () => true, onEvent: (h: (e: NostrEvent) => void) => { handlers.push(h); return () => {}; } };
    const relayHandlers: unknown[] = [];
    const deps = childTapDeps({ subscribe: (_f, r, cb) => { relayHandlers.push([r, cb]); return () => {}; } }, channel);
    const got: NostrEvent[] = [];
    deps.subscribe([{ kinds: [30078], authors: ['a'.repeat(64)], '#d': ['d1'], '#p': ['p1'] }], ['wss://r.example'], e => got.push(e));
    const ev = (over: Partial<NostrEvent>): NostrEvent => ({ id: '1', pubkey: 'a'.repeat(64), sig: 's', kind: 30078, created_at: 1, tags: [['d', 'd1'], ['p', 'p1']], content: '', ...over });
    handlers[0](ev({}));
    handlers[0](ev({ pubkey: 'b'.repeat(64) }));
    handlers[0](ev({ tags: [['d', 'dX'], ['p', 'p1']] }));
    handlers[0](ev({ kind: 1 }));
    expect(got).toHaveLength(1);
    expect(relayHandlers).toHaveLength(1); // and the relay subscription is kept, for the fallback reply
  });
});
