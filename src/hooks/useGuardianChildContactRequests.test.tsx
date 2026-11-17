// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { NostrEvent } from 'signet-protocol';
const network = vi.hoisted(() => ({
  subscriptions: [] as Array<{ url: string; authors: string[]; receive(event: NostrEvent): void }>,
  connections: [] as string[],
}));
vi.mock('signet-protocol', async original => ({ ...await original<typeof import('signet-protocol')>(), RelayClient: class {
  constructor(public url: string) {}
  async connect() { network.connections.push(this.url); }
  disconnect() {}
  subscribe(filters: Array<{ authors: string[] }>, receive: (event: NostrEvent) => void) {
    network.subscriptions.push({ url: this.url, authors: filters[0].authors, receive }); return 'sub';
  }
} }));
// Pass-through, except an event whose content is 'hold' waits on `gate.hold` (it stays queued) and opens as nothing.
const gate = vi.hoisted(() => ({ hold: Promise.resolve(), opened: [] as string[] }));
vi.mock('../lib/child-contact-requests', async original => {
  const real = await original<typeof import('../lib/child-contact-requests')>();
  return { ...real, openChildContactRequest: vi.fn(async (event: NostrEvent, options: Parameters<typeof real.openChildContactRequest>[1]) => {
    gate.opened.push(event.id);
    if (event.content === 'hold') { await gate.hold; return null; }
    return real.openChildContactRequest(event, options);
  }) };
});
import { purgeAllUserData } from '../lib/db';
import { LocalSigningBackend } from '../lib/signing-backend';
import { openChildContactRequest, sealChildContactRequest, storeChildContactRequest, type ChildContactRequest } from '../lib/child-contact-requests';
import { decideChildContactRequest } from '../lib/child-contact-lifecycle';
import { executeChildContactPlan } from '../lib/child-contact-execution';
import { useGuardianChildContactRequests } from './useGuardianChildContactRequests';
const client = new LocalSigningBackend('05'.repeat(32)), endpoint = new LocalSigningBackend('04'.repeat(32));
const scope = { guardian: '1'.repeat(64), child: '2'.repeat(64), endpoint: endpoint.activePublicKeyHex, client: client.activePublicKeyHex, personas: ['3'.repeat(64)] };
const sources = async () => [{ scope, endpointPrivateKey: '04'.repeat(32) }];
beforeEach(async () => { network.subscriptions.length = 0; network.connections.length = 0; gate.opened.length = 0; gate.hold = Promise.resolve(); await purgeAllUserData(); });
it('receives client-signed requests through an author-filtering relay and reloads the inbox', async () => {
  const options = { enabled: true, key: 'request-hook', relayUrl: 'wss://relay.example', sources, changeToken: 'pair-1' };
  const first = renderHook(() => useGuardianChildContactRequests(options));
  await waitFor(() => expect(network.subscriptions).toHaveLength(1));
  const now = Math.floor(Date.now() / 1000);
  const request: ChildContactRequest = { v: 1, id: 'a'.repeat(32), ...scope, persona: scope.personas[0], revision: 1, createdAt: now, expiresAt: now + 600,
    invite: { v: 1, recipient: '6'.repeat(64), secret: '7'.repeat(64), relays: ['wss://invite.example'] } };
  const event = await sealChildContactRequest(request, client);
  await act(async () => {
    for (const sub of network.subscriptions) if (sub.authors.includes(event.pubkey)) sub.receive(event);
  });
  await waitFor(() => expect(first.result.current.pendingCount).toBe(1));
  expect(first.result.current.pending[0].receipt.request?.id).toBe(request.id);
  first.unmount();
  const second = renderHook(() => useGuardianChildContactRequests(options));
  await waitFor(() => expect(second.result.current.pendingCount).toBe(1));
  second.unmount();
});

