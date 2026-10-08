// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useContactInviteMailboxes } from './useContactInviteMailboxes';
import type { ContactInviteService } from '../lib/contact-invite-service';
const mock = vi.hoisted(() => ({ subscriptions: [] as Array<{ filter: unknown; handlers: { onevent(event: { id: string }): void; oneose(): void }; close: ReturnType<typeof vi.fn> }>,
  load: vi.fn(), arrival: vi.fn(), close: vi.fn() }));
vi.mock('nostr-tools', () => ({ SimplePool: class {
  subscribeMany(_relays: unknown, filter: unknown, handlers: { onevent(event: { id: string }): void; oneose(): void }) {
    const sub = { filter, handlers, close: vi.fn(async () => {}) }; mock.subscriptions.push(sub); return sub;
  }
  close = mock.close;
} }));
vi.mock('../lib/contact-invite-store', () => ({ loadContactInviteVault: mock.load, recordContactArrival: mock.arrival, conflictedContactExchanges: () => new Set() }));
vi.mock('@forgesworn/signet-contacts/adapters/invite-nostr-tools', () => ({ openContactMailboxWrap: () => ({ v: 1, key: 'a'.repeat(64), ciphertext: 'sealed' }) }));
const identity = '1'.repeat(64), inviteId = '2'.repeat(32), secret = '3'.repeat(64);
function options() {
  const service = { processAppInvites: vi.fn(async () => {}), openInbox: vi.fn(async (_now: number, _exchangesOnly: boolean) => {}), flush: vi.fn(async () => {}), cleanup: vi.fn(async () => {}) };
  return { encryptionKey: 'test', scopes: [{ directoryId: 'owner', identities: [identity] }], version: 0,
    service: vi.fn(() => service as unknown as ContactInviteService), onChanged: vi.fn(), onRequest: vi.fn(), worker: service };
}
beforeEach(() => {
  mock.subscriptions.length = 0;
  mock.load.mockResolvedValue({ invites: [{ id: inviteId, identityPubkey: identity, enabled: true, mode: 'standing', invite: { secret, relays: ['wss://relay.example'] } }], arrivals: [], exchanges: [], outbox: [] });
  mock.arrival.mockImplementation(async (_directory, _key, row) => ({ arrivals: [row], exchanges: [] }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('processes live replies immediately, subscribes only mailbox keys, and leaves ordinary requests unopened', async () => {
  const o = options(); const { unmount } = renderHook(() => useContactInviteMailboxes(o));
  await waitFor(() => expect(mock.subscriptions).toHaveLength(1));
  expect(JSON.stringify(mock.subscriptions[0].filter)).not.toContain(identity);
  await act(async () => { mock.subscriptions[0].handlers.oneose(); });
  const baseline = o.worker.openInbox.mock.calls.length;
  await act(async () => { mock.subscriptions[0].handlers.onevent({ id: '4'.repeat(64) }); });
  await waitFor(() => expect(o.worker.openInbox.mock.calls.length).toBeGreaterThan(baseline));
  expect(o.worker.openInbox.mock.calls.every(call => call[1] === true)).toBe(true);
  expect(o.onRequest).toHaveBeenCalledExactlyOnceWith('4'.repeat(64));
  unmount(); await waitFor(() => expect(mock.close).toHaveBeenCalled());
});
it('keeps subscriptions when only contact state changes, and does not notify backlog or duplicated events', async () => {
  const o = options(); const { rerender } = renderHook(({ version }) => useContactInviteMailboxes({ ...o, version }), { initialProps: { version: 0 } });
  await waitFor(() => expect(mock.subscriptions).toHaveLength(1));
  await act(async () => { mock.subscriptions[0].handlers.onevent({ id: '5'.repeat(64) }); });
  expect(o.onRequest).not.toHaveBeenCalled();
  await act(async () => { mock.subscriptions[0].handlers.oneose(); mock.subscriptions[0].handlers.onevent({ id: '5'.repeat(64) }); });
  rerender({ version: 1 }); await waitFor(() => expect(mock.load).toHaveBeenCalledTimes(3));
  expect(mock.subscriptions).toHaveLength(1); expect(mock.arrival).toHaveBeenCalledTimes(1);
});
