// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';

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
import {
  buildChildPairRequestEvent, openChildPairReplyEvent, pairCheckWords, parseChildPairUri, pairRequestDTag, CHILD_PAIR_TTL_S,
} from '../lib/child-pair-wire';
import { buildPersonaFirstDependant } from '../lib/dependant-record';
import { childDirectSlotLabel } from '../lib/policy-compiler';
import type { DependantIdentity } from '../types';
import type { RememberedGrant } from '../types/grants';
import type { NostrEvent } from 'signet-protocol';
import { useChildDevicePairing, GRANTS_WAIT_MS, PAIR_REQUEST_MAX_AGE_S, STATUS_WAIT_MS, type PairingTransport, type UseChildDevicePairingOpts } from './useChildDevicePairing';
import { withOperatorLock } from '../lib/operator-lock';
import { CHILD_DEVICE_COPY } from '../lib/child-device-copy';

const mMint = vi.mocked(nostrconnectV2), mList = vi.mocked(listClients), mRevoke = vi.mocked(revokeClient);
const mListRules = vi.mocked(listChildRules), mSaveRule = vi.mocked(saveChildRule);

const GUARDIAN = 'f'.repeat(64);
const RAIL_RELAY = 'wss://rail.example.com', HW_RELAY = 'wss://hw.example.com';
const STATUS: DeviceStatus = { capabilities: ['pairing_identity_v1', 'client_policy_flags_v1'], masterNpubHex: 'e'.repeat(64), truncated: false };
const operator = { isOpen: true } as unknown as HeartwoodMgmtClient;

function makeDep(over: Partial<DependantIdentity> = {}): DependantIdentity {
  const npSk = generateSecretKey(), pSk = generateSecretKey();
  const d = buildPersonaFirstDependant({
    guardianPubkey: GUARDIAN, enteredName: 'Lily', derivationPath: 'dependant-0',
    naturalPerson: { publicKey: getPublicKey(npSk), privateKey: '' },
    persona: { publicKey: getPublicKey(pSk), privateKey: '' },
    createdAt: 1_700_000_000,
  });
  return { ...d, ...over };
}

function slot(over: Partial<DeviceClientSlot>): DeviceClientSlot {
  return { slotIndex: 0, label: 'x', secretFingerprint: 'f0', autoApprove: true, signingApproved: true, strictPermissions: true,
    currentPubkey: null, authorizedPubkeys: [], allowedKinds: [], allowedMethods: [], escalate: false, petitionOnDeny: false,
    auditChildWrap: false, boundIdentity: null, ...over };
}

class FakeTransport implements PairingTransport {
  handlers: ((ev: NostrEvent) => void)[] = [];
  filters: unknown[] = [];
  published: NostrEvent[] = [];
  unsubscribed = 0;
  subscribe(filters: unknown[], _relays: string[], onEvent: (ev: NostrEvent) => void) {
    this.filters.push(...filters);
    this.handlers.push(onEvent);
    return () => { this.unsubscribed++; this.handlers = this.handlers.filter(h => h !== onEvent); };
  }
  async publish(ev: NostrEvent) { this.published.push(ev); return { ok: true, message: '' }; }
  deliver(ev: NostrEvent) { for (const h of [...this.handlers]) h(ev); }
}

function child() {
  const sk = generateSecretKey();
  return { priv: bytesToHex(sk), pub: getPublicKey(sk) };
}
async function requestFrom(c: { priv: string; pub: string }, uri: string, nowS: number, codeOverride?: string) {
  const offer = parseChildPairUri(uri, nowS)!;
  const nostrconnect = `nostrconnect://${c.pub}?relay=${encodeURIComponent(HW_RELAY)}&secret=abcdef0123456789&name=My%20Signet`;
  return buildChildPairRequestEvent({ v: 1, code: codeOverride ?? offer.code, nostrconnect, clientPubkey: c.pub, createdAt: nowS }, c.priv, offer.rail);
}

let clock: number;
let t: FakeTransport;
let dependant: DependantIdentity;
let saved: DependantIdentity[];