async function stored(key: string, createdAt: number) {
  const request: ChildContactRequest = { v: 1, id: 'b'.repeat(32), ...scope, persona: scope.personas[0], revision: 1, createdAt, expiresAt: createdAt + 600,
    invite: { v: 1, recipient: '6'.repeat(64), secret: '7'.repeat(64), relays: ['wss://invite.example'] } };
  const opened = (await openChildContactRequest(await sealChildContactRequest(request, client), { scope, endpoint, now: createdAt, isCurrent: () => true }))!;
  await storeChildContactRequest({ scope, key, request: opened.request, fingerprint: opened.fingerprint, now: createdAt, isCurrent: () => true });
  return opened;
}
const noop = async () => {};
it('drops a decided request after reload and keeps it gone on relay replay', async () => {
  const key = 'request-hook-decision', now = Math.floor(Date.now() / 1000);
  const opened = await stored(key, now);
  const hook = renderHook(() => useGuardianChildContactRequests({ enabled: true, key, relayUrl: 'wss://relay.example', sources, changeToken: 'pair-1' }));
  await waitFor(() => expect(hook.result.current.pendingCount).toBe(1));
  await decideChildContactRequest({ scope, key, requestId: opened.request.id, fingerprint: opened.fingerprint, decision: 'deny', now: () => now,
    isCurrent: () => true, mayConnect: () => true, execute: noop, abandon: noop, reply: noop });
  const subscribedBefore = network.subscriptions.length;
  await act(async () => { hook.result.current.reload(); });
  // Wait for the reloaded session's own subscription, not any earlier one.
  await waitFor(() => expect(network.subscriptions.length).toBeGreaterThan(subscribedBefore), { timeout: 5000 });
  await waitFor(() => expect(hook.result.current.history).toHaveLength(1), { timeout: 5000 });
  expect(hook.result.current.pendingCount).toBe(0);
  // D4: the decided request now shows up as terminal history, not pending.
  expect(hook.result.current.history.map(item => item.receipt.id)).toEqual([opened.request.id]);
  expect(hook.result.current.history[0].receipt.status).toBe('denied');
  const event = await sealChildContactRequest(opened.request, client);
  await act(async () => { for (const sub of network.subscriptions) sub.receive(event); await new Promise(r => setTimeout(r, 50)); });
  expect(hook.result.current.pendingCount).toBe(0);
  hook.unmount();
});
it('shows a stuck request once, not as pending, and sweeps it after the request expires', async () => {
  const key = 'request-hook-stuck', now = Math.floor(Date.now() / 1000);
  const opened = await stored(key, now - 60);
  await decideChildContactRequest({ scope, key, requestId: opened.request.id, fingerprint: opened.fingerprint, decision: 'approve', now: () => now - 59,
    isCurrent: () => true, mayConnect: () => true, abandon: noop, reply: noop,
    execute: async () => { await executeChildContactPlan({ scope, key, requestId: opened.request.id, now: now - 59, isCurrent: () => true,
      mayConnect: () => true, sign: async () => { throw new Error('signer gone'); } }); } }).catch(() => {});
  const expireStuck = vi.fn(async () => {});
  const hook = renderHook(() => useGuardianChildContactRequests({ enabled: true, key, relayUrl: 'wss://relay.example', sources, changeToken: 'pair-1', expireStuck }));
  await waitFor(() => expect(hook.result.current.stuck).toHaveLength(1));
  expect(hook.result.current.pendingCount).toBe(0);
  expect(expireStuck).not.toHaveBeenCalled();
  hook.unmount();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime((now + 600) * 1000);
  try {
    const later = renderHook(() => useGuardianChildContactRequests({ enabled: true, key, relayUrl: 'wss://relay.example', sources, changeToken: 'pair-1', expireStuck }));
    await waitFor(() => expect(expireStuck).toHaveBeenCalledTimes(1));
    expect((expireStuck.mock.calls[0] as unknown[])[0]).toMatchObject({ plan: { requestId: opened.request.id } });
    later.unmount();
  } finally { vi.useRealTimers(); }
});

// ── A56: a direct child asks on its pairing's rail relay ──────────────────
const BASE = 'wss://relay.example', RAIL = 'wss://rail.example';
const railClient = new LocalSigningBackend('08'.repeat(32)), railEndpoint = new LocalSigningBackend('09'.repeat(32));
const railScope = { guardian: '1'.repeat(64), child: '8'.repeat(64), endpoint: railEndpoint.activePublicKeyHex, client: railClient.activePublicKeyHex, personas: ['3'.repeat(64)] };
const bothSources = async () => [{ scope, endpointPrivateKey: '04'.repeat(32) }, { scope: railScope, endpointPrivateKey: '09'.repeat(32), railRelay: RAIL }];
async function railRequest(id: string) {
  const now = Math.floor(Date.now() / 1000);
  const request: ChildContactRequest = { v: 1, id, ...railScope, persona: railScope.personas[0], revision: 1, createdAt: now, expiresAt: now + 600,
    invite: { v: 1, recipient: '6'.repeat(64), secret: '7'.repeat(64), relays: ['wss://invite.example'] } };
  return sealChildContactRequest(request, railClient);
}
const subOn = (url: string) => network.subscriptions.find(s => s.url === url)!;
const held = (i: number, author: string) => ({ id: i.toString(16).padStart(64, '0'), pubkey: author, kind: 30078, created_at: Math.floor(Date.now() / 1000),
  tags: [], content: 'hold', sig: '' }) as unknown as NostrEvent;

