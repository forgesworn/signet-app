import { SimplePool } from 'nostr-tools';
import type { NostrEvent } from 'signet-protocol';

/**
 * Watch this screen's session for sealed reveals on its own relays, for as
 * long as the handshake screen is open. A closed connection is reopened with
 * a bounded backoff, and on returning online, so a dropped socket mid-
 * handshake recovers without another tap. The relay sees a request for the
 * session key, which is also on the screen: the same metadata a mailbox
 * watch gives, for a key that names no one.
 */
export function watchReveals(relays: string[], session: string, onEvent: (event: NostrEvent) => void): () => void {
  let stopped = false, attempt = 0, generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pool: SimplePool | undefined;
  // Closing the pool ends its subscriptions; closing a subscription itself on a
  // socket still connecting, or already gone, only throws inside the pool.
  const shut = () => {
    generation++;
    try { pool?.close(relays); } catch { /* already closed */ }
    pool = undefined;
  };
  const open = () => {
    if (stopped || !relays.length) return;
    const current = ++generation;
    pool = new SimplePool();
    pool.subscribeMany(relays, { kinds: [1059], '#p': [session], since: Math.floor(Date.now() / 1000) - 300 }, {
      oneose: () => { if (current === generation) attempt = 0; },
      onevent: event => { if (current === generation && !stopped) { attempt = 0; onEvent(event as NostrEvent); } },
      // A superseded subscription closing must not start another reconnect.
      onclose: () => { if (current === generation) retry(); },
    });
  };
  const retry = () => {
    if (stopped || timer !== undefined) return;
    const delay = Math.min(10000, 500 * 2 ** Math.min(attempt++, 5));
    timer = setTimeout(() => { timer = undefined; shut(); open(); }, delay);
  };
  const online = () => retry();
  window.addEventListener('online', online);
  open();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    window.removeEventListener('online', online);
    shut();
  };
}