function setup(over: Partial<UseChildDevicePairingOpts> = {}) {
  const onDependantUpdated = vi.fn(async (d: DependantIdentity) => { saved.push(d); dependant = d; });
  const props = (): UseChildDevicePairingOpts => ({
    dependant, operator, operatorStatus: STATUS, guardianNpPubkey: GUARDIAN, railRelay: RAIL_RELAY, hwRelays: [HW_RELAY],
    encryptionKey: 'k'.repeat(64), grants: [], onDependantUpdated, transport: t, now: () => clock, ...over,
  });
  const hook = renderHook(() => useChildDevicePairing(props()));
  return { hook, onDependantUpdated, rerender: () => hook.rerender() };
}
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_800_000_000_000;
  vi.setSystemTime(clock);
  t = new FakeTransport();
  dependant = makeDep();
  saved = [];
  mMint.mockReset(); mList.mockReset(); mRevoke.mockReset(); mListRules.mockReset(); mSaveRule.mockReset();
  mList.mockResolvedValue([]);
  mRevoke.mockResolvedValue(undefined);
  mListRules.mockResolvedValue([]);
  mSaveRule.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

async function toOffer(over: Partial<UseChildDevicePairingOpts> = {}) {
  const s = setup(over);
  act(() => s.hook.result.current.start());
  await flush();
  const st = s.hook.result.current.state;
  if (st.phase !== 'offer') throw new Error(`expected offer, got ${JSON.stringify(st)}`);
  return { ...s, uri: st.uri };
}

async function toConfirm() {
  const s = await toOffer();
  const c = child();
  t.deliver(await requestFrom(c, s.uri, Math.floor(clock / 1000)));
  await flush();
  return { ...s, c };
}

function mintOk(c: { pub: string }, persona: string) {
  const label = childDirectSlotLabel(dependant.id);
  mMint.mockImplementation(async (_op, req) => ({ slotIndex: 3, secretFingerprint: 'ab'.repeat(32), label: req.label, boundIdentity: persona }));
  return (policy: { allowedKinds: number[]; allowedMethods: string[] }) => slot({ slotIndex: 3, label, secretFingerprint: 'ab'.repeat(32),
    currentPubkey: c.pub, boundIdentity: persona, allowedKinds: policy.allowedKinds, allowedMethods: policy.allowedMethods });
}

describe('useChildDevicePairing — preconditions', () => {
  it('no operator key → blocked', async () => {
    const s = setup({ operator: null });
    act(() => s.hook.result.current.start()); await flush();
    expect(s.hook.result.current.state).toEqual({ phase: 'blocked', reason: 'no-operator-key' });
  });
  it('A20: a pending status probe shows checking, and offline only after 10 s', async () => {
    const s = setup({ operatorStatus: null });
    act(() => s.hook.result.current.start()); await flush();
    expect(s.hook.result.current.state).toEqual({ phase: 'checking' });
    await flush(STATUS_WAIT_MS - 1_000);
    expect(s.hook.result.current.state).toEqual({ phase: 'checking' });
    await flush(1_500);
    expect(s.hook.result.current.state).toEqual({ phase: 'blocked', reason: 'offline' });
  });
  it('A20: a status arriving while checking proceeds to the offer', async () => {
    let status: DeviceStatus | null = null;
    const s = setup({ get operatorStatus() { return status; } } as Partial<UseChildDevicePairingOpts>);
    act(() => s.hook.result.current.start()); await flush(500);
    expect(s.hook.result.current.state.phase).toBe('checking');
    status = STATUS; s.rerender();
    await flush(500);
    expect(s.hook.result.current.state.phase).toBe('offer');
  });
  it('A20: a failed probe shows offline at once', async () => {
    const s = setup({ operatorStatus: null, operatorStatusError: 'timeout' });
    act(() => s.hook.result.current.start()); await flush();
    expect(s.hook.result.current.state).toEqual({ phase: 'blocked', reason: 'offline' });
  });
  it('capability missing → device-unsupported', async () => {
    const s = setup({ operatorStatus: { ...STATUS, capabilities: ['client_policy_flags_v1'] } });
    act(() => s.hook.result.current.start()); await flush();
    expect(s.hook.result.current.state).toEqual({ phase: 'blocked', reason: 'device-unsupported' });
  });
  it('no usable persona → no-persona', async () => {
    dependant = makeDep();
    dependant = { ...dependant, persona: { ...dependant.persona, publicKey: '' } };
    const s = setup();
    act(() => s.hook.result.current.start()); await flush();
    expect(s.hook.result.current.state).toEqual({ phase: 'blocked', reason: 'no-persona' });
  });
  it('16 slots in use → slots-full with their labels', async () => {
    mList.mockResolvedValue(Array.from({ length: 16 }, (_, i) => slot({ slotIndex: i, label: `app-${i}` })));
    const s = setup();
    act(() => s.hook.result.current.start()); await flush();
    const st = s.hook.result.current.state;
    expect(st.phase).toBe('blocked');
    expect(st.phase === 'blocked' && st.reason).toBe('slots-full');
    expect(st.phase === 'blocked' && st.labels?.[15]).toBe('app-15');
  });
  it('list_clients failing → offline', async () => {
    mList.mockRejectedValue(new Error('timeout waiting for device (list_clients)'));
    const s = setup();
    act(() => s.hook.result.current.start()); await flush();
    expect(s.hook.result.current.state).toEqual({ phase: 'blocked', reason: 'offline' });
  });
  it('an invalid relay is refused before anything is shown', async () => {
    const s = setup({ hwRelays: ['http://nope.example.com'] });
    act(() => s.hook.result.current.start()); await flush();
    expect(s.hook.result.current.state.phase).toBe('error');
  });
});

