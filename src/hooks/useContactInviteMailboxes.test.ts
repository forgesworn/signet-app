// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useContactInviteMailboxes } from './useContactInviteMailboxes';
import type { ContactInviteService } from '../lib/contact-invite-service';
const mocks = vi.hoisted(() => ({ load: vi.fn(), subscribe: vi.fn(), close: vi.fn(), plan: vi.fn() }));
vi.mock('nostr-tools', () => ({ SimplePool: class { subscribeMany = mocks.subscribe; close = mocks.close; } }));
vi.mock('../lib/contact-invite-store', () => ({ loadContactInviteVault: mocks.load, recordContactArrival: vi.fn() }));
vi.mock('../lib/contact-mailbox-plan', () => ({ contactMailboxPlan: mocks.plan }));
afterEach(() => vi.clearAllMocks());
it('waits for subscription closure before replacing pools or opening new connections', async () => {
  mocks.load.mockResolvedValue({ arrivals: [], outbox: [] });
  mocks.plan.mockReturnValue({ bindings: [{ id: 'a'.repeat(32), secret: '01'.repeat(32),
    relays: ['wss://relay.test'], channel: 'invite' }], deferred: 0 });
  let finish!: () => void;
  const closed = new Promise<void>(resolve => { finish = resolve; });
  mocks.subscribe.mockReturnValueOnce({ close: () => closed }).mockReturnValue({ close: async () => {} });
  const service = { cleanup: vi.fn(async () => {}), processAppInvites: vi.fn(async () => {}), openInbox: vi.fn(async () => {}), flush: vi.fn(async () => {}) } as unknown as ContactInviteService;
  const options = { encryptionKey: 'key', scopes: [{ directoryId: 'owner', identities: ['a'.repeat(64)] }],
    service: () => service, onChanged: vi.fn() };
  const { rerender, unmount } = renderHook(({ version }) => useContactInviteMailboxes({ ...options, version }), { initialProps: { version: 0 } });
  await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
  rerender({ version: 1 });
  await act(async () => { await Promise.resolve(); });
  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.subscribe).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });
  await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));
  expect(mocks.close).toHaveBeenCalledTimes(1);
  unmount();
  await waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(2));
});
