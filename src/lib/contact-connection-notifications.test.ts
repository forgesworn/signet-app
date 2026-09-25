import { expect, it, vi } from 'vitest';
import { contactConnectionNotifier, CONTACT_CONNECTION_NOTIFICATION_ID } from './contact-connection-notifications';
import type { StoredContactExchange } from './contact-invite-store';
const now = 1800000000;
function exchange(): StoredContactExchange {
  return { phase: 'complete', app: { appName: 'Private game', grantId: 'a'.repeat(32) },
    request: { from: 'b'.repeat(64), to: 'c'.repeat(64), id: 'd'.repeat(32) }, reveal: { createdAt: now } } as StoredContactExchange;
}
function setup() {
  const state = { native: true, current: true, background: true };
  const port = { checkPermissions: vi.fn(async () => ({ display: 'granted' })), createChannel: vi.fn(async () => {}),
    schedule: vi.fn(async (_options: unknown) => {}), cancel: vi.fn(async () => {}), removeDeliveredNotificationsById: vi.fn(async () => {}) };
  return { state, port, notifier: contactConnectionNotifier({ port, native: () => state.native,
    current: () => state.current, background: () => state.background, now: () => now }) };
}
it('posts one generic notification for a new background app connection without identity metadata', async () => {
  const { notifier, port } = setup(), row = exchange();
  await Promise.all([notifier.completed(row), notifier.completed(row)]);
  expect(port.schedule).toHaveBeenCalledTimes(1);
  const payload = port.schedule.mock.calls[0]![0];
  expect(payload).toEqual({ notifications: [{ id: CONTACT_CONNECTION_NOTIFICATION_ID, channelId: 'signet-contacts',
      title: 'New contact connection', body: expect.stringContaining('without a word check'), smallIcon: 'ic_stat_signet', isExactNotification: false }] });
  expect(JSON.stringify(payload)).not.toContain('Private game');
  expect(JSON.stringify(payload)).not.toContain(row.request.from);
  await notifier.stop();
  expect(port.removeDeliveredNotificationsById).toHaveBeenCalledWith({ ids: [CONTACT_CONNECTION_NOTIFICATION_ID] });
});
it('does not prompt or notify for denied permission, foreground, web, old or already recorded exchanges', async () => {
  const { notifier, port, state } = setup(), row = exchange();
  state.native = false; await notifier.completed(row);
  state.native = true; state.background = false; await notifier.completed(row);
  state.background = true;
  await notifier.completed({ ...row, contactId: 'saved' });
  await notifier.completed({ ...row, wordsConfirmedAt: now });
  await notifier.completed({ ...row, app: undefined });
  await notifier.completed({ ...row, reveal: { ...row.reveal!, createdAt: now - 301 } });
  await notifier.completed({ ...row, reveal: { ...row.reveal!, createdAt: now + 1 } });
  expect(port.checkPermissions).not.toHaveBeenCalled();
  port.checkPermissions.mockResolvedValue({ display: 'denied' }); await notifier.completed(row);
  expect(port.createChannel).not.toHaveBeenCalled(); expect(port.schedule).not.toHaveBeenCalled();
  await notifier.stop();
});
it('refuses late permission results after lock and cancels late scheduling before a new account posts', async () => {
  const first = setup();
  let allow!: () => void;
  first.port.checkPermissions.mockImplementation(() => new Promise(resolve => { allow = () => resolve({ display: 'granted' }); }));
  const pending = first.notifier.completed(exchange());
  await vi.waitFor(() => expect(allow).toBeTypeOf('function'));
  first.state.current = false; allow(); await pending;
  expect(first.port.schedule).not.toHaveBeenCalled(); await first.notifier.stop();
  const old = setup(), next = setup(), order: string[] = [];
  let release!: () => void;
  old.port.schedule.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  old.port.cancel.mockImplementation(async () => { order.push('cancel old'); });
  next.port.schedule.mockImplementation(async () => { order.push('post new'); });
  const sending = old.notifier.completed(exchange());
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const stopping = old.notifier.stop(), newer = next.notifier.completed(exchange());
  release(); await Promise.all([sending, stopping, newer]);
  expect(order.at(-1)).toBe('post new'); expect(order.slice(0, -1)).toEqual(['cancel old', 'cancel old']);
  await next.notifier.stop();
});
it('keeps native plugin failures out of the contact completion path', async () => {
  const { notifier, port } = setup();
  port.schedule.mockRejectedValue(new Error('OS unavailable'));
  await expect(notifier.completed(exchange())).resolves.toBeUndefined();
  await notifier.stop();
});
it('removes the delivered notice even when cancelling its pending timer fails', async () => {
  const { notifier, port } = setup();
  port.cancel.mockRejectedValue(new Error('Pending timer unavailable'));
  await notifier.stop();
  expect(port.removeDeliveredNotificationsById).toHaveBeenCalledWith({ ids: [CONTACT_CONNECTION_NOTIFICATION_ID] });
});
