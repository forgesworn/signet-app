import { useEffect, useRef } from 'react';
import { runBackdropBackfill } from '../lib/backdrop-backfill';
import { backdropDigest } from '../lib/backdrop-digest';
import { getCardBackdrop } from '../lib/db';
import type { DependantBackdropLookup } from '../lib/backdrop-send-context';

export interface UseBackdropBackfillOpts {
  /** Guardian install, unlocked, dependants read with the key, Blossom consent on. Never on a paired-child install. */
  enabled: boolean;
  encryptionKey: string | null;
  slotPubkeys: readonly string[];
  /** Rebuilt whenever the dependants change; the hook uses the latest. */
  lookup: DependantBackdropLookup;
  /** Test seams. */
  readLocal?: (pubkey: string) => Promise<Blob | null>;
  digest?: (blob: Blob) => Promise<string>;
}

/**
 * Once the dependants are loaded after an unlock, send every card backdrop the
 * child's phone is missing (`runBackdropBackfill`). One run at a time; a change
 * that lands mid-run (every send reloads the dependants) queues one more pass,
 * which skips what was already tried this unlock.
 */
export function useBackdropBackfill(opts: UseBackdropBackfillOpts): void {
  const latest = useRef(opts);
  latest.current = opts;
  const attempted = useRef(new Map<string, number>());
  const attemptedFor = useRef<string | null>(null);
  const running = useRef(false);
  const again = useRef(false);

  useEffect(() => {
    const { enabled, encryptionKey } = opts;
    // A new unlock starts a new set; a lock empties it.
    if (attemptedFor.current !== encryptionKey) {
      attemptedFor.current = encryptionKey;
      attempted.current = new Map();
    }
    if (!enabled || !encryptionKey) return;
    if (running.current) { again.current = true; return; }
    running.current = true;
    void (async () => {
      try {
        do {
          again.current = false;
          const key = latest.current.encryptionKey;
          if (!latest.current.enabled || !key) break;
          await runBackdropBackfill({
            slotPubkeys: () => latest.current.slotPubkeys,
            lookup: () => latest.current.lookup,
            readLocal: latest.current.readLocal ?? (pk => getCardBackdrop(pk)),
            digest: latest.current.digest ?? backdropDigest,
            attempted: attempted.current,
            isLive: () => latest.current.enabled && latest.current.encryptionKey === key,
          });
        } while (again.current);
      } finally {
        running.current = false;
      }
    })();
  }, [opts.enabled, opts.encryptionKey, opts.slotPubkeys, opts.lookup]); // eslint-disable-line react-hooks/exhaustive-deps
}
