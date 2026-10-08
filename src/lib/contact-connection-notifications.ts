import { HANDSHAKE_COPY } from './contacts-v2-copy';
import { contactExchangeKey } from './contact-exchange-key';
import type { StoredContactExchange } from './contact-invite-store';

// Separate from approval handles and escalation IDs (1,000,000–1,899,999).
export const CONTACT_CONNECTION_NOTIFICATION_ID = 1_900_001;
export const CONTACT_REQUEST_NOTIFICATION_ID = 1_900_002;
interface NotificationPort {
  checkPermissions(): Promise<{ display: string }>;
  createChannel(channel: { id: string; name: string; description: string; importance: 3; visibility: 0 }): Promise<unknown>;
  schedule(options: { notifications: { id: number; channelId: string; title: string; body: string; smallIcon: string; isExactNotification: false }[] }): Promise<unknown>;
  cancel(options: { notifications: { id: number }[] }): Promise<unknown>;
  removeDeliveredNotificationsById(options: { ids: number[] }): Promise<unknown>;
}
// Account changes must not let an old async cancellation dismiss a newer
// account's notification. All native work shares this small serial queue.
let queue: Promise<unknown> = Promise.resolve();
function serial(job: () => Promise<void>): Promise<void> {
  const result = queue.then(job, job); queue = result.catch(() => {}); return result;
}
export function contactConnectionNotifier(options: {
  port: NotificationPort; native(): boolean; current(): boolean; background(): boolean; now?(): number;
}) {
  const seen = new Set<string>();
  let stopped = false;
  const current = () => !stopped && options.native() && options.current();
  const cancel = async () => {
    const notification = { notifications: [{ id: CONTACT_CONNECTION_NOTIFICATION_ID }, { id: CONTACT_REQUEST_NOTIFICATION_ID }] };
    // Capacitor distinguishes pending timers from notices already in the tray.
    try { await options.port.cancel(notification); }
    finally { await options.port.removeDeliveredNotificationsById({ ids: [CONTACT_CONNECTION_NOTIFICATION_ID] });
      await options.port.removeDeliveredNotificationsById({ ids: [CONTACT_REQUEST_NOTIFICATION_ID] }); }
  };
  return {
    /** Live mailbox arrival only. Generic copy reveals no unverified sender. */
    requested(arrivalId: string): Promise<void> {
      return serial(async () => {
        if (!current() || seen.has(arrivalId) || seen.size >= 512) return;
        if ((await options.port.checkPermissions()).display !== 'granted' || !current()) return;
        await options.port.createChannel({ id: 'signet-contacts', name: 'Contact connections',
          description: 'Contact requests to review in Signet', importance: 3, visibility: 0 });
        if (!current()) return;
        await options.port.schedule({ notifications: [{ id: CONTACT_REQUEST_NOTIFICATION_ID, channelId: 'signet-contacts',
          title: HANDSHAKE_COPY.requestTitle, body: HANDSHAKE_COPY.requestBody,
          smallIcon: 'ic_stat_signet', isExactNotification: false }] });
        if (!current()) { await cancel(); return; }
        seen.add(arrivalId);
      }).catch(() => {});
    },
    /** Call only after the authenticated exchange's contact write succeeds.
     * Generic lock-screen copy: no names, keys, app names, IDs or deep links. */
    completed(exchange: StoredContactExchange): Promise<void> {
      return serial(async () => {
        if (!current() || !options.background() || !exchange.app || exchange.contactId || exchange.wordsConfirmedAt
          || exchange.phase !== 'complete' || !exchange.reveal) return;
        const now = options.now?.() ?? Math.floor(Date.now() / 1000);
        if (exchange.reveal.createdAt > now || exchange.reveal.createdAt < now - 300) return;
        const id = contactExchangeKey(exchange.request);
        if (seen.has(id) || seen.size >= 512) return;
        if ((await options.port.checkPermissions()).display !== 'granted' || !current() || !options.background()) return;
        await options.port.createChannel({ id: 'signet-contacts', name: 'Contact connections',
          description: 'New app connections to review in Signet', importance: 3, visibility: 0 });
        if (!current() || !options.background()) return;
        await options.port.schedule({ notifications: [{ id: CONTACT_CONNECTION_NOTIFICATION_ID, channelId: 'signet-contacts',
          title: 'New contact connection', body: 'An app connection was added without a word check. Open Signet to review your contacts.',
          // Immediate notice: never invoke Android's exact-alarm consent flow.
          smallIcon: 'ic_stat_signet', isExactNotification: false }] });
        if (!current()) { await cancel(); return; }
        seen.add(id);
      }).catch(() => { /* Notifications never affect contact persistence. */ });
    },
    stop(): Promise<void> {
      stopped = true;
      return serial(async () => { if (options.native()) await cancel(); }).catch(() => {});
    },
  };
}