describe('useChildDevicePairing — offer', () => {
  it('creates the rail key and renders a parsable signet-child URI; listens on the hashed d-tag', async () => {
    const { uri } = await toOffer();
    expect(saved[0].bunkerEndpoint?.publicKey).toMatch(/^[0-9a-f]{64}$/);
    const offer = parseChildPairUri(uri, Math.floor(clock / 1000))!;
    expect(offer).not.toBeNull();
    expect(offer.rail).toBe(saved[0].bunkerEndpoint!.publicKey);
    expect(offer.persona).toBe(dependant.persona.publicKey);
    expect(offer.guardian).toBe(GUARDIAN);
    expect(offer.hwRelays).toEqual([HW_RELAY]);
    expect(uri).not.toContain(saved[0].bunkerEndpoint!.privateKey);
    expect(t.filters[0]).toMatchObject({ '#d': [pairRequestDTag(offer.code)], '#p': [offer.rail] });
  });
  it('reuses an existing rail key', async () => {
    const sk = generateSecretKey();
    dependant = { ...dependant, bunkerEndpoint: { publicKey: getPublicKey(sk), privateKey: bytesToHex(sk), createdAt: 1 } };
    const { uri } = await toOffer();
    expect(saved).toHaveLength(0);
    expect(parseChildPairUri(uri, Math.floor(clock / 1000))!.rail).toBe(getPublicKey(sk));
  });
});

