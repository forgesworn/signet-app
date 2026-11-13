/**
 * The real single-relay NIP-46 probe behind `signer-relay-recovery.ts`.
 *
 * Each call builds its OWN client on ONE relay: `BunkerSigner.fromBunker` with
 * this install's existing client secret, `pubkey` = the link's master, no
 * secret, and NO `connect`. It sends `get_public_key`, which an authorised
 * client gets auto-approved with no press and no state change on the device.
 *
 * The client, its pool and the secret bytes are torn down when the call ends:
 * on a reply, an error, a timeout or an abort (lock). The URI and the secret
 * are never logged, stored or shown.
 */
import { BunkerSigner } from 'nostr-tools/nip46';
import { SimplePool } from 'nostr-tools/pool';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import { waitForReplySubscription, RELAY_READY_CAP_MS } from './relay-ready';
import type { ProbeOne } from './signer-relay-recovery';

export function createBunkerProbe(clientSecretHex: string, masterHex: string): ProbeOne {
  return async (relay, signal) => {
    if (signal.aborted) throw new Error('aborted');
    const sk = hexToBytes(clientSecretHex);
    const pool = new SimplePool();
    let signer: BunkerSigner | null = null;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (signer) void signer.close().catch(() => { /* best-effort teardown */ });
      try { pool.destroy(); } catch { /* best-effort teardown */ }
      sk.fill(0);
    };
    const aborted = new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => { cleanup(); reject(new Error('aborted')); }, { once: true });
    });
    aborted.catch(() => { /* observed via the race */ });
    try {
      const work = (async () => {
        const clientPub = getPublicKey(sk);
        signer = BunkerSigner.fromBunker(sk, { pubkey: masterHex, relays: [relay], secret: null }, {
          pool,
          onauth() { /* an auth_url prompt needs no action here */ },
        });
        // The reply subscription must be live before the request goes out.
        await waitForReplySubscription(pool, [relay], {
          kinds: [24133],
          authors: [masterHex],
          '#p': [clientPub],
          limit: 0,
        }, Math.min(RELAY_READY_CAP_MS, 3_000));
        if (signal.aborted) throw new Error('aborted');
        return await signer.getPublicKey();
      })();
      work.catch(() => { /* observed via the race */ });
      return await Promise.race([work, aborted]);
    } finally {
      cleanup();
    }
  };
}
