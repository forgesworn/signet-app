// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { encrypt as nip04Encrypt } from 'nostr-tools/nip04';
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
import * as db from '../lib/db';

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

  it('setAllowAlways changes a remembered app, lifts a refusal, and ignores an unknown app', async () => {
    localStorage.setItem('signet.nip55.grants', JSON.stringify({ 'dev.forgesworn.kithmoot': { pubkey, allowAlways: true, denyAlways: false, grantedAt: 1 }, 'dev.blocked': { pubkey, allowAlways: false, denyAlways: true, grantedAt: 1 } }));
    const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey }));
    act(() => { result.current.setAllowAlways('dev.forgesworn.kithmoot', false, pubkey); });
    expect(result.current.grants['dev.forgesworn.kithmoot']).toMatchObject({ allowAlways: false, denyAlways: false });
    expect(JSON.parse(localStorage.getItem('signet.nip55.grants')!)['dev.forgesworn.kithmoot'].allowAlways).toBe(false);
    act(() => { result.current.setAllowAlways('dev.blocked', false, pubkey); });
    expect(result.current.grants['dev.blocked']).toMatchObject({ allowAlways: false, denyAlways: false });
    act(() => { result.current.setAllowAlways('dev.unknown', true, pubkey); });
    expect(result.current.grants['dev.unknown']).toBeUndefined();
  });

  it('registers the native listeners once across re-renders when no clock is passed', async () => {
    const { rerender } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey }));
    await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
    pendingFromShell.mockClear();
    rerender();
    rerender();
    await new Promise(r => setTimeout(r, 20));
    expect(listeners.nip55Request.length).toBe(1);
    expect(pendingFromShell).not.toHaveBeenCalled();
  });

  it('notes when an allowed-always app was last served, at most once an hour', async () => {
    localStorage.setItem('signet.nip55.grants', JSON.stringify({ 'dev.forgesworn.kithmoot': { pubkey, allowAlways: true, denyAlways: false, grantedAt: 1 } }));
    let t = 10_000_000;
    const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey, now: () => t }));
    await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
    await act(async () => { listeners.nip55Request[0](request({ viaProvider: true })); });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(result.current.grants['dev.forgesworn.kithmoot'].lastUsedAt).toBe(10_000_000);
    expect(JSON.parse(localStorage.getItem('signet.nip55.grants')!)['dev.forgesworn.kithmoot'].lastUsedAt).toBe(10_000_000);
    t += 59 * 60 * 1000;
    await act(async () => { listeners.nip55Request[0](request({ viaProvider: true })); });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(result.current.grants['dev.forgesworn.kithmoot'].lastUsedAt).toBe(10_000_000);
    t += 2 * 60 * 1000;
    await act(async () => { listeners.nip55Request[0](request({ viaProvider: true })); });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(3));
    expect(result.current.grants['dev.forgesworn.kithmoot'].lastUsedAt).toBe(t);
    // Changing the setting keeps it.
    act(() => { result.current.setAllowAlways('dev.forgesworn.kithmoot', false, pubkey); });
    expect(result.current.grants['dev.forgesworn.kithmoot'].lastUsedAt).toBe(t);
  });

  it('setAllowAlways and forget leave a grant pinned to another identity unchanged', () => {
    const other = 'b'.repeat(64);
    localStorage.setItem('signet.nip55.grants', JSON.stringify({ 'dev.forgesworn.kithmoot': { pubkey: other, allowAlways: true, denyAlways: false, grantedAt: 1 } }));
    const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey }));
    let changed = true;
    act(() => { changed = result.current.setAllowAlways('dev.forgesworn.kithmoot', false, pubkey); });
    expect(changed).toBe(false);
    expect(result.current.grants['dev.forgesworn.kithmoot']).toMatchObject({ pubkey: other, allowAlways: true });
    let removed = true;
    act(() => { removed = result.current.forget('dev.forgesworn.kithmoot', pubkey); });
    expect(removed).toBe(false);
    expect(result.current.grants['dev.forgesworn.kithmoot']).toBeDefined();
    expect(JSON.parse(localStorage.getItem('signet.nip55.grants')!)['dev.forgesworn.kithmoot'].allowAlways).toBe(true);
    // The owning identity can still act on it.
    act(() => { removed = result.current.forget('dev.forgesworn.kithmoot', other); });
    expect(removed).toBe(true);
    expect(result.current.grants['dev.forgesworn.kithmoot']).toBeUndefined();
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

  describe('a request after the phone-apps window has ended', () => {
    const allowAlways = () => localStorage.setItem('signet.nip55.grants', JSON.stringify({ 'dev.forgesworn.kithmoot': { pubkey, allowAlways: true, denyAlways: false, grantedAt: 1 } }));

    it('by intent: drops the key first, then asks for the unlock instead of signing silently', async () => {
      allowAlways();
      const onKeyExpired = vi.fn();
      const onNeedsUnlock = vi.fn();
      const onServed = vi.fn();
      // As in the app: dropping the key locks it on the next render.
      const { result } = renderHook(() => {
        const [locked, setLocked] = useState(false);
        return useNip55Server({
          enabled: true, routes: locked ? [] : [route], locked, activePubkey: pubkey,
          keyExpired: () => !locked, onKeyExpired: () => { onKeyExpired(); setLocked(true); }, onNeedsUnlock, onServed,
        });
      });
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      await act(async () => { listeners.nip55Request[0](request()); });
      await waitFor(() => expect(onNeedsUnlock).toHaveBeenCalledTimes(1));
      expect(onKeyExpired).toHaveBeenCalledTimes(1);
      expect(onKeyExpired.mock.invocationCallOrder[0]).toBeLessThan(onNeedsUnlock.mock.invocationCallOrder[0]);
      expect(result.current.waiting).toBe(1);
      expect(respond).not.toHaveBeenCalled();
      expect(onServed).not.toHaveBeenCalled();
    });

    it('by provider: drops the key and sends the app to the intent, never answering with it', async () => {
      allowAlways();
      const onKeyExpired = vi.fn();
      renderHook(() => {
        const [locked, setLocked] = useState(false);
        return useNip55Server({
          enabled: true, routes: locked ? [] : [route], locked, activePubkey: pubkey,
          keyExpired: () => !locked, onKeyExpired: () => { onKeyExpired(); setLocked(true); },
        });
      });
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      await act(async () => { listeners.nip55Request[0](request({ viaProvider: true })); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(onKeyExpired).toHaveBeenCalledTimes(1);
      expect(respond.mock.calls[0][0]).toMatchObject({ status: 'deferred' });
    });

    it('inside the window an app allowed always is still answered without a screen', async () => {
      allowAlways();
      const onKeyExpired = vi.fn();
      renderHook(() => useNip55Server({
        enabled: true, routes: [route], locked: false, activePubkey: pubkey,
        keyExpired: () => false, onKeyExpired,
      }));
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      await act(async () => { listeners.nip55Request[0](request({ viaProvider: true })); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(respond.mock.calls[0][0]).toMatchObject({ status: 'ok' });
      expect(onKeyExpired).not.toHaveBeenCalled();
    });
  });

  it('declining the unlock refuses what was held for it at once, by intent back to the app', async () => {
    const onNeedsUnlock = vi.fn();
    const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [], locked: true, activePubkey: pubkey, onNeedsUnlock }));
    await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
    const first = request();
    const second = request();
    await act(async () => { listeners.nip55Request[0](first); listeners.nip55Request[0](second); });
    await waitFor(() => expect(result.current.waiting).toBe(2));
    await act(async () => { result.current.refuseHeld(); });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(respond.mock.calls.map(c => c[0])).toEqual([{ id: first.id, status: 'rejected' }, { id: second.id, status: 'rejected' }]);
    expect(result.current.waiting).toBe(0);
  });

  it('refusing held requests does nothing once unlocked', async () => {
    const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey }));
    await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
    await act(async () => { listeners.nip55Request[0](request()); });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    await act(async () => { result.current.refuseHeld(); });
    expect(result.current.pending).not.toBeNull();
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

  describe('nip04_decrypt (older-format messages)', () => {
    const peerSk = generateSecretKey();
    const peer = getPublicKey(peerSk);
    const sealed = (text: string, to = pubkey) => nip04Encrypt(peerSk, to, text);
    const decryptRequest = (over: Record<string, unknown> = {}) => request({ type: 'nip04_decrypt', payload: sealed('an old direct message'), peerPubkey: peer, ...over });
    /** An owner route whose backend has exactly the calls given; the rest of a real backend's surface is delegated. */
    const routeWith = (nip04Decrypt?: (peer: string, ciphertext: string) => Promise<string>): BunkerRoute => {
      const local = new LocalSigningBackend(bytesToHex(sk));
      return { pubkey, backend: {
        type: local.type, activePublicKeyHex: pubkey,
        signEvent: e => local.signEvent(e), nip44Encrypt: (p, t) => local.nip44Encrypt(p, t), nip44Decrypt: (p, t) => local.nip44Decrypt(p, t),
        ...(nip04Decrypt ? { nip04Decrypt } : {}), destroy() { /* nothing held */ },
      } as BunkerRoute['backend'] };
    };

    it('asks in plain words, then answers with the plaintext and nothing else', async () => {
      const onServed = vi.fn();
      const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey, onServed }));
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      const raw = decryptRequest();
      await act(async () => { listeners.nip55Request[0](raw); });
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      expect(result.current.pending).toMatchObject({ method: 'nip04_decrypt', description: 'read an older-format message sent to you', peer, pubkey, named: false });
      expect(respond).not.toHaveBeenCalled();
      await act(async () => { result.current.approveOnce(result.current.pending!.handle); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(respond.mock.calls[0][0]).toEqual({ id: raw.id, status: 'ok', result: 'an old direct message' });
      expect(onServed).toHaveBeenCalledTimes(1);
      expect(result.current.pending).toBeNull();
    });

    it('a provider query is deferred until the app is allowed always, then answered without a screen', async () => {
      const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey }));
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      await act(async () => { listeners.nip55Request[0](decryptRequest({ viaProvider: true })); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(respond.mock.calls[0][0]).toMatchObject({ status: 'deferred' });

      await act(async () => { listeners.nip55Request[0](decryptRequest()); });
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      await act(async () => { result.current.approveAlways(result.current.pending!.handle); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));

      const next = decryptRequest({ viaProvider: true, payload: sealed('a second old message') });
      await act(async () => { listeners.nip55Request[0](next); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(3));
      expect(respond.mock.calls[2][0]).toEqual({ id: next.id, status: 'ok', result: 'a second old message' });
      expect(result.current.pending).toBeNull();
    });

    it('nip04_encrypt is still refused, by intent and by provider: no screen, no key touched', async () => {
      const backend = route.backend as LocalSigningBackend;
      const encrypt = vi.spyOn(backend, 'nip04Encrypt');
      const decrypt = vi.spyOn(backend, 'nip04Decrypt');
      const onServed = vi.fn();
      const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey, onServed }));
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      for (const viaProvider of [false, true]) {
        await act(async () => { listeners.nip55Request[0](request({ type: 'nip04_encrypt', payload: 'hello', peerPubkey: peer, viaProvider })); });
      }
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
      expect(respond.mock.calls.map(c => c[0].status)).toEqual(['rejected', 'rejected']);
      expect(respond.mock.calls.every(c => c[0].result === undefined && c[0].event === undefined)).toBe(true);
      expect(result.current.pending).toBeNull();
      expect(encrypt).not.toHaveBeenCalled();
      expect(decrypt).not.toHaveBeenCalled();
      expect(onServed).not.toHaveBeenCalled();
      encrypt.mockRestore();
      decrypt.mockRestore();
    });

    it('a request that is not NIP-04 content is rejected without a screen', async () => {
      const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey }));
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      await act(async () => { listeners.nip55Request[0](decryptRequest({ payload: 'just some text' })); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(respond.mock.calls[0][0].status).toBe('rejected');
      expect(result.current.pending).toBeNull();
    });

    it('decrypts with the key the app named, and refuses a key this phone has no route for', async () => {
      const sk2 = generateSecretKey();
      const pubkey2 = getPublicKey(sk2);
      const route2: BunkerRoute = { pubkey: pubkey2, backend: new LocalSigningBackend(bytesToHex(sk2)) };
      const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [route, route2], locked: false, activePubkey: pubkey }));
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      await act(async () => { listeners.nip55Request[0](decryptRequest({ currentUser: pubkey2, payload: sealed('for the second key', pubkey2) })); });
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      expect(result.current.pending).toMatchObject({ pubkey: pubkey2, named: true });
      await act(async () => { result.current.approveOnce(result.current.pending!.handle); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(respond.mock.calls[0][0]).toMatchObject({ status: 'ok', result: 'for the second key' });

      // A key that is not an owner route (a dormant real identity has none) is never substituted.
      const dormant = getPublicKey(generateSecretKey());
      await act(async () => { listeners.nip55Request[0](decryptRequest({ currentUser: dormant })); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
      expect(respond.mock.calls[1][0]).toMatchObject({ status: 'rejected' });
      expect(result.current.pending).toBeNull();
    });

    it('a ciphertext the key cannot open is rejected, with nothing about why', async () => {
      const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey }));
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      await act(async () => { listeners.nip55Request[0](decryptRequest({ payload: 'AAAA?iv=AAAAAAAAAAAAAAAAAAAAAA==' })); });
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      await act(async () => { result.current.approveOnce(result.current.pending!.handle); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(respond.mock.calls[0][0]).toMatchObject({ status: 'rejected' });
      expect(respond.mock.calls[0][0].result).toBeUndefined();
    });

    it('a backend with no NIP-04 is refused at once, not called and not counted as serving', async () => {
      const onServed = vi.fn();
      const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [routeWith()], locked: false, activePubkey: pubkey, onServed }));
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      await act(async () => { listeners.nip55Request[0](decryptRequest()); });
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      await act(async () => { result.current.approveOnce(result.current.pending!.handle); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(respond.mock.calls[0][0]).toMatchObject({ status: 'rejected' });
      expect(onServed).not.toHaveBeenCalled();
    });

    it('a signer that answers with an error (it does not do NIP-04) is rejected, by intent and by provider', async () => {
      // nostr-tools rejects with the signer's error string, not an Error.
      const failing = vi.fn(async () => { throw 'unsupported method'; });
      localStorage.setItem('signet.nip55.grants', JSON.stringify({ 'dev.forgesworn.kithmoot': { pubkey, allowAlways: true, denyAlways: false, grantedAt: 1 } }));
      renderHook(() => useNip55Server({ enabled: true, routes: [routeWith(failing)], locked: false, activePubkey: pubkey }));
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      for (const viaProvider of [true, false]) {
        await act(async () => { listeners.nip55Request[0](decryptRequest({ viaProvider })); });
      }
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
      expect(failing).toHaveBeenCalledTimes(2);
      expect(respond.mock.calls.map(c => c[0].status)).toEqual(['rejected', 'rejected']);
    });

    it('a request held through an unlock is decrypted once the keys are there, for an app allowed always', async () => {
      localStorage.setItem('signet.nip55.grants', JSON.stringify({ 'dev.forgesworn.kithmoot': { pubkey, allowAlways: true, denyAlways: false, grantedAt: 1 } }));
      const { rerender } = renderHook(({ locked }) => useNip55Server({ enabled: true, routes: locked ? [] : [route], locked, activePubkey: pubkey }), { initialProps: { locked: true } });
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      const raw = decryptRequest();
      await act(async () => { listeners.nip55Request[0](raw); });
      rerender({ locked: false });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(respond.mock.calls[0][0]).toEqual({ id: raw.id, status: 'ok', result: 'an old direct message' });
    });

    it('a child-direct (gated) install does not serve it: refused before any gate, screen or unlock prompt', async () => {
      const gate = vi.fn(async () => ({ ok: true as const, requestCreatedAt: 1_900_000_000 }));
      const onNeedsUnlock = vi.fn();
      const { result, rerender } = renderHook(({ locked }) => useNip55Server({ enabled: true, routes: locked ? [] : [route], locked, activePubkey: pubkey, gate, onNeedsUnlock }), { initialProps: { locked: false } });
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      for (const viaProvider of [false, true]) {
        await act(async () => { listeners.nip55Request[0](decryptRequest({ viaProvider })); });
      }
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
      expect(respond.mock.calls.map(c => c[0].status)).toEqual(['rejected', 'rejected']);
      // Locked, it is refused as well and the person is not asked for a PIN for it.
      rerender({ locked: true });
      await act(async () => { listeners.nip55Request[0](decryptRequest()); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(3));
      expect(respond.mock.calls[2][0].status).toBe('rejected');
      expect(gate).not.toHaveBeenCalled();
      expect(onNeedsUnlock).not.toHaveBeenCalled();
      expect(result.current.pending).toBeNull();
      expect(result.current.waiting).toBe(0);
    });
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

    it('D7: only the gate function it is given is called — a full gate\'s pass-forward entry never is', async () => {
      const childGate = {
        authorise: vi.fn(async (req: { template?: { kind: number } }) => ({ ok: true as const, requestCreatedAt: 1_900_000_000, ...(req.template ? { template: { ...req.template, pubkey } as never } : {}) })),
        forwardPassed: vi.fn(),
      };
      const { unmount } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey, gate: childGate.authorise }));
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      const session = getPublicKey(generateSecretKey());
      const rumor = { kind: 29999, pubkey, created_at: 1, tags: [['session', 'ab'.repeat(32)], ['status', 'approved']], content: JSON.stringify({ event: { id: 'cd'.repeat(32) } }) };
      await act(async () => { listeners.nip55Request[0](request({ type: 'nip44_encrypt', payload: JSON.stringify(rumor), peerPubkey: session })); });
      await act(async () => { listeners.nip55Request[0](request({ payload: JSON.stringify({ kind: 13, content: 'x', tags: [], created_at: 1 }) })); });
      await waitFor(() => expect(childGate.authorise).toHaveBeenCalledTimes(2));
      // Both answered before the next test starts (its own respond count must not see these).
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
      expect(childGate.forwardPassed).not.toHaveBeenCalled();
      unmount();
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
  describe('known places', () => {
    beforeEach(async () => { await db.purgeAllUserData(); });

    it('approve once and approve always each write a pkg row under the approving key; deny writes none', async () => {
      const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey }));
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      await act(async () => { listeners.nip55Request[0](request({ callerLabel: 'Kithmoot' })); });
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      await act(async () => { result.current.deny(result.current.pending!.handle); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(await db.listKnownPlaces()).toEqual([]);

      await act(async () => { listeners.nip55Request[0](request({ callerLabel: 'Kithmoot' })); });
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      await act(async () => { result.current.approveOnce(result.current.pending!.handle); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
      await waitFor(async () => expect(await db.listKnownPlaces()).toHaveLength(1));
      expect((await db.listKnownPlaces())[0]).toMatchObject({
        id: `pkg:dev.forgesworn.kithmoot:${pubkey}`, pubkey, placeKey: 'pkg:dev.forgesworn.kithmoot',
        kind: 'nip55', name: 'Kithmoot', nativePackage: 'dev.forgesworn.kithmoot', channel: 'nip55', signer: 'local', uses: 1,
      });

      await act(async () => { listeners.nip55Request[0](request()); });
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      await act(async () => { result.current.approveAlways(result.current.pending!.handle); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(3));
      await waitFor(async () => expect((await db.listKnownPlaces())[0].uses).toBe(2));
    });

    it('falls back to the package name when the shell gave no label', async () => {
      const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey }));
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      await act(async () => { listeners.nip55Request[0](request()); });
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      await act(async () => { result.current.approveOnce(result.current.pending!.handle); });
      await waitFor(async () => expect(await db.listKnownPlaces()).toHaveLength(1));
      expect((await db.listKnownPlaces())[0].name).toBe('dev.forgesworn.kithmoot');
    });

    it('grants are gone from state and storage after purgeAllUserData', async () => {
      const { result } = renderHook(() => useNip55Server({ enabled: true, routes: [route], locked: false, activePubkey: pubkey }));
      await waitFor(() => expect(listeners.nip55Request?.length).toBe(1));
      await act(async () => { listeners.nip55Request[0](request()); });
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      await act(async () => { result.current.approveAlways(result.current.pending!.handle); });
      await waitFor(() => expect(result.current.grants['dev.forgesworn.kithmoot']).toBeDefined());
      expect(localStorage.getItem('signet.nip55.grants')).not.toBeNull();
      await act(async () => { await db.purgeAllUserData(); });
      expect(result.current.grants).toEqual({});
      expect(localStorage.getItem('signet.nip55.grants')).toBeNull();
      // The next provider query is a stranger again.
      respond.mockClear();
      await act(async () => { listeners.nip55Request[0](request({ viaProvider: true })); });
      await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
      expect(respond.mock.calls[0][0]).toMatchObject({ status: 'deferred' });
    });
  });
});