describe('useChildDevicePairing — request, check words, mint', () => {
  it('a valid request shows the check words; nothing is minted before "They match"', async () => {
    const s = await toConfirm();
    const st = s.hook.result.current.state;
    expect(st.phase).toBe('confirm');
    const offer = parseChildPairUri(s.uri, Math.floor(clock / 1000))!;
    expect(st.phase === 'confirm' && st.words).toEqual(pairCheckWords(offer.code, s.c.pub));
    expect(mMint).not.toHaveBeenCalled();
  });

  it('"They match" → nostrconnect_v2 with label/identity/compiled policy, then list_clients, then save, then reply', async () => {
    const s = await toConfirm();
    const persona = dependant.persona.publicKey;
    const listed = mintOk(s.c, persona);
    mList.mockImplementation(async () => {
      const policy = mMint.mock.calls[0]?.[1].policy;
      return policy ? [listed(policy)] : [];
    });
    await act(async () => { await s.hook.result.current.confirmMatch(); });
    expect(mMint).toHaveBeenCalledTimes(1);
    const req = mMint.mock.calls[0][1];
    expect(req.label).toBe(childDirectSlotLabel(dependant.id));
    expect(req.label.startsWith('signet:child-device:v2:')).toBe(true);
    expect(req.identity).toBe(persona);
    expect(req.clientPubkey).toBe(s.c.pub);
    expect(req.secret).toBe('abcdef0123456789');
    expect(req.relay).toBe(HW_RELAY);
    expect(req.policy.boundIdentity).toBe(persona);
    expect(req.policy.allowedKinds).toContain(22242);
    expect(req.policy.allowedMethods).toEqual(expect.arrayContaining(['sign_event', 'nip44_encrypt']));
    const last = saved[saved.length - 1];
    expect(last.childDevice).toMatchObject({ mode: 'heartwood-direct', slotIndex: 3, clientPubkey: s.c.pub, boundPersona: persona, slotLabel: req.label });
    expect(last.bunkerEndpoint?.authorizedClientPubkey).toBe(s.c.pub);
    expect(s.hook.result.current.state).toEqual({ phase: 'paired', clientPubkey: s.c.pub });
    const offer = parseChildPairUri(s.uri, Math.floor(clock / 1000))!;
    const reply = await openChildPairReplyEvent(t.published[0], s.c.priv, { code: offer.code, railPubkey: offer.rail });
    expect(reply?.ok).toBe(true);
    expect(reply?.personas.map(p => p.pubkey)).toContain(persona);
    expect(reply?.personas.map(p => p.pubkey)).not.toContain(dependant.naturalPerson.publicKey); // dormant NP
  });

  it('seeds rules from legacy grants BEFORE compiling the mint policy (A9)', async () => {
    const grant: RememberedGrant = { id: 'g1', dependantId: dependant.id, origin: 'https://game.example.com', scope: 'dm-private',
      decision: 'allow', decidedAt: 1_700_000_000 } as unknown as RememberedGrant;
    const s = await toOffer({ grants: [grant], dependant: { ...dependant, autonomyStage: 'request-approve' } as DependantIdentity });
    const c = child();
    t.deliver(await requestFrom(c, s.uri, Math.floor(clock / 1000)));
    await flush();
    mMint.mockRejectedValue(new Error('stop here'));
    await act(async () => { await s.hook.result.current.confirmMatch(); });
    expect(mSaveRule).toHaveBeenCalled();
    expect(mSaveRule.mock.invocationCallOrder[0]).toBeLessThan(mMint.mock.invocationCallOrder[0]);
  });

  it('a second request from the SAME phone is ignored', async () => {
    const s = await toConfirm();
    t.deliver(await requestFrom(s.c, s.uri, Math.floor(clock / 1000)));
    await flush();
    expect(s.hook.result.current.state.phase).toBe('confirm');
  });

  it('a second request from a DIFFERENT author aborts and burns the code (A3)', async () => {
    const s = await toConfirm();
    const other = child();
    t.deliver(await requestFrom(other, s.uri, Math.floor(clock / 1000)));
    await flush();
    expect(s.hook.result.current.state).toEqual({ phase: 'aborted', reason: 'two-requests' });
    await act(async () => { await s.hook.result.current.confirmMatch(); });
    expect(mMint).not.toHaveBeenCalled();
    expect(t.handlers).toHaveLength(0);
  });

  it('"They don\'t match" aborts, nothing minted, a later request is ignored', async () => {
    const s = await toConfirm();
    act(() => s.hook.result.current.rejectMatch());
    expect(s.hook.result.current.state).toEqual({ phase: 'aborted', reason: 'mismatch' });
    await act(async () => { await s.hook.result.current.confirmMatch(); });
    expect(mMint).not.toHaveBeenCalled();
    expect(t.handlers).toHaveLength(0);
  });

  it('an expired code is ignored and the offer expires', async () => {
    const s = await toOffer();
    const c = child();
    const ev = await requestFrom(c, s.uri, Math.floor(clock / 1000));
    clock += (CHILD_PAIR_TTL_S + 1) * 1000;
    t.deliver(ev);
    await flush();
    expect(s.hook.result.current.state.phase).not.toBe('confirm');
    await flush(CHILD_PAIR_TTL_S * 1000);
    expect(s.hook.result.current.state).toEqual({ phase: 'expired' });
  });

  it('a request for a different code is ignored', async () => {
    const s = await toOffer();
    const c = child();
    t.deliver(await requestFrom(c, s.uri, Math.floor(clock / 1000), '0'.repeat(32)));
    await flush();
    expect(s.hook.result.current.state.phase).toBe('offer');
  });

  it('mint error → error copy, nothing saved; reconciles and revokes an unconfirmed slot of ours (A4)', async () => {
    const s = await toConfirm();
    const label = childDirectSlotLabel(dependant.id);
    const stray = slot({ slotIndex: 5, label, secretFingerprint: 'cd'.repeat(32), currentPubkey: s.c.pub });
    const oldPhone = slot({ slotIndex: 2, label, secretFingerprint: 'ef'.repeat(32), currentPubkey: 'a'.repeat(64) });
    mMint.mockRejectedValue(new Error('timeout waiting for device (nostrconnect_v2)'));
    mList.mockResolvedValueOnce([oldPhone]).mockResolvedValue([stray, oldPhone]);
    const before = saved.length;
    await act(async () => { await s.hook.result.current.confirmMatch(); });
    expect(s.hook.result.current.state.phase).toBe('error');
    expect(saved.length).toBe(before);
    expect(mRevoke).toHaveBeenCalledTimes(1);
    expect(mRevoke.mock.calls[0][1]).toEqual({ slotIndex: 5, secretFingerprint: 'cd'.repeat(32) });
  });

  it('mint-mismatch-unrevoked carrying slotIndex → reconciles that slot', async () => {
    const s = await toConfirm();
    const label = childDirectSlotLabel(dependant.id);
    mMint.mockRejectedValue(Object.assign(new Error('heartwood-mint-mismatch-unrevoked'), { slotIndex: 7 }));
    mList.mockResolvedValue([slot({ slotIndex: 7, label, secretFingerprint: '77'.repeat(32), currentPubkey: null })]);
    await act(async () => { await s.hook.result.current.confirmMatch(); });
    expect(mRevoke.mock.calls[0][1]).toEqual({ slotIndex: 7, secretFingerprint: '77'.repeat(32) });
  });

  it('a minted slot that does not verify (wrong bound identity) is revoked; nothing saved (A9)', async () => {
    const s = await toConfirm();
    const persona = dependant.persona.publicKey;
    const listed = mintOk(s.c, persona);
    mList.mockImplementation(async () => {
      const policy = mMint.mock.calls[0]?.[1].policy;
      return policy ? [{ ...listed(policy), boundIdentity: 'a'.repeat(64) }] : [];
    });
    const before = saved.length;
    await act(async () => { await s.hook.result.current.confirmMatch(); });
    expect(s.hook.result.current.state.phase).toBe('error');
    expect(saved.length).toBe(before);
    expect(mRevoke.mock.calls[0][1]).toEqual({ slotIndex: 3, secretFingerprint: 'ab'.repeat(32) });
  });

  it('re-pair revokes the old slot only after the new one binds', async () => {
    const s = await toConfirm();
    const persona = dependant.persona.publicKey;
    const label = childDirectSlotLabel(dependant.id);
    const oldPhone = slot({ slotIndex: 2, label, secretFingerprint: 'ef'.repeat(32), currentPubkey: 'a'.repeat(64), boundIdentity: persona });
    const listed = mintOk(s.c, persona);
    mList.mockImplementation(async () => {
      const policy = mMint.mock.calls[0]?.[1].policy;
      return policy ? [oldPhone, listed(policy)] : [oldPhone];
    });
    await act(async () => { await s.hook.result.current.confirmMatch(); });
    expect(s.hook.result.current.state.phase).toBe('paired');
    expect(mRevoke).toHaveBeenCalledTimes(1);
    expect(mRevoke.mock.calls[0][1]).toEqual({ slotIndex: 2, secretFingerprint: 'ef'.repeat(32) });
    // After the mint and after the new slot was saved.
    expect(mRevoke.mock.invocationCallOrder[0]).toBeGreaterThan(mMint.mock.invocationCallOrder[0]);
    expect(saved[saved.length - 1].childDevice?.slotIndex).toBe(3);
  });
});