it('A56: one connection per relay; the rail relay names only the direct child, the guardian relay only the legacy one', async () => {
  const hook = renderHook(() => useGuardianChildContactRequests({ enabled: true, key: 'rail-relay', relayUrl: BASE, extraRelays: [RAIL],
    sources: bothSources, changeToken: 'pair-1' }));
  await waitFor(() => expect(network.subscriptions).toHaveLength(2));
  expect(subOn(BASE).authors).toEqual([scope.client]);
  expect(subOn(RAIL).authors).toEqual([railScope.client]);
  await waitFor(() => expect([...network.connections].sort()).toEqual([RAIL, BASE].sort()));
  const event = await railRequest('c'.repeat(32));
  await act(async () => { subOn(RAIL).receive(event); });
  await waitFor(() => expect(hook.result.current.pendingCount).toBe(1));
  expect(hook.result.current.pending[0].source.scope.client).toBe(railScope.client);
  hook.unmount();
});

it('restarts when the set of rail relays changes', async () => {
  const hook = renderHook(({ extra }) => useGuardianChildContactRequests({ enabled: true, key: 'rail-restart', relayUrl: BASE, extraRelays: extra,
    sources: bothSources, changeToken: 'pair-1' }), { initialProps: { extra: [RAIL] } });
  await waitFor(() => expect(network.subscriptions).toHaveLength(2));
  hook.rerender({ extra: [RAIL] });
  await act(async () => { await new Promise(r => setTimeout(r, 30)); });
  expect(network.subscriptions).toHaveLength(2);
  hook.rerender({ extra: [RAIL, 'wss://other.example'] });
  await waitFor(() => expect(network.subscriptions).toHaveLength(4));
  hook.unmount();
});

it('caps the queue PER RELAY: a relay flooding its queue drops its own surplus and never starves another relay', async () => {
  let release!: () => void;
  gate.hold = new Promise<void>(r => { release = r; });
  const hook = renderHook(() => useGuardianChildContactRequests({ enabled: true, key: 'rail-flood', relayUrl: BASE, extraRelays: [RAIL],
    sources: bothSources, changeToken: 'pair-1' }));
  await waitFor(() => expect(network.subscriptions).toHaveLength(2));
  await act(async () => { for (let i = 1; i <= 70; i++) subOn(BASE).receive(held(i, scope.client)); });
  // The guardian relay's queue is full and stuck; the rail relay's request still goes through.
  await act(async () => { subOn(RAIL).receive(await railRequest('d'.repeat(32))); });
  await waitFor(() => expect(hook.result.current.pendingCount).toBe(1));
  await act(async () => { release(); await new Promise(r => setTimeout(r, 30)); });
  // 64 accepted from the flooding relay, the other 6 dropped; plus the rail relay's one.
  expect(gate.opened.filter(id => id.startsWith('0000'))).toHaveLength(64);
  expect(gate.opened).toHaveLength(65);
  hook.unmount();
});

it('opens a duplicate of the same event once, and ignores events by any other author', async () => {
  const hook = renderHook(() => useGuardianChildContactRequests({ enabled: true, key: 'rail-dedupe', relayUrl: BASE, extraRelays: [RAIL],
    sources: bothSources, changeToken: 'pair-1' }));
  await waitFor(() => expect(network.subscriptions).toHaveLength(2));
  const event = await railRequest('e'.repeat(32));
  // A relay replaying what it holds (a reconnect), or a second copy arriving while the first is open.
  await act(async () => { subOn(RAIL).receive(event); subOn(RAIL).receive(event); });
  await waitFor(() => expect(hook.result.current.pendingCount).toBe(1));
  await act(async () => { subOn(RAIL).receive(event); await new Promise(r => setTimeout(r, 30)); });
  // A relay handing the child's event to another child's subscription takes no place and opens nothing.
  await act(async () => { subOn(BASE).receive(event); await new Promise(r => setTimeout(r, 30)); });
  expect(gate.opened.filter(id => id === event.id)).toHaveLength(1);
  expect(hook.result.current.pendingCount).toBe(1);
  hook.unmount();
});
