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
vi.mock('../lib/native', () => ({
  isNativeApp: () => true,
  SignetNative: {
    addListener: vi.fn(async (name: string, cb: (r: unknown) => void) => {
      (listeners[name] ??= []).push(cb);
      return { remove: vi.fn(async () => {}) };
    }),
    nip55Pending: () => pendingFromShell(),
    nip55Respond: (answer: Answer) => respond(answer),
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