describe('useChildDevicePairing — amendments A23, A25, A28', () => {
  it('A23: a client key already on a slot is refused before minting (client-reused)', async () => {
    const s = await toConfirm();
    mList.mockResolvedValue([slot({ slotIndex: 1, label: 'other', secretFingerprint: '11'.repeat(32), authorizedPubkeys: [s.c.pub] })]);
    await act(async () => { await s.hook.result.current.confirmMatch(); });
    expect(mMint).not.toHaveBeenCalled();
    expect(s.hook.result.current.state).toEqual({ phase: 'error', message: CHILD_DEVICE_COPY.errors.clientReused });
    const offer = parseChildPairUri(s.uri, Math.floor(clock / 1000))!;
    const reply = await openChildPairReplyEvent(t.published[0], s.c.priv, { code: offer.code, railPubkey: offer.rail });
    expect(reply).toMatchObject({ ok: false, reason: 'client-reused' });
  });

  it('A23: the reconcile after a mint error never touches the CURRENT phone slot', async () => {
    const label = childDirectSlotLabel(dependant.id);
    const cur = { slotIndex: 7, secretFingerprint: '77'.repeat(32) };
    dependant = { ...dependant, childDevice: { mode: 'heartwood-direct', slotLabel: label, ...cur, clientPubkey: 'a'.repeat(64),
      boundPersona: dependant.persona.publicKey, pairedAt: 1 } };
    const s = await toConfirm();
    mMint.mockRejectedValue(Object.assign(new Error('heartwood-mint-mismatch-unrevoked'), { slotIndex: 7 }));
    mList.mockResolvedValueOnce([]).mockResolvedValue([slot({ slotIndex: 7, label, secretFingerprint: '77'.repeat(32), currentPubkey: null })]);
    await act(async () => { await s.hook.result.current.confirmMatch(); });
    expect(mRevoke).not.toHaveBeenCalled();
  });

  it('A28: a request older than 240 s at "They match" is refused as stale; nothing minted', async () => {
    const s = await toConfirm();
    clock += (PAIR_REQUEST_MAX_AGE_S + 1) * 1000;
    await act(async () => { await s.hook.result.current.confirmMatch(); });
    expect(mMint).not.toHaveBeenCalled();
    expect(s.hook.result.current.state).toEqual({ phase: 'error', message: CHILD_DEVICE_COPY.errors.stale });
    const offer = parseChildPairUri(s.uri, Math.floor((clock) / 1000))!;
    const reply = await openChildPairReplyEvent(t.published[0], s.c.priv, { code: offer.code, railPubkey: offer.rail });
    expect(reply).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('A28: a request 200 s old still mints', async () => {
    const s = await toConfirm();
    clock += 200_000;
    mMint.mockRejectedValue(new Error('stop here'));
    await act(async () => { await s.hook.result.current.confirmMatch(); });
    expect(mMint).toHaveBeenCalledTimes(1);
  });

  it('A25: stores railRelay, compiles from a FRESH read of the dependant', async () => {
    const readDependant = vi.fn(async () => ({ ...dependant, autonomyStage: 'full-autonomy' as const }));
    const s = await toOffer({ readDependant });
    const c = child();
    t.deliver(await requestFrom(c, s.uri, Math.floor(clock / 1000)));
    await flush();
    const persona = dependant.persona.publicKey;
    const listed = mintOk(c, persona);
    mList.mockImplementation(async () => {
      const policy = mMint.mock.calls[0]?.[1].policy;
      return policy ? [listed(policy)] : [];
    });
    await act(async () => { await s.hook.result.current.confirmMatch(); });
    expect(readDependant).toHaveBeenCalled();
    expect(mMint.mock.calls[0][1].policy.allowedKinds).toEqual([]); // full-autonomy from the fresh read
    expect(saved[saved.length - 1].childDevice).toMatchObject({ railRelay: RAIL_RELAY });
    expect(saved[saved.length - 1].childDevice?.seedPending).toBeUndefined();
  });

  it('A25: grants still null after 5 s → mints unseeded and marks seedPending', async () => {
    const s = await toOffer({ grants: null });
    const c = child();
    t.deliver(await requestFrom(c, s.uri, Math.floor(clock / 1000)));
    await flush();
    const persona = dependant.persona.publicKey;
    const listed = mintOk(c, persona);
    mList.mockImplementation(async () => {
      const policy = mMint.mock.calls[0]?.[1].policy;
      return policy ? [listed(policy)] : [];
    });
    let done = false;
    act(() => { void s.hook.result.current.confirmMatch().then(() => { done = true; }); });
    await flush(GRANTS_WAIT_MS + 500);
    expect(done).toBe(true);
    expect(mSaveRule).not.toHaveBeenCalled();
    expect(saved[saved.length - 1].childDevice?.seedPending).toBe(true);
  });
});

describe('useChildDevicePairing — unpair', () => {
  it('revokes the slot and clears childDevice + authorizedClientPubkey', async () => {
    dependant = { ...dependant, bunkerEndpoint: { publicKey: 'c'.repeat(64), privateKey: 'd'.repeat(64), createdAt: 1, authorizedClientPubkey: 'a'.repeat(64) },
      childDevice: { mode: 'heartwood-direct', slotLabel: childDirectSlotLabel(dependant.id), secretFingerprint: 'ab'.repeat(32), slotIndex: 4,
        clientPubkey: 'a'.repeat(64), boundPersona: dependant.persona.publicKey, pairedAt: 1 } };
    const clearChildDevice = vi.fn(async () => {});
    const s = setup({ clearChildDevice });
    await act(async () => { await s.hook.result.current.unpair(); });
    expect(mRevoke.mock.calls[0][1]).toEqual({ slotIndex: 4, secretFingerprint: 'ab'.repeat(32) });
    expect(clearChildDevice).toHaveBeenCalledWith(dependant.id);
    const last = saved[saved.length - 1];
    expect(last.childDevice).toBeUndefined();
    expect(last.bunkerEndpoint?.authorizedClientPubkey).toBeUndefined();
    expect(last.bunkerEndpoint?.publicKey).toBe('c'.repeat(64));
  });
  it('a device that cannot be reached leaves the record alone and rejects', async () => {
    dependant = { ...dependant, childDevice: { mode: 'heartwood-direct', slotLabel: 'l', secretFingerprint: 'ab'.repeat(32), slotIndex: 4,
      clientPubkey: 'a'.repeat(64), boundPersona: dependant.persona.publicKey, pairedAt: 1 } };
    mRevoke.mockRejectedValue(new Error('timeout waiting for device (revoke_client)'));
    mList.mockRejectedValue(new Error('timeout'));
    const s = setup();
    await expect(act(async () => { await s.hook.result.current.unpair(); })).rejects.toThrow();
    expect(saved).toHaveLength(0);
  });
});

describe('useChildDevicePairing — operator lock (A46)', () => {
  it('a policy push during the mint waits until the whole mint sequence completes', async () => {
    const s = await toConfirm();
    const persona = dependant.persona.publicKey;
    const listed = mintOk(s.c, persona);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const base = mMint.getMockImplementation()!;
    mMint.mockImplementation(async (op, req) => { order.push('mint:start'); await gate; const m = await base(op, req); order.push('mint:done'); return m; });
    mList.mockImplementation(async () => {
      const policy = mMint.mock.calls[0]?.[1].policy;
      return policy ? [listed(policy)] : [];
    });
    s.onDependantUpdated.mockImplementation(async (d: DependantIdentity) => { order.push('save'); saved.push(d); dependant = d; });
    let done!: Promise<void>;
    await act(async () => { done = s.hook.result.current.confirmMatch(); await vi.advanceTimersByTimeAsync(0); });
    expect(order).toEqual(['mint:start']);
    const push = withOperatorLock(operator, async () => { order.push('push'); });
    await flush(10);
    expect(order).toEqual(['mint:start']);
    release();
    await act(async () => { await done; await push; });
    expect(order).toEqual(['mint:start', 'mint:done', 'save', 'push']);
  });

  it('unpair is locked too', async () => {
    dependant = { ...dependant, bunkerEndpoint: { publicKey: 'c'.repeat(64), privateKey: 'd'.repeat(64), createdAt: 1, authorizedClientPubkey: 'a'.repeat(64) },
      childDevice: { mode: 'heartwood-direct', slotLabel: childDirectSlotLabel(dependant.id), secretFingerprint: 'ab'.repeat(32), slotIndex: 4,
        clientPubkey: 'a'.repeat(64), boundPersona: dependant.persona.publicKey, pairedAt: 1 } };
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    mRevoke.mockImplementation(async () => { order.push('revoke:start'); await gate; order.push('revoke:done'); });
    const s = setup({ clearChildDevice: async () => {} });
    let done!: Promise<void>;
    await act(async () => { done = s.hook.result.current.unpair(); await vi.advanceTimersByTimeAsync(0); });
    const push = withOperatorLock(operator, async () => { order.push('push'); });
    await flush(10);
    expect(order).toEqual(['revoke:start']);
    release();
    await act(async () => { await done; await push; });
    expect(order).toEqual(['revoke:start', 'revoke:done', 'push']);
  });
});
