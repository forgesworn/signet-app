import { useEffect, useState } from 'react';
import { botRegistrySnapshot, loadBotRegistry, type BotRecord } from '../lib/bot-registry';
export type BotMetadata = Omit<BotRecord, 'privateKey'>;
const EMPTY_BOTS: BotMetadata[] = [];
/** Carousel inventory never holds standalone private keys; stale loads cannot
 * expose a previous account's labels after a lock or account switch. */
export function useBotInventory(root: string | null, encryptionKey: string | null, version: number): BotMetadata[] {
  const [loaded, setLoaded] = useState<{ root: string; key: string; bots: BotMetadata[] }>();
  useEffect(() => {
    let current = true;
    if (!root || !encryptionKey) { setLoaded(undefined); return; }
    void loadBotRegistry(root, encryptionKey).then(registry => {
      if (current) setLoaded({ root, key: encryptionKey, bots: botRegistrySnapshot(registry).bots.sort((a, b) => a.createdAt - b.createdAt || a.publicKey.localeCompare(b.publicKey)) });
    }).catch(() => { if (current) setLoaded(undefined); });
    return () => { current = false; };
  }, [root, encryptionKey, version]);
  return loaded && loaded.root === root && loaded.key === encryptionKey ? loaded.bots : EMPTY_BOTS;
}
