// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NostrEvent } from 'signet-protocol';
const state = vi.hoisted(() => ({ relays: [] as Array<{ receive?: (event: NostrEvent) => void; disconnect: ReturnType<typeof vi.fn> }> }));
vi.mock('signet-protocol', async original => ({ ...await original<typeof import('signet-protocol')>(), RelayClient: class {
  receive?: (event: NostrEvent) => void;
  disconnect = vi.fn();
  constructor() { state.relays.push(this); }
  async connect() {}
  subscribe(_filters: unknown, receive: (event: NostrEvent) => void) { this.receive = receive; return 'sub'; }
} }));
vi.mock('../lib/db', () => ({ loadPairedChild: vi.fn() }));
vi.mock('../lib/child-contact-directory-cache', () => ({ loadChildContactDirectoryCache: vi.fn(), saveChildContactDirectoryCache: vi.fn() }));
import { loadPairedChild } from '../lib/db';
import { loadChildContactDirectoryCache, saveChildContactDirectoryCache } from '../lib/child-contact-directory-cache';
import { LocalSigningBackend } from '../lib/signing-backend';
import { projectChildContactDirectory, sealChildContactDirectory } from '../lib/child-contact-directory';
import { useChildContactDirectory, useChildContactDirectoryPublisher } from './useChildContactDirectory';
const endpoint = new LocalSigningBackend('04'.repeat(32)), recipient = new LocalSigningBackend('05'.repeat(32));
const child = '1'.repeat(64), guardian = '2'.repeat(64), persona = '3'.repeat(64), now = () => Math.floor(Date.now() / 1000);
const pair = { id: child, dependantPubkey: child, dependantName: 'Child', guardianPubkey: guardian,
  bunkerUri: `bunker://${endpoint.activePublicKeyHex}?relay=wss%3A%2F%2Frelay.example`, pairedAt: 1,
  clientKeypair: { publicKey: recipient.activePublicKeyHex, privateKey: '05'.repeat(32) } };
