import { useCallback, useEffect, useRef } from 'react';
import { loadBotAppGrants } from '../lib/bot-app-grants';
import { botAppRequestHandler } from '../lib/bot-app-requests';
import { MAX_NIP46_CONTENT } from '../lib/nip46-server';
import type { DecryptingSigningBackend } from '../lib/signing-backend';

/** Separate bot subscriptions: never install bot keys in the owner's routes.
 * Consent remains checked from encrypted storage for every incoming request. */
export function useBotAppServer(options: {
  root: string | null; encryptionKey: string | null; version: number;
  signer(botPubkey: string, current: () => boolean): Promise<DecryptingSigningBackend>;
}) {
  const latest = useRef(options); latest.current = options;
  const ready = useRef(new Set<string>());
  const readyKey = (bot: string, relay: string, grant?: string) => JSON.stringify([bot, relay, grant]);
  useEffect(() => {
    const { root, encryptionKey, signer } = options;
    ready.current.clear();
    if (!root || !encryptionKey) return;
    let active = true;
    const current = () => active && latest.current.root === root && latest.current.encryptionKey === encryptionKey && latest.current.signer === signer;
    const sockets = new Set<WebSocket>(), timers = new Set<ReturnType<typeof setTimeout>>();
    const retry = (work: () => void) => { const timer = setTimeout(() => { timers.delete(timer); if (current()) work(); }, 5000); timers.add(timer); };
    void loadBotAppGrants(root, encryptionKey).then(grants => {
      if (!current()) return;
      const now = Math.floor(Date.now() / 1000), groups = new Map<string, Set<string>>();
      for (const grant of grants) if (grant.revokedAt === undefined && grant.createdAt <= now && grant.expiresAt > now) {
        const bots = groups.get(grant.relayUrl) ?? new Set(); bots.add(grant.botPubkey); groups.set(grant.relayUrl, bots);
      }
      // Consent UI enforces this admission bound as well. Corrupt/legacy state
      // exceeding it does not open an unbounded set of relay connections.
      if (groups.size > 16) return;
      for (const [relayUrl, bots] of groups) {
        const grantKeys = grants.filter(g => bots.has(g.botPubkey) && g.relayUrl === relayUrl && g.revokedAt === undefined && g.expiresAt > now)
          .map(g => readyKey(g.botPubkey, relayUrl, g.id));
        let socket: WebSocket;
        const handlers = new Map([...bots].map(botPubkey => [botPubkey, botAppRequestHandler({ root, encryptionKey, botPubkey, relayUrl,
          isCurrent: current, signer: () => signer(botPubkey, current), publish: event => {
            if (!current() || socket.readyState !== WebSocket.OPEN || !ready.current.has(readyKey(botPubkey, relayUrl))) return false;
            socket.send(JSON.stringify(['EVENT', event])); return true;
          } })]));
        const connect = () => {
          if (!current()) return;
          try { socket = new WebSocket(relayUrl); } catch { retry(connect); return; }
          const connected = socket;
          sockets.add(connected);
          const id = `bot-app-${crypto.randomUUID()}`;
          connected.onopen = () => { if (current()) connected.send(JSON.stringify(['REQ', id, { kinds: [24133], '#p': [...bots], since: Math.floor(Date.now() / 1000) - 60 }])); };
          connected.onmessage = message => {
            if (!current() || connected !== socket || typeof message.data !== 'string' || message.data.length > MAX_NIP46_CONTENT + 16384) return;
            try {
              const packet = JSON.parse(message.data);
              if (packet[0] === 'EOSE' && packet[1] === id) {
                for (const bot of bots) ready.current.add(readyKey(bot, relayUrl));
                for (const key of grantKeys) ready.current.add(key);
              }
              if (packet[0] !== 'EVENT' || packet[1] !== id || !Array.isArray(packet[2]?.tags)) return;
              const recipients = packet[2].tags.filter((tag: unknown) => Array.isArray(tag) && tag[0] === 'p');
              if (recipients.length === 1) void handlers.get(recipients[0][1])?.(packet[2]);
            } catch { /* Malformed relay frames carry no authority. */ }
          };
          connected.onerror = () => connected.close();
          connected.onclose = () => {
            sockets.delete(connected);
            if (connected === socket) {
              for (const bot of bots) ready.current.delete(readyKey(bot, relayUrl));
              for (const key of grantKeys) ready.current.delete(key);
            }
            retry(connect);
          };
        };
        connect();
      }
    }).catch(() => { /* Missing/corrupt consent never enables signing. */ });
    return () => {
      active = false; ready.current.clear();
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) { socket.onclose = null; socket.close(); }
    };
  // The version changes only for explicit grant/bot mutations, not each render.
  }, [options.root, options.encryptionKey, options.signer, options.version]);
  const waitForReady = useCallback(async (bot: string, relay: string, grantId: string, current: () => boolean) => {
    const start = Date.now();
    while (current() && Date.now() - start < 15000) {
      if (ready.current.has(readyKey(bot, relay, grantId))) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Bot app relay is not ready. Try connecting again.');
  }, []);
  return { waitForReady };
}
