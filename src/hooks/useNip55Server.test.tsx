// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils.js';

const listeners: Record<string, Array<(r: unknown) => void>> = {};
type Answer = { id: string; status: string; event?: string; result?: string };
const respond = vi.fn(async (_answer: Answer) => {});
const pendingFromShell = vi.fn(async () => ({ requests: [] as unknown[] }));
const pageFrozen = vi.fn(async (_opts: { frozen: boolean }) => {});
vi.mock('../lib/native', () => ({
  isNativeApp: () => true,
  SignetNative: {
    addListener: vi.fn(async (name: string, cb: (r: unknown) => void) => {
      (listeners[name] ??= []).push(cb);
      return { remove: vi.fn(async () => {}) };
    }),
    nip55Pending: () => pendingFromShell(),
    nip55Respond: (answer: Answer) => respond(answer),
    nip55PageFrozen: (opts: { frozen: boolean }) => pageFrozen(opts),
    returnToPreviousApp: vi.fn(async () => {}),
  },
}));

import { useNip55Server } from './useNip55Server';
import { LocalSigningBackend } from '../lib/signing-backend';
import type { BunkerRoute } from './useBunkerServer';

const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const route: BunkerRoute = { pubkey, backend: new LocalSigningBackend(bytesToHex(sk)) };

function request(over: Record<string, unknown> = {}) {
  return { id: 'req-' + Math.random().toString(36).slice(2), callerPackage: 'dev.forgesworn.kithmoot', type: 'sign_event',
    payload: JSON.stringify({ kind: 20460, content: '', tags: [['d', 'room']], created_at: 1_800_000_000 }),
    peerPubkey: null, currentUser: null, permissions: null, viaProvider: false, ...over };
}

