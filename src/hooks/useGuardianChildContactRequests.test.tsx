// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { NostrEvent } from 'signet-protocol';
const network = vi.hoisted(() => ({ subscriptions: [] as Array<{ authors: string[]; receive(event: NostrEvent): void }> }));
vi.mock('signet-protocol', async original => ({ ...await original<typeof import('signet-protocol')>(), RelayClient: class {
  async connect() {}
  disconnect() {}
  subscribe(filters: Array<{ authors: string[] }>, receive: (event: NostrEvent) => void) {
    network.subscriptions.push({ authors: filters[0].authors, receive }); return 'sub';
  }
} }));
import { purgeAllUserData } from '../lib/db';
import { LocalSigningBackend } from '../lib/signing-backend';
import { openChildContactRequest, sealChildContactRequest, storeChildContactRequest, type ChildContactRequest } from '../lib/child-contact-requests';
import { decideChildContactRequest } from '../lib/child-contact-lifecycle';
import { executeChildContactPlan } from '../lib/child-contact-execution';
import { useGuardianChildContactRequests } from './useGuardianChildContactRequests';
const client = new LocalSigningBackend('05'.repeat(32)), endpoint = new LocalSigningBackend('04'.repeat(32));
const scope = { guardian: '1'.repeat(64), child: '2'.repeat(64), endpoint: endpoint.activePublicKeyHex, client: client.activePublicKeyHex, personas: ['3'.repeat(64)] };
const sources = async () => [{ scope, endpointPrivateKey: '04'.repeat(32) }];
beforeEach(async () => { network.subscriptions.length = 0; await purgeAllUserData(); });
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
