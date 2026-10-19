// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import type { HeartwoodMgmtClient } from '../lib/heartwood-mgmt';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useHeartwoodOwner, type UseHeartwoodOwnerArgs } from './useHeartwoodOwner';
import { BunkerRequestTimeoutError, type BunkerSigningBackend } from '../lib/signing-backend';
import { FULL_ACCESS_COPY, pairWordsForClient } from '../lib/heartwood-one-hold';
import type { BunkerBackendRouter } from '../lib/bunker-router';

const listClientsMock = vi.hoisted(() => vi.fn());
const clearMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/heartwood-mgmt', async (orig) => ({
  ...(await orig<typeof import('../lib/heartwood-mgmt')>()),
  listClients: listClientsMock,
  clearClientIdentities: clearMock,
}));

const NP = 'a'.repeat(64);
const PERSONA = 'b'.repeat(64);
const MASTER = 'c'.repeat(64);
const CLIENT = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

function fakeBunker(handler: (method: string, params: string[], timeout?: number) => Promise<string>) {
  return { request: vi.fn(handler), transportClientPubkeyHex: CLIENT, activePublicKeyHex: MASTER } as unknown as BunkerSigningBackend & { request: ReturnType<typeof vi.fn> };
}
function fakeRouter(methods: string[]) {
  return { capabilities: { version: 1, methods } } as unknown as BunkerBackendRouter;
}
const ALL = ['sign_event', 'heartwood_approve_bundle', 'heartwood_owner_status', 'heartwood_owner_narrow'];
const ROUTER = fakeRouter(ALL);
const NO_BUNDLE_ROUTER = fakeRouter(['sign_event', 'heartwood_derive_persona']);

const NOOP = vi.fn();
function args(over: Partial<UseHeartwoodOwnerArgs> = {}): UseHeartwoodOwnerArgs {
  return {
    enabled: true, bunker: null, router: null, connected: true, operatorClient: null,
    naturalPersonPubkey: NP, personaPubkey: PERSONA, includeRealName: false,
    storedStyle: undefined, onStyleChange: NOOP, ...over,
  };
}