const view = () => projectChildContactDirectory({ child, guardian, recipient: recipient.activePublicKeyHex, records: [], availablePersonas: [persona], revision: 1, now: now() });
const options = { child, enabled: true, key: 'unlock-key', relayUrl: 'wss://relay.example', availablePersonas: [persona] };
beforeEach(() => {
  state.relays.length = 0; vi.clearAllMocks();
  vi.mocked(loadPairedChild).mockResolvedValue(pair);
  vi.mocked(loadChildContactDirectoryCache).mockResolvedValue(null);
  vi.mocked(saveChildContactDirectoryCache).mockImplementation(async (_pair, _key, view) => view);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('verifies live events and waits for durable persistence before displaying', async () => {
  let release!: () => void;
  vi.mocked(saveChildContactDirectoryCache).mockImplementation(async (_pair, _key, view) => { await new Promise<void>(resolve => { release = resolve; }); return view; });
  const { result, unmount } = renderHook(() => useChildContactDirectory(options));
  await waitFor(() => expect(state.relays[0]?.receive).toBeDefined());
  const expected = view();
  const event = await sealChildContactDirectory(expected, endpoint);
  await act(async () => { state.relays[0].receive!({ ...event, sig: '00'.repeat(64) }); });
  expect(saveChildContactDirectoryCache).not.toHaveBeenCalled();
  await act(async () => { state.relays[0].receive!(event); });
  await waitFor(() => expect(release).toBeDefined());
  expect(result.current).toBeNull();
  await act(async () => { release(); });
  await waitFor(() => expect(result.current).toEqual(expected));
  unmount();
});
it('hides cached names immediately on scope change, lock and after expiry', async () => {
  vi.useFakeTimers();
  const cached = { ...view(), expiresAt: now() + 2 };
  vi.mocked(loadChildContactDirectoryCache).mockResolvedValue(cached);
  const { result, rerender, unmount } = renderHook(props => useChildContactDirectory(props), { initialProps: options });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(result.current).toEqual(cached);
  rerender({ ...options, availablePersonas: [] });
  expect(result.current).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(result.current).toBeNull();
  rerender(options);
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  expect(result.current).toBeNull();
  rerender({ ...options, enabled: false });
  expect(result.current).toBeNull();
  unmount();
});
it('refuses corrupt cache and late pairing reads after lock', async () => {
  vi.mocked(loadChildContactDirectoryCache).mockRejectedValueOnce(new Error('corrupt'));
  const first = renderHook(() => useChildContactDirectory(options));
  await waitFor(() => expect(loadChildContactDirectoryCache).toHaveBeenCalled());
  expect(state.relays).toHaveLength(0); first.unmount();
  let release!: (value: typeof pair) => void;
  vi.mocked(loadPairedChild).mockReturnValue(new Promise(r => { release = r; }));
  const { result, rerender, unmount } = renderHook(props => useChildContactDirectory(props), { initialProps: options });
  rerender({ ...options, enabled: false });
  await act(async () => { release(pair); });
  expect(state.relays).toHaveLength(0); expect(result.current).toBeNull(); unmount();
});
it('drops a save completing after an account switch', async () => {
  let release!: () => void;
  vi.mocked(saveChildContactDirectoryCache).mockImplementation(async (_pair, _key, view) => { await new Promise<void>(r => { release = r; }); return view; });
  const { result, rerender, unmount } = renderHook(props => useChildContactDirectory(props), { initialProps: options });
  await waitFor(() => expect(state.relays[0]?.receive).toBeDefined());
  const event = await sealChildContactDirectory(view(), endpoint);
  await act(async () => { state.relays[0].receive!(event); });
  await waitFor(() => expect(release).toBeDefined());
  vi.mocked(loadPairedChild).mockResolvedValue(null);
  rerender({ ...options, child: '7'.repeat(64) });
  await act(async () => { release(); });
  expect(result.current).toBeNull(); unmount();
});
it('opens the transport before building and refuses a delayed send after lock', async () => {
  vi.useFakeTimers();
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1; readyState = 0; onopen?: () => void; onclose?: () => void; onerror?: () => void;
    send = vi.fn(); close = vi.fn(() => { this.readyState = 3; this.onclose?.(); });
    constructor() { sockets.push(this); }
  }
  vi.stubGlobal('WebSocket', FakeSocket);
  let send!: (event: NostrEvent) => void, release!: () => void;
  const publish = vi.fn(async (transmit: typeof send) => { send = transmit; await new Promise<void>(r => { release = r; }); });
  const props = { enabled: true, session: 'one', changeToken: 'one', relayUrl: options.relayUrl, publish };
  const { rerender, unmount } = renderHook(props => useChildContactDirectoryPublisher(props), { initialProps: props });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(publish).not.toHaveBeenCalled();
  await act(async () => { sockets[0].readyState = 1; sockets[0].onopen?.(); });
  expect(publish).toHaveBeenCalledOnce();
  rerender({ ...props, enabled: false });
  expect(() => send({} as NostrEvent)).toThrow('session or relay changed');
  await act(async () => { release(); });
  expect(sockets[0].send).not.toHaveBeenCalled(); unmount();
});
it('rebuilds after a missing relay acknowledgement instead of replaying a signed event', async () => {
  vi.useFakeTimers();
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1; readyState = 0; onopen?: () => void; onclose?: () => void; onerror?: () => void;
    send = vi.fn(); close = vi.fn(() => { this.readyState = 3; this.onclose?.(); });
    constructor() { sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
  }
  vi.stubGlobal('WebSocket', FakeSocket);
  let revision = 0;
  const publish = vi.fn(async (send: (event: NostrEvent) => void) => { send({ id: `${++revision}`, content: `revision ${revision}` } as NostrEvent); });
  const { unmount } = renderHook(() => useChildContactDirectoryPublisher({ enabled: true, session: 'one', changeToken: 'one', relayUrl: options.relayUrl, publish }));
  await act(async () => { await vi.advanceTimersByTimeAsync(11001); });
  expect(publish).toHaveBeenCalledTimes(2);
  expect(sockets[0].send.mock.calls[0][0]).toContain('revision 1');
  expect(sockets[1].send.mock.calls[0][0]).toContain('revision 2');
  unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
});