describe('useNip55Server', () => {
  beforeEach(() => { for (const k of Object.keys(listeners)) delete listeners[k]; respond.mockClear(); pendingFromShell.mockClear(); localStorage.clear(); });

  it('tells the shell when the page is frozen and resumed, and stops once unmounted', async () => {
    pageFrozen.mockClear();
    const { unmount } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey }));
    document.dispatchEvent(new Event('freeze'));
    expect(pageFrozen).toHaveBeenLastCalledWith({ frozen: true });
    document.dispatchEvent(new Event('resume'));
    expect(pageFrozen).toHaveBeenLastCalledWith({ frozen: false });
    unmount();
    document.dispatchEvent(new Event('freeze'));
    expect(pageFrozen).toHaveBeenCalledTimes(2);
  });

  it('asks, then signs with the owner backend on approval and answers the shell', async () => {
    const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey }));
    await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
    const raw = request();
    await act(async () => { listeners.nip55Request[0](raw); });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    expect(result.current.pending!.description).toBe('sign a kind 20460 event');
    expect(result.current.pending!.pubkey).toBe(pubkey);
    await act(async () => { result.current.approveOnce(result.current.pending!.handle); });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    const answer = respond.mock.calls[0][0];
    expect(answer.id).toBe(raw.id);
    expect(answer.status).toBe('ok');
    const event = JSON.parse(answer.event!);
    expect(event.pubkey).toBe(pubkey);
    expect(event.kind).toBe(20460);
    expect(verifyEvent(event)).toBe(true);
    expect(answer.result).toBe(event.sig);
    expect(result.current.pending).toBeNull();
  });

  it('tells the app each time a phone app is served, before the answer, and not for a refusal', async () => {
    const onServed = vi.fn();
    const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey, onServed }));
    await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
    await act(async () => { listeners.nip55Request[0](request()); });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    await act(async () => { result.current.deny(result.current.pending!.handle); });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(onServed).not.toHaveBeenCalled();
    await act(async () => { listeners.nip55Request[0](request()); });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    await act(async () => { result.current.approveOnce(result.current.pending!.handle); });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(onServed).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[1][0].status).toBe('ok');
  });

  it('allow always is remembered: the next provider query is answered silently, a stranger is deferred', async () => {
    const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey }));
    await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
    await act(async () => { listeners.nip55Request[0](request({ viaProvider: true })); });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond.mock.calls[0][0]).toMatchObject({ status: 'deferred' });

    await act(async () => { listeners.nip55Request[0](request()); });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    await act(async () => { result.current.approveAlways(result.current.pending!.handle); });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(respond.mock.calls[1][0]).toMatchObject({ status: 'ok' });
    expect(result.current.grants['dev.forgesworn.kithmoot']).toMatchObject({ pubkey, allowAlways: true });

    await act(async () => { listeners.nip55Request[0](request({ viaProvider: true })); });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(3));
    expect(respond.mock.calls[2][0]).toMatchObject({ status: 'ok' });
    expect(result.current.pending).toBeNull();

    await act(async () => { listeners.nip55Request[0](request({ viaProvider: true, callerPackage: 'com.other.app' })); });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(4));
    expect(respond.mock.calls[3][0]).toMatchObject({ status: 'deferred' });
  });

  it('get_public_key answers with the npub of the chosen key', async () => {
    const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey }));
    await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
    await act(async () => { listeners.nip55Request[0](request({ type: 'get_public_key', payload: null, permissions: JSON.stringify([{ type: 'sign_event', kind: 20460 }]) })); });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    expect(result.current.pending!.permissions).toEqual(['sign_event:20460']);
    await act(async () => { result.current.approveOnce(result.current.pending!.handle, pubkey); });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond.mock.calls[0][0]).toMatchObject({ status: 'ok', result: nip19.npubEncode(pubkey) });
  });

  it('a request while locked asks for the PIN and waits, and a malformed one is rejected', async () => {
    const onNeedsUnlock = vi.fn();
    const { result, rerender } = renderHook(({ locked }) => useNip55Server({ enabled: true, routes: locked ? [] : [route], locked, activePubkey: pubkey, onNeedsUnlock }), { initialProps: { locked: true } });
    await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
    await act(async () => { listeners.nip55Request[0](request()); });
    await waitFor(() => expect(onNeedsUnlock).toHaveBeenCalledTimes(1));
    expect(result.current.pending).toBeNull();
    expect(result.current.waiting).toBe(1);
    rerender({ locked: false });
    await waitFor(() => expect(result.current.pending).not.toBeNull());

    await act(async () => { listeners.nip55Request[0](request({ payload: 'not an event' })); });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond.mock.calls[0][0]).toMatchObject({ status: 'rejected' });
  });

  it('a request held through an unlock is answered silently when the app was allowed always', async () => {
    localStorage.setItem('signet.nip55.grants', JSON.stringify({ 'dev.forgesworn.kithmoot': { pubkey, allowAlways: true, denyAlways: false, grantedAt: 1 } }));
    const { result, rerender } = renderHook(({ locked }) => useNip55Server({ enabled: true, routes: locked ? [] : [route], locked, activePubkey: pubkey }), { initialProps: { locked: true } });
    await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
    await act(async () => { listeners.nip55Request[0](request()); });
    await waitFor(() => expect(result.current.waiting).toBe(1));
    rerender({ locked: false });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond.mock.calls[0][0]).toMatchObject({ status: 'ok' });
    expect(result.current.pending).toBeNull();
    expect(result.current.waiting).toBe(0);
  });

  it('an unlock whose keys arrive a render later neither refuses nor signs early', async () => {
    localStorage.setItem('signet.nip55.grants', JSON.stringify({ 'dev.forgesworn.kithmoot': { pubkey, allowAlways: true, denyAlways: false, grantedAt: 1 } }));
    const { result, rerender } = renderHook(({ locked, routes }) => useNip55Server({ enabled: true, routes, locked, activePubkey: pubkey }), { initialProps: { locked: true, routes: [] as BunkerRoute[] } });
    await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
    await act(async () => { listeners.nip55Request[0](request({ currentUser: pubkey })); });
    await waitFor(() => expect(result.current.waiting).toBe(1));
    rerender({ locked: false, routes: [] });
    await new Promise(r => setTimeout(r, 20));
    expect(respond).not.toHaveBeenCalled();
    expect(result.current.waiting).toBe(1);
    rerender({ locked: false, routes: [route] });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond.mock.calls[0][0]).toMatchObject({ status: 'ok' });
  });

  it('a request held through an unlock defaults to a key that has a route, not an unrouted active key', async () => {
    const otherSk = generateSecretKey();
    const unrouted = getPublicKey(otherSk);
    const { result, rerender } = renderHook(({ locked }) => useNip55Server({ enabled: true, routes: locked ? [] : [route], locked, activePubkey: unrouted }), { initialProps: { locked: true } });
    await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
    await act(async () => { listeners.nip55Request[0](request({ type: 'get_public_key', payload: null })); });
    await waitFor(() => expect(result.current.waiting).toBe(1));
    rerender({ locked: false });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    expect(result.current.pending!.pubkey).toBe(pubkey);
  });

  it('a held request whose remembered key has no route falls to a routed one', async () => {
    const unrouted = getPublicKey(generateSecretKey());
    localStorage.setItem('signet.nip55.grants', JSON.stringify({ 'dev.forgesworn.kithmoot': { pubkey: unrouted, allowAlways: false, denyAlways: false, grantedAt: 1 } }));
    const { result, rerender } = renderHook(({ locked }) => useNip55Server({ enabled: true, routes: locked ? [] : [route], locked, activePubkey: null }), { initialProps: { locked: true } });
    await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
    await act(async () => { listeners.nip55Request[0](request({ type: 'get_public_key', payload: null })); });
    await waitFor(() => expect(result.current.waiting).toBe(1));
    rerender({ locked: false });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    expect(result.current.pending!.pubkey).toBe(pubkey);
  });

  describe('held through an unlock', () => {
    const sk2 = generateSecretKey();
    const pubkey2 = getPublicKey(sk2);
    const route2: BunkerRoute = { pubkey: pubkey2, backend: new LocalSigningBackend(bytesToHex(sk2)) };
    const hold = async (raw: ReturnType<typeof request>, opts: { routes: BunkerRoute[]; active: string | null }) => {
      const view = renderHook(({ locked, routes }) => useNip55Server({ enabled: true, routes: locked ? [] : routes, locked, activePubkey: opts.active }),
        { initialProps: { locked: true, routes: opts.routes } });
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      await act(async () => { listeners.nip55Request[0](raw); });
      await waitFor(() => expect(view.result.current.waiting).toBe(1));
      view.rerender({ locked: false, routes: opts.routes });
      return view;
    };

    it('a sign_event naming a key shows and signs with exactly that key, not the default', async () => {
      const { result } = await hold(request({ currentUser: pubkey2 }), { routes: [route, route2], active: pubkey });
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      expect(result.current.pending!.pubkey).toBe(pubkey2);
      expect(result.current.pending!.named).toBe(true);
      await act(async () => { result.current.approveOnce(result.current.pending!.handle); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(JSON.parse(respond.mock.calls[0][0].event!).pubkey).toBe(pubkey2);
    });

    it('approving a named request with another key is refused, and nothing is remembered', async () => {
      const { result } = await hold(request({ currentUser: pubkey2 }), { routes: [route, route2], active: pubkey });
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      await act(async () => { result.current.approveAlways(result.current.pending!.handle, pubkey); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(respond.mock.calls[0][0].status).toBe('rejected');
      expect(result.current.grants['dev.forgesworn.kithmoot']).toBeUndefined();
    });

    it.each(['approveOnce', 'approveAlways'] as const)('%s with a key that has no owner route is refused, and nothing is remembered', async (approve) => {
      const unrouted = getPublicKey(generateSecretKey());
      const { result } = await hold(request(), { routes: [route], active: pubkey });
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      await act(async () => { result.current[approve](result.current.pending!.handle, unrouted); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(respond.mock.calls[0][0].status).toBe('rejected');
      expect(respond.mock.calls[0][0].event).toBeUndefined();
      expect(result.current.grants['dev.forgesworn.kithmoot']).toBeUndefined();
      expect(localStorage.getItem('signet.nip55.grants') ?? '{}').not.toContain(unrouted);
    });

    it.each(['approveOnce', 'approveAlways'] as const)('%s for a key routed when the request was fixed but gone by approval is refused, and nothing is remembered', async (approve) => {
      const view = await hold(request({ type: 'get_public_key', payload: null }), { routes: [route2, route], active: pubkey2 });
      await waitFor(() => expect(view.result.current.pending).not.toBeNull());
      expect(view.result.current.pending!.pubkey).toBe(pubkey2);
      // The device route for the shown key drops away before the person taps.
      view.rerender({ locked: false, routes: [route] });
      await act(async () => { view.result.current[approve](view.result.current.pending!.handle); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(respond.mock.calls[0][0].status).toBe('rejected');
      expect(view.result.current.grants['dev.forgesworn.kithmoot']).toBeUndefined();
      expect(localStorage.getItem('signet.nip55.grants') ?? '{}').not.toContain(pubkey2);
    });

    it('a named key with no route after the unlock is refused, never shown', async () => {
      const { result } = await hold(request({ type: 'nip44_encrypt', payload: 'hi', peerPubkey: pubkey, currentUser: pubkey2 }), { routes: [route], active: pubkey });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(respond.mock.calls[0][0].status).toBe('rejected');
      expect(result.current.pending).toBeNull();
      expect(result.current.waiting).toBe(0);
    });

    it('the default is fixed once shown: more keys arriving later do not switch it', async () => {
      const view = await hold(request({ type: 'get_public_key', payload: null }), { routes: [route2], active: pubkey });
      await waitFor(() => expect(view.result.current.pending).not.toBeNull());
      expect(view.result.current.pending!.pubkey).toBe(pubkey2);
      // The active key's route arrives (Heartwood reconnects).
      view.rerender({ locked: false, routes: [route2, route] });
      await waitFor(() => expect(view.result.current.pending).not.toBeNull());
      expect(view.result.current.pending!.pubkey).toBe(pubkey2);
    });

    it('allow always for a routed key still forwards silently after the unlock', async () => {
      localStorage.setItem('signet.nip55.grants', JSON.stringify({ 'dev.forgesworn.kithmoot': { pubkey: pubkey2, allowAlways: true, denyAlways: false, grantedAt: 1 } }));
      const { result } = await hold(request(), { routes: [route, route2], active: pubkey });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(respond.mock.calls[0][0].status).toBe('ok');
      expect(JSON.parse(respond.mock.calls[0][0].event!).pubkey).toBe(pubkey2);
      expect(result.current.pending).toBeNull();
    });

    it('allow always for a key with no route asks instead, with a routed key', async () => {
      const unrouted = getPublicKey(generateSecretKey());
      localStorage.setItem('signet.nip55.grants', JSON.stringify({ 'dev.forgesworn.kithmoot': { pubkey: unrouted, allowAlways: true, denyAlways: false, grantedAt: 1 } }));
      const { result } = await hold(request(), { routes: [route], active: null });
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      expect(result.current.pending!.pubkey).toBe(pubkey);
      expect(respond).not.toHaveBeenCalled();
    });
  });

  it('a key the app names that this phone does not hold is refused, never substituted', async () => {
    renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey }));
    await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
    await act(async () => { listeners.nip55Request[0](request({ currentUser: 'f'.repeat(64) })); });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond.mock.calls[0][0]).toMatchObject({ status: 'rejected' });
  });

  it('drains what the shell held while the page was down', async () => {
    pendingFromShell.mockResolvedValueOnce({ requests: [request({ viaProvider: true, callerPackage: 'x' })] });
    renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey }));
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond.mock.calls[0][0]).toMatchObject({ status: 'deferred' });
  });

  it('a request whose caller went away leaves the queue unanswered', async () => {
    const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey }));
    await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
    await waitFor(() => expect(listeners.nip55Withdrawn?.length).toBe(1));
    const raw = request();
    await act(async () => { listeners.nip55Request[0](raw); });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    const handle = result.current.pending!.handle;
    await act(async () => { listeners.nip55Withdrawn[0]({ id: raw.id }); });
    await waitFor(() => expect(result.current.pending).toBeNull());
    expect(respond).not.toHaveBeenCalled();
    await act(async () => { result.current.approveOnce(handle); });
    expect(respond).not.toHaveBeenCalled();
  });

  it('a request held through the PIN is dropped when withdrawn before the unlock', async () => {
    const onNeedsUnlock = vi.fn();
    const { result, rerender } = renderHook(({ locked }) => useNip55Server({ enabled: true, routes: locked ? [] : [route], locked, activePubkey: pubkey, onNeedsUnlock }), { initialProps: { locked: true } });
    await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
    await waitFor(() => expect(listeners.nip55Withdrawn?.length).toBe(1));
    const raw = request();
    await act(async () => { listeners.nip55Request[0](raw); });
    await waitFor(() => expect(onNeedsUnlock).toHaveBeenCalledTimes(1));
    expect(result.current.waiting).toBe(1);
    await act(async () => { listeners.nip55Withdrawn[0]({ id: raw.id }); });
    await waitFor(() => expect(result.current.waiting).toBe(0));
    rerender({ locked: false });
    await new Promise(r => setTimeout(r, 20));
    expect(result.current.pending).toBeNull();
    expect(respond).not.toHaveBeenCalled();
    // The same raw request re-delivered by the listener (e.g. a retained
    // event drained late) is ignored — the id is already in `seen`.
    await act(async () => { listeners.nip55Request[0](raw); });
    expect(result.current.pending).toBeNull();
    expect(respond).not.toHaveBeenCalled();
  });

  describe('child-direct gate (spec §8.3)', () => {
    it('an unknown app is decided by the gate, not the local screen, and signs the gate\'s template', async () => {
      const gate = vi.fn(async (req: { template?: { kind: number } }) => ({ ok: true as const, requestCreatedAt: 1_900_000_000, template: { ...req.template!, pubkey } as never }));
      const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey, gate }));
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      await act(async () => { listeners.nip55Request[0](request({ callerLabel: 'Kithmoot' })); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(result.current.pending).toBeNull();
      expect(gate).toHaveBeenCalledWith(expect.objectContaining({ persona: pubkey, appId: 'nip55:dev.forgesworn.kithmoot', appLabel: 'Kithmoot', method: 'sign_event', wait: true }));
      const answer = respond.mock.calls[0][0];
      expect(answer.status).toBe('ok');
      expect(verifyEvent(JSON.parse(answer.event!))).toBe(true);
    });

    it('a content-provider request never waits: an ask is rejected at once', async () => {
      const gate = vi.fn(async () => ({ ok: false as const, error: 'asked' as const }));
      renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey, gate }));
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      await act(async () => { listeners.nip55Request[0](request({ viaProvider: true })); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(gate).toHaveBeenCalledWith(expect.objectContaining({ wait: false }));
      expect(respond.mock.calls[0][0].status).toBe('rejected');
    });

    it('a gate refusal is rejected; get_public_key does not go through the gate', async () => {
      const gate = vi.fn(async () => ({ ok: false as const, error: 'denied' as const }));
      renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey, gate }));
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      await act(async () => { listeners.nip55Request[0](request()); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(respond.mock.calls[0][0].status).toBe('rejected');
      gate.mockClear();
      await act(async () => { listeners.nip55Request[0](request({ type: 'get_public_key', payload: null, viaProvider: true })); });
      expect(gate).not.toHaveBeenCalled();
    });
  });
});