describe('useHeartwoodOwner', () => {
  it('sends nothing when the Heartwood does not list the bundle method', async () => {
    const bunker = fakeBunker(async () => '{}');
    const { result } = renderHook(() => useHeartwoodOwner(args({ bunker, router: NO_BUNDLE_ROUTER })));
    expect(result.current.supported).toBe(false);
    await act(async () => { await Promise.resolve(); });
    expect(bunker.request).not.toHaveBeenCalled();
  });

  it('is off on a paired-child / locked install', async () => {
    const bunker = fakeBunker(async () => '{}');
    const { result } = renderHook(() => useHeartwoodOwner(args({ enabled: false, bunker, router: ROUTER })));
    expect(result.current.supported).toBe(false);
    expect(bunker.request).not.toHaveBeenCalled();
  });

  it('is off without both pubkeys on file', () => {
    const bunker = fakeBunker(async () => '{}');
    const { result } = renderHook(() => useHeartwoodOwner(args({ bunker, router: ROUTER, personaPubkey: '' })));
    expect(result.current.supported).toBe(false);
  });

  it('asks heartwood_owner_status once when supported and reports it', async () => {
    const bunker = fakeBunker(async () => '{"owner":true,"style":"careful"}');
    const onStyleChange = vi.fn();
    const { result } = renderHook(() => useHeartwoodOwner(args({ bunker, router: ROUTER, onStyleChange })));
    expect(result.current.supported).toBe(true);
    await waitFor(() => expect(result.current.status).toEqual({ owner: true, style: 'careful' }));
    expect(bunker.request).toHaveBeenCalledTimes(1);
    expect(bunker.request.mock.calls[0][0]).toBe('heartwood_owner_status');
    expect(onStyleChange).toHaveBeenCalledWith('careful');
    expect(result.current.words).toHaveLength(5);
  });

  it('the five words come from the same client key that makes the requests', async () => {
    const reply = JSON.stringify({ v: 1, pubkeys: { 'natural-person': NP, persona: PERSONA }, act_as: ['persona'], owner: true, style: 'everyday' });
    const bunker = fakeBunker(async (m) => (m === 'heartwood_owner_status' ? '{"owner":false}' : reply));
    const { result } = renderHook(() => useHeartwoodOwner(args({ bunker, router: ROUTER })));
    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(result.current.words).toEqual(pairWordsForClient(bunker.transportClientPubkeyHex));
    expect(result.current.words).toEqual(['nice', 'never', 'repair', 'area', 'upgrade']);
    // The status probe and the bundle both go over that one signer.
    await act(async () => { await result.current.run('everyday'); });
    expect(bunker.request.mock.calls.map(c => c[0])).toEqual(['heartwood_owner_status', 'heartwood_approve_bundle']);
  });

  it('an unanswered status is unknown, not off', async () => {
    const bunker = fakeBunker(async () => { throw new Error('timeout'); });
    const { result } = renderHook(() => useHeartwoodOwner(args({ bunker, router: ROUTER, storedStyle: 'everyday' })));
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.status).toBeNull();
  });

  it('run sends create:false with expect = the pubkeys on file, and act_as persona only by default', async () => {
    const reply = JSON.stringify({ v: 1, pubkeys: { 'natural-person': NP, persona: PERSONA }, act_as: ['persona'], owner: true, style: 'everyday' });
    const bunker = fakeBunker(async (m) => (m === 'heartwood_owner_status' ? '{"owner":false,"style":"everyday"}' : reply));
    const onStyleChange = vi.fn();
    const { result } = renderHook(() => useHeartwoodOwner(args({ bunker, router: ROUTER, onStyleChange })));
    await waitFor(() => expect(result.current.status).toEqual({ owner: false, style: 'everyday' }));
    let out: Awaited<ReturnType<typeof result.current.run>> | undefined;
    await act(async () => { out = await result.current.run('everyday'); });
    expect(out?.ok).toBe(true);
    const call = bunker.request.mock.calls.find(c => c[0] === 'heartwood_approve_bundle')!;
    expect(JSON.parse(call[1][0])).toMatchObject({
      create: false, act_as: ['persona'], expect: { 'natural-person': NP, persona: PERSONA }, style: 'everyday',
    });
    expect(call[2]).toBe(140_000);
    // Review 3: the device's act_as echo is kept with the style.
    expect(onStyleChange).toHaveBeenCalledWith('everyday', ['persona']);
    expect(result.current.status).toEqual({ owner: true, style: 'everyday' });
  });

  it('act_as adds the real identity when it is in use (A10)', async () => {
    const reply = JSON.stringify({ v: 1, pubkeys: { 'natural-person': NP, persona: PERSONA }, act_as: ['natural-person', 'persona'], owner: true, style: 'careful' });
    const bunker = fakeBunker(async (m) => (m === 'heartwood_owner_status' ? '{"owner":false}' : reply));
    const onStyleChange = vi.fn();
    const { result } = renderHook(() => useHeartwoodOwner(args({ bunker, router: ROUTER, includeRealName: true, onStyleChange })));
    await waitFor(() => expect(result.current.status).not.toBeNull());
    await act(async () => { await result.current.run('careful'); });
    expect(onStyleChange).toHaveBeenCalledWith('careful', ['natural-person', 'persona']);
    const call = bunker.request.mock.calls.find(c => c[0] === 'heartwood_approve_bundle')!;
    expect(JSON.parse(call[1][0]).act_as).toEqual(['natural-person', 'persona']);
    expect(JSON.parse(call[1][0]).style).toBe('careful');
  });

  it('a pubkey mismatch stops with the keys-don\'t-match message and records nothing', async () => {
    const bunker = fakeBunker(async (m) => { if (m === 'heartwood_owner_status') return '{"owner":false}'; throw 'pubkey mismatch'; });
    const onStyleChange = vi.fn();
    const { result } = renderHook(() => useHeartwoodOwner(args({ bunker, router: ROUTER, onStyleChange })));
    await waitFor(() => expect(result.current.status).not.toBeNull());
    let out: Awaited<ReturnType<typeof result.current.run>> | undefined;
    await act(async () => { out = await result.current.run('everyday'); });
    expect(out).toMatchObject({ ok: false, failure: { code: 'pubkey-mismatch', message: 'Your Heartwood\'s keys don\'t match this phone\'s. Nothing was changed.' } });
    expect(onStyleChange).not.toHaveBeenCalled();
  });

  it('busy is true while a bundle is in flight and a second run is refused', async () => {
    let release!: (v: string) => void;
    const bunker = fakeBunker((m) => (m === 'heartwood_owner_status'
      ? Promise.resolve('{"owner":false}') : new Promise<string>(r => { release = r; })));
    const { result } = renderHook(() => useHeartwoodOwner(args({ bunker, router: ROUTER })));
    await waitFor(() => expect(result.current.status).not.toBeNull());
    let first!: Promise<unknown>;
    act(() => { first = result.current.run('everyday'); });
    await waitFor(() => expect(result.current.busy).toBe(true));
    let second: Awaited<ReturnType<typeof result.current.run>> | undefined;
    await act(async () => { second = await result.current.run('everyday'); });
    expect(second?.ok).toBe(false);
    expect(bunker.request.mock.calls.filter(c => c[0] === 'heartwood_approve_bundle')).toHaveLength(1);
    await act(async () => { release(JSON.stringify({ v: 1, pubkeys: { 'natural-person': NP, persona: PERSONA }, act_as: ['persona'], owner: true })); await first; });
    expect(result.current.busy).toBe(false);
  });

  it('narrow sends heartwood_owner_narrow and records Extra careful', async () => {
    const bunker = fakeBunker(async (m) => (m === 'heartwood_owner_status' ? '{"owner":true,"style":"everyday"}' : '{"style":"careful","changed":true}'));
    const onStyleChange = vi.fn();
    const { result } = renderHook(() => useHeartwoodOwner(args({ bunker, router: ROUTER, onStyleChange, storedStyle: 'everyday' })));
    await waitFor(() => expect(result.current.status?.owner).toBe(true));
    await act(async () => { await result.current.narrow(); });
    expect(bunker.request.mock.calls.some(c => c[0] === 'heartwood_owner_narrow')).toBe(true);
    expect(onStyleChange).toHaveBeenCalledWith('careful');
    expect(result.current.status).toEqual({ owner: true, style: 'careful' });
  });

  it('M2: turn off without an operator key says where to go and clears the style on file', async () => {
    const bunker = fakeBunker(async () => '{"owner":true,"style":"everyday"}');
    const onStyleChange = vi.fn();
    const { result } = renderHook(() => useHeartwoodOwner(args({ bunker, router: ROUTER, onStyleChange, storedStyle: 'everyday' })));
    await waitFor(() => expect(result.current.status?.owner).toBe(true));
    let out: Awaited<ReturnType<typeof result.current.turnOff>> | undefined;
    await act(async () => { out = await result.current.turnOff(); });
    expect(out).toEqual({ ok: false, message: FULL_ACCESS_COPY.sapwoodForget });
    expect(onStyleChange).toHaveBeenCalledWith(undefined);
  });

  describe('turn off with an operator key (review 1)', () => {
    const ownSlot = {
      slotIndex: 2, label: 'My Signet', secretFingerprint: 'fp', autoApprove: true, signingApproved: true,
      strictPermissions: false, currentPubkey: null, authorizedPubkeys: [CLIENT, 'e'.repeat(64)], allowedKinds: [],
      allowedMethods: ['sign_event'], escalate: false, petitionOnDeny: false, auditChildWrap: false, boundIdentity: null,
    };
    const operatorClient = { isOpen: true } as unknown as HeartwoodMgmtClient;
    function setup(statuses: string[]) {
      listClientsMock.mockResolvedValue([ownSlot]);
      clearMock.mockReset();
      clearMock.mockResolvedValue(undefined);
      let n = 0;
      const bunker = fakeBunker(async () => statuses[Math.min(n++, statuses.length - 1)]);
      const onStyleChange = vi.fn();
      const hook = renderHook(() => useHeartwoodOwner(args({ bunker, router: ROUTER, operatorClient, onStyleChange, storedStyle: 'everyday' })));
      return { bunker, onStyleChange, ...hook };
    }
    it('sends this phone\'s client key, and shows off only after the status is re-read as owner:false', async () => {
      const { result, onStyleChange, bunker } = setup(['{"owner":true,"style":"everyday"}', '{"owner":false,"style":"everyday"}']);
      await waitFor(() => expect(result.current.status?.owner).toBe(true));
      let out: Awaited<ReturnType<typeof result.current.turnOff>> | undefined;
      await act(async () => { out = await result.current.turnOff(); });
      expect(out).toEqual({ ok: true });
      expect(clearMock).toHaveBeenCalledTimes(1);
      expect(clearMock.mock.calls[0][1]).toEqual({ slotIndex: 2, secretFingerprint: 'fp' });
      expect(clearMock.mock.calls[0][2]).toBe(CLIENT);
      // The re-read went over the phone's own pairing.
      expect(bunker.request.mock.calls.filter(c => c[0] === 'heartwood_owner_status').length).toBeGreaterThanOrEqual(2);
      expect(result.current.status?.owner).toBe(false);
      expect(onStyleChange).toHaveBeenCalledWith(undefined);
    });
    it('a re-read that still says owner keeps "on", shows a plain error and keeps the style on file', async () => {
      const { result, onStyleChange } = setup(['{"owner":true,"style":"everyday"}']);
      await waitFor(() => expect(result.current.status?.owner).toBe(true));
      let out: Awaited<ReturnType<typeof result.current.turnOff>> | undefined;
      await act(async () => { out = await result.current.turnOff(); });
      expect(out).toMatchObject({ ok: false, message: FULL_ACCESS_COPY.turnOffUnconfirmed });
      expect(result.current.status?.owner).toBe(true);
      expect(onStyleChange).not.toHaveBeenCalledWith(undefined);
    });
    it('a re-read with no answer is not "off", and does not claim it is still on (S3)', async () => {
      const { result, bunker, onStyleChange } = setup(['{"owner":true,"style":"everyday"}']);
      await waitFor(() => expect(result.current.status?.owner).toBe(true));
      bunker.request.mockImplementation(async () => { throw new Error('timeout'); });
      let out: Awaited<ReturnType<typeof result.current.turnOff>> | undefined;
      await act(async () => { out = await result.current.turnOff(); });
      expect(out).toMatchObject({ ok: false, message: FULL_ACCESS_COPY.turnOffUnknown, status: null });
      // The line is asked again rather than left on a state the device never confirmed.
      await waitFor(() => expect(result.current.status).toBeNull());
      // The style on file is dropped, so a later owner:false reads as this
      // turn-off and not as "this phone no longer has full access".
      expect(onStyleChange).toHaveBeenCalledWith(undefined);
    });
    it('S2: unknown client credential re-reads the status and never sends a whole-slot clear', async () => {
      const { result, bunker } = setup(['{"owner":true,"style":"everyday"}']);
      await waitFor(() => expect(result.current.status?.owner).toBe(true));
      clearMock.mockRejectedValue(new Error('unknown client credential'));
      let out: Awaited<ReturnType<typeof result.current.turnOff>> | undefined;
      await act(async () => { out = await result.current.turnOff(); });
      expect(out?.ok).toBe(false);
      expect(clearMock).toHaveBeenCalledTimes(1);
      expect(clearMock.mock.calls.every(c => c[2] === CLIENT)).toBe(true);
      expect(bunker.request.mock.calls.filter(c => c[0] === 'heartwood_owner_status').length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('S1: the bundle is serialised with the family push (operator lock)', () => {
    const operatorClient = { isOpen: true } as unknown as HeartwoodMgmtClient;
    const reply = JSON.stringify({ v: 1, pubkeys: { 'natural-person': NP, persona: PERSONA }, act_as: ['persona'], owner: true, style: 'everyday' });
    it('does not send the bundle while a push holds the lock, and sends it once the push settles', async () => {
      const bunker = fakeBunker(async (m) => (m === 'heartwood_owner_status' ? '{"owner":false}' : reply));
      const { result } = renderHook(() => useHeartwoodOwner(args({ bunker, router: ROUTER, operatorClient })));
      await waitFor(() => expect(result.current.status).not.toBeNull());
      let releasePush!: () => void;
      let pushDone!: Promise<unknown>;
      // A family push already in flight: it holds the operator lock.
      const { withOperatorLock } = await import('../lib/operator-lock');
      pushDone = withOperatorLock(operatorClient, () => new Promise<void>((r) => { releasePush = r; }));
      let run!: Promise<unknown>;
      act(() => { run = result.current.run('everyday'); });
      await waitFor(() => expect(result.current.busy).toBe(true));
      await new Promise((r) => setTimeout(r, 30));
      expect(bunker.request.mock.calls.some(c => c[0] === 'heartwood_approve_bundle')).toBe(false);
      await act(async () => { releasePush(); await pushDone; await run; });
      expect(bunker.request.mock.calls.filter(c => c[0] === 'heartwood_approve_bundle')).toHaveLength(1);
    });
    it('holds the lock while the bundle waits, so a push cannot start until it settles', async () => {
      let release!: (v: string) => void;
      const bunker = fakeBunker((m) => (m === 'heartwood_owner_status'
        ? Promise.resolve('{"owner":false}') : new Promise<string>(r => { release = r; })));
      const { result } = renderHook(() => useHeartwoodOwner(args({ bunker, router: ROUTER, operatorClient })));
      await waitFor(() => expect(result.current.status).not.toBeNull());
      let run!: Promise<unknown>;
      act(() => { run = result.current.run('everyday'); });
      await waitFor(() => expect(bunker.request.mock.calls.some(c => c[0] === 'heartwood_approve_bundle')).toBe(true));
      const { withOperatorLock } = await import('../lib/operator-lock');
      let pushRan = false;
      const push = withOperatorLock(operatorClient, async () => { pushRan = true; });
      await new Promise((r) => setTimeout(r, 30));
      expect(pushRan).toBe(false);
      await act(async () => { release(reply); await run; await push; });
      expect(pushRan).toBe(true);
    });
  });

  it('W4: a custom style is shown as it is, and narrowing it changes nothing', async () => {
    const bunker = fakeBunker(async (m) => (m === 'heartwood_owner_status' ? '{"owner":true,"style":"custom"}' : '{"style":"custom","changed":false}'));
    const onStyleChange = vi.fn();
    const { result } = renderHook(() => useHeartwoodOwner(args({ bunker, router: ROUTER, onStyleChange })));
    await waitFor(() => expect(result.current.status).toEqual({ owner: true, style: 'custom' }));
    expect(onStyleChange).toHaveBeenCalledWith('custom');
    let out: Awaited<ReturnType<typeof result.current.narrow>> | undefined;
    await act(async () => { out = await result.current.narrow(); });
    expect(out).toMatchObject({ ok: false, style: 'custom' });
    expect(result.current.status).toEqual({ owner: true, style: 'custom' });
  });

  it('is awaiting the first status in the very render it becomes supported, and settles after the answer', async () => {
    const bunker = fakeBunker(async () => '{"owner":true,"style":"everyday"}');
    const { result } = renderHook(() => useHeartwoodOwner(args({ bunker, router: ROUTER })));
    expect(result.current.supported).toBe(true);
    expect(result.current.awaitingFirstStatus).toBe(true);
    expect(result.current.checking).toBe(true);
    await waitFor(() => expect(result.current.awaitingFirstStatus).toBe(false));
    expect(result.current.checking).toBe(false);
  });

  it('is never awaiting when unsupported', () => {
    const bunker = fakeBunker(async () => '{}');
    const { result } = renderHook(() => useHeartwoodOwner(args({ bunker, router: NO_BUNDLE_ROUTER })));
    expect(result.current.awaitingFirstStatus).toBe(false);
    expect(result.current.checking).toBe(false);
  });

  it('m3: after our own expiry the status is asked again, so a press that landed late shows as on', async () => {
    let statusCalls = 0;
    const bunker = fakeBunker(async (m) => {
      if (m === 'heartwood_owner_status') { statusCalls += 1; return statusCalls === 1 ? '{"owner":false}' : '{"owner":true,"style":"everyday"}'; }
      throw new BunkerRequestTimeoutError('heartwood_approve_bundle');
    });
    const { result } = renderHook(() => useHeartwoodOwner(args({ bunker, router: ROUTER })));
    await waitFor(() => expect(result.current.status).toEqual({ owner: false, style: 'everyday' }));
    let out: Awaited<ReturnType<typeof result.current.run>> | undefined;
    await act(async () => { out = await result.current.run('everyday'); });
    expect(out).toMatchObject({ ok: false, failure: { code: 'no-answer' } });
    await waitFor(() => expect(result.current.status).toEqual({ owner: true, style: 'everyday' }));
    expect(statusCalls).toBe(2);
  });

  it('m1: with an operator key it reads the methods listed on this phone\'s own pairing', async () => {
    listClientsMock.mockResolvedValue([{
      slotIndex: 2, label: 'My Signet', secretFingerprint: 'fp', autoApprove: true, signingApproved: true,
      strictPermissions: false, currentPubkey: null, authorizedPubkeys: [CLIENT], allowedKinds: [],
      allowedMethods: ['sign_event', 'heartwood_derive_persona'], escalate: false, petitionOnDeny: false,
      auditChildWrap: false, boundIdentity: null,
    }]);
    const operatorClient = { isOpen: true } as unknown as HeartwoodMgmtClient;
    const bunker = fakeBunker(async () => '{"owner":true,"style":"everyday"}');
    const { result } = renderHook(() => useHeartwoodOwner(args({ bunker, router: ROUTER, operatorClient })));
    await waitFor(() => expect(result.current.ownSlotMethods).toEqual(['sign_event', 'heartwood_derive_persona']));
    expect(result.current.label).toBe('My Signet');
  });

  it('m1: without an operator key the methods are unknown (null), never guessed', async () => {
    const bunker = fakeBunker(async () => '{"owner":true,"style":"everyday"}');
    const { result } = renderHook(() => useHeartwoodOwner(args({ bunker, router: ROUTER })));
    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(result.current.ownSlotMethods).toBeNull();
  });
});
