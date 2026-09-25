import { useEffect, useRef } from 'react';
import { loadBotRegistry } from '../lib/bot-registry';
import type { BotOwnershipService } from '../lib/bot-ownership-service';
/** Existing ownership claims may renew while unlocked. Hardware signing remains
 * an ordinary device approval; failed attempts are durably throttled per bot. */
export function useBotOwnership(options: {
  root: string | null; encryptionKey: string | null; session: string;
  service(isCurrent: () => boolean): BotOwnershipService;
}) {
  const latest = useRef(options); latest.current = options;
  useEffect(() => {
    if (!options.root || !options.encryptionKey) return;
    let stopped = false, running = false;
    const current = () => !stopped;
    const run = async () => {
      if (stopped || running) return;
      running = true;
      const service = latest.current.service(current);
      try {
        const registry = await loadBotRegistry(options.root!, options.encryptionKey!);
        for (const bot of registry.bots) {
          if (!current()) return;
          if (!bot.ownership || bot.removedAt !== undefined) continue;
          try { await service.renew(bot.publicKey, Math.floor(Date.now() / 1000)); }
          catch { /* A refused hardware request must not stall other bots. */ }
        }
        if (current()) await service.flush(Math.floor(Date.now() / 1000));
      } catch { /* Signed publication remains durable for retry. */ }
      finally { running = false; }
    };
    void run();
    const timer = setInterval(() => { void run(); }, 60000);
    const online = () => { void run(); };
    window.addEventListener('online', online);
    return () => { stopped = true; clearInterval(timer); window.removeEventListener('online', online); };
  }, [options.root, options.encryptionKey, options.session]);
}
