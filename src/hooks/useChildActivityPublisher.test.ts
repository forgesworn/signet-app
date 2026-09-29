// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { NostrEvent } from 'signet-protocol';
import type { PairedChildRecord } from '../types';
import {
  buildConnectedAppsEvent, openConnectedAppsEvent, unwrapChildActivity, CHILD_CONNECTED_APPS_D_TAG,
  type ChildActivityEntry, type ConnectedChildApp,
} from '../lib/child-activity';
import {
  useChildActivityPublisher, ACTIVITY_FLUSH_MS, ACTIVITY_FLUSH_BATCH, CONNECTED_APPS_DEBOUNCE_MS, CONNECTED_APPS_SEED_WAIT_MS,
  type ChildActivityTransport,
} from './useChildActivityPublisher';

const kp = () => { const sk = generateSecretKey(); return { priv: bytesToHex(sk), pub: getPublicKey(sk) }; };
const rail = kp(), client = kp();
const PERSONA = 'ab'.repeat(32);

function record(over: Partial<PairedChildRecord> = {}): PairedChildRecord {
  return {
    id: 'ef'.repeat(32), bunkerUri: '', clientKeypair: { publicKey: client.pub, privateKey: client.priv },
    dependantPubkey: 'ef'.repeat(32), dependantName: 'Sky', pairedAt: 1, mode: 'heartwood-direct',
    railPubkey: rail.pub, personaPubkey: PERSONA, hwRelays: ['wss://hw.example'], railRelay: 'wss://rail.example', ...over,
  } as PairedChildRecord;
}

function fake(ok = true) {
  const published: { ev: NostrEvent; relays: string[] }[] = [];
  const subs: { filters: unknown[]; onEvent: (e: NostrEvent) => void }[] = [];
  const t: ChildActivityTransport = {
    publish: async (ev, relays) => { published.push({ ev, relays }); return { ok, message: '' }; },
    subscribe: (filters, _r, onEvent) => { subs.push({ filters, onEvent }); return () => {}; },
  };
  return { t, published, subs };
}

const entry = (over: Partial<ChildActivityEntry> = {}): ChildActivityEntry => ({
  persona: PERSONA, kind: 1, method: 'sign_event', outcome: 'signed', appId: 'nip55:com.x', appLabel: 'X', requestCreatedAt: 100, at: 100, ...over,
});
const app = (i: number): ConnectedChildApp => ({ appId: `nip55:com.x${i}`, kind: 'nip55', label: `X${i}`, persona: PERSONA, firstSeen: 1, lastUsed: 10 + i });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('useChildActivityPublisher (child)', () => {
  it('batches decisions and gift-wraps each to the rail pubkey on the rail relay', async () => {
    const f = fake();
    const { result } = renderHook(() => useChildActivityPublisher({ record: record(), unpaired: false, connectedApps: [], noteConnectedApp: () => {}, transport: f.t }));
    act(() => { for (let i = 0; i < 12; i++) result.current.report(entry({ at: 100 + i })); });
    expect(f.published).toHaveLength(0);
    await advance(ACTIVITY_FLUSH_MS);
    const wraps = () => f.published.filter(p => p.ev.kind === 1059);
    expect(wraps()).toHaveLength(ACTIVITY_FLUSH_BATCH);
    expect(wraps()[0].relays).toEqual(['wss://rail.example']);
    expect((await unwrapChildActivity(wraps()[0].ev, rail.priv, client.pub))?.at).toBe(100);
    await advance(ACTIVITY_FLUSH_MS);
    expect(wraps()).toHaveLength(12);
  });

  it('reports a blocked app at most once a minute per (app, persona, kind)', async () => {
    const f = fake();
    const { result } = renderHook(() => useChildActivityPublisher({ record: record(), unpaired: false, connectedApps: [], noteConnectedApp: () => {}, transport: f.t }));
    act(() => { for (let i = 0; i < 5; i++) result.current.report(entry({ outcome: 'blocked', requestCreatedAt: undefined })); });
    await advance(ACTIVITY_FLUSH_MS);
    expect(f.published.filter(p => p.ev.kind === 1059)).toHaveLength(1);
  });

  it('sends nothing once unpaired, or for a legacy pairing', async () => {
    const f = fake();
    const a = renderHook(() => useChildActivityPublisher({ record: record(), unpaired: true, connectedApps: [app(1)], noteConnectedApp: () => {}, transport: f.t }));
    const b = renderHook(() => useChildActivityPublisher({ record: record({ mode: undefined }), unpaired: false, connectedApps: [app(1)], noteConnectedApp: () => {}, transport: f.t }));
    act(() => { a.result.current.report(entry()); b.result.current.report(entry()); });
    await advance(CONNECTED_APPS_SEED_WAIT_MS + CONNECTED_APPS_DEBOUNCE_MS + ACTIVITY_FLUSH_MS);
    expect(f.published).toHaveLength(0);
    expect(f.subs).toHaveLength(0);
  });

  it('seeds the connected apps from its own last record, then republishes after a change (debounced)', async () => {
    const f = fake();
    const noted: ConnectedChildApp[] = [];
    const { rerender } = renderHook((p: { apps: ConnectedChildApp[] }) => useChildActivityPublisher({
      record: record(), unpaired: false, connectedApps: p.apps, noteConnectedApp: (a) => noted.push(a), transport: f.t,
    }), { initialProps: { apps: [] as ConnectedChildApp[] } });
    expect(f.subs[0].filters[0]).toMatchObject({ authors: [client.pub], '#d': [CHILD_CONNECTED_APPS_D_TAG], '#p': [rail.pub] });
    const own = await buildConnectedAppsEvent([app(1)], client.priv, rail.pub, 500);
    await act(async () => { f.subs[0].onEvent(own); });
    await act(async () => { await vi.waitFor(() => expect(noted.map(a => a.appId)).toEqual(['nip55:com.x1'])); });
    rerender({ apps: [app(1), app(2)] });
    await advance(CONNECTED_APPS_DEBOUNCE_MS - 1);
    expect(f.published).toHaveLength(0);
    await advance(1);
    await act(async () => { await vi.waitFor(() => expect(f.published).toHaveLength(1)); });
    expect((await openConnectedAppsEvent(f.published[0].ev, rail.priv, client.pub))?.map(a => a.appId)).toEqual(['nip55:com.x2', 'nip55:com.x1']);
  });

  it('never publishes an empty list', async () => {
    const f = fake();
    renderHook(() => useChildActivityPublisher({ record: record(), unpaired: false, connectedApps: [], noteConnectedApp: () => {}, transport: f.t }));
    await advance(CONNECTED_APPS_SEED_WAIT_MS + CONNECTED_APPS_DEBOUNCE_MS * 2);
    expect(f.published).toHaveLength(0);
  });
});
