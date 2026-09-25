import type { SimplePool } from 'nostr-tools/pool';

/** Upper bound on waiting for a reply subscription to be live before the
 * first request goes out — the fixed wait this replaced. */
export const RELAY_READY_CAP_MS = 3_000;

/**
 * Resolve once `pool` has a subscription on every relay equivalent to the one
 * the caller opened just before this call, or after `capMs`.
 *
 * The probe goes out on the same sockets after the caller's own REQ, and a
 * relay handles one connection's messages in order, so the probe's EOSE means
 * the caller's subscription is registered and a reply cannot be missed.
 * (In-order handling is usual relay behaviour, not a NIP-01 guarantee; a relay
 * that handles messages concurrently leaves a gap far shorter than the round
 * trip this waits for, which a fixed wait also relied on.) A relay that fails
 * to connect or closes the probe counts as settled (the pool treats a close
 * as an EOSE); the cap covers one that never answers.
 */
export function waitForReplySubscription(
  pool: SimplePool,
  relays: string[],
  filter: Parameters<SimplePool['subscribe']>[1],
  capMs: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    let probe: { close: () => void } | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { probe?.close(); } catch { /* best-effort */ }
      resolve();
    };
    const timer = setTimeout(finish, capMs);
    probe = pool.subscribe(relays, filter, { oneose: finish, onclose: finish });
  });
}
