// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NostrEvent } from 'signet-protocol';
const state = vi.hoisted(() => ({ relays: [] as Array<{ receive?: (event: NostrEvent) => void; disconnect: ReturnType<typeof vi.fn>; publish: ReturnType<typeof vi.fn> }> }));
vi.mock('signet-protocol', async original => ({ ...await original<typeof import('signet-protocol')>(), RelayClient: class {
  receive?: (event: NostrEvent) => void;
  disconnect = vi.fn(); publish = vi.fn(async () => ({ ok: true, message: '' }));
  constructor() { state.relays.push(this); }
  async connect() {}
  subscribe(_filters: unknown, receive: (event: NostrEvent) => void) { this.receive = receive; return 'sub'; }
} }));
vi.mock('../lib/db', () => ({ loadPairedChild: vi.fn() }));
vi.mock('../lib/child-contact-policy-cache', () => ({ loadChildContactPolicyCache: vi.fn(), saveChildContactPolicyCache: vi.fn() }));
import { loadPairedChild } from '../lib/db';
import { loadChildContactPolicyCache, saveChildContactPolicyCache } from '../lib/child-contact-policy-cache';
import { LocalSigningBackend } from '../lib/signing-backend';
import { projectChildContactPolicy, sealChildContactPolicy } from '../lib/child-contact-policy-wire';
import { useChildContactPolicy, useChildContactPolicyPublisher } from './useChildContactPolicy';
const endpoint = new LocalSigningBackend('04'.repeat(32)), recipient = new LocalSigningBackend('05'.repeat(32));
const child = '1'.repeat(64), guardian = '2'.repeat(64), now = () => Math.floor(Date.now() / 1000);
const pair = { id: child, dependantPubkey: child, dependantName: 'Child', guardianPubkey: guardian,
  bunkerUri: `bunker://${endpoint.activePublicKeyHex}?relay=wss%3A%2F%2Frelay.example`, pairedAt: 1,
  clientKeypair: { publicKey: recipient.activePublicKeyHex, privateKey: '05'.repeat(32) } };
const view = () => projectChildContactPolicy({ child, guardian, recipient: recipient.activePublicKeyHex, records: [], now: now() });
beforeEach(() => {
  state.relays.length = 0; vi.clearAllMocks();
  vi.mocked(loadPairedChild).mockResolvedValue(pair);
  vi.mocked(loadChildContactPolicyCache).mockResolvedValue(null);
  vi.mocked(saveChildContactPolicyCache).mockImplementation(async (_pair, _key, view) => view);
});
afterEach(() => { vi.useRealTimers(); });
it('authenticates a live policy, persists it before display, and hides it after an account switch', async () => {
  const { result, rerender, unmount } = renderHook(({ child }) => useChildContactPolicy({ child, enabled: true, key: 'unlock-key', relayUrl: 'wss://relay.example' }), { initialProps: { child } });
  await waitFor(() => expect(state.relays[0]?.receive).toBeDefined());
  const event = await sealChildContactPolicy(view(), endpoint);
  await act(async () => { state.relays[0].receive!({ ...event, sig: '00'.repeat(64) }); });
  expect(saveChildContactPolicyCache).not.toHaveBeenCalled();
  await act(async () => { state.relays[0].receive!(event); });
  await waitFor(() => expect(result.current?.policy).toBe('kin-only'));
  expect(saveChildContactPolicyCache).toHaveBeenCalledOnce();
  vi.mocked(loadPairedChild).mockResolvedValue(null);
  rerender({ child: '6'.repeat(64) });
  expect(result.current).toBeNull();
  expect(state.relays[0].disconnect).toHaveBeenCalled();
  unmount();
});
it('does not open a subscription after locking during a pairing read', async () => {
  let resolve!: (value: typeof pair) => void;
  vi.mocked(loadPairedChild).mockReturnValue(new Promise(r => { resolve = r; }));
  const { result, rerender } = renderHook(({ enabled }) => useChildContactPolicy({ child, enabled, key: 'unlock-key', relayUrl: 'wss://relay.example' }), { initialProps: { enabled: true } });
  rerender({ enabled: false });
  await act(async () => { resolve(pair); });
  expect(state.relays).toHaveLength(0);
  expect(result.current).toBeNull();
});
it('expires a cached view and refuses to display a view whose durable save failed', async () => {
  vi.useFakeTimers();
  const cached = { ...view(), expiresAt: now() + 2 };
  vi.mocked(loadChildContactPolicyCache).mockResolvedValue(cached);
  const { result } = renderHook(() => useChildContactPolicy({ child, enabled: true, key: 'unlock-key', relayUrl: 'wss://relay.example' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(result.current).toEqual(cached);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(result.current).toBeNull();
  vi.mocked(saveChildContactPolicyCache).mockRejectedValue(new Error('storage unavailable'));
  const event = await sealChildContactPolicy(view(), endpoint);
  await act(async () => { state.relays[0].receive!(event); });
  expect(result.current).toBeNull();
});
it('publishes bounded refreshes and drops a build finishing after lock', async () => {
  vi.useFakeTimers();
  let resolve!: (events: NostrEvent[]) => void;
  const build = vi.fn(() => new Promise<NostrEvent[]>(r => { resolve = r; }));
  const { rerender } = renderHook(({ enabled }) => useChildContactPolicyPublisher({ enabled, session: 'guardian', changeToken: 'one', relayUrl: 'wss://relay.example', build }), { initialProps: { enabled: true } });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(build).toHaveBeenCalledOnce();
  rerender({ enabled: false });
  const event = await sealChildContactPolicy(view(), endpoint);
  await act(async () => { resolve([event]); });
  expect(state.relays).toHaveLength(0);
  build.mockResolvedValue([event]);
  rerender({ enabled: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(state.relays[0].publish).toHaveBeenCalledWith(event);
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
  expect(state.relays[1].publish).toHaveBeenCalledWith(event);
});
