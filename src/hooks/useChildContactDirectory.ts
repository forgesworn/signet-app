import { useEffect, useRef, useState } from 'react';
import { RelayClient, type NostrEvent } from 'signet-protocol';
import { loadPairedChild } from '../lib/db';
import { LocalSigningBackend } from '../lib/signing-backend';
import { extractEndpointPubkey } from '../lib/dependant-status-sync';
import { isValidRelayUrl } from '../lib/relay-url';
import { CHILD_CONTACT_DIRECTORY_TAG, childDirectoryVisible, openChildContactDirectory, type ChildContactDirectory } from '../lib/child-contact-directory';
import { loadChildContactDirectoryCache, saveChildContactDirectoryCache } from '../lib/child-contact-directory-cache';

/** Separate read-only state. A directory is never folded into local operations. */
export function useChildContactDirectory(options: {
  enabled: boolean; child: string | null; key: string | null; relayUrl: string; availablePersonas: string[];
}) {
  const { enabled, child, key, relayUrl } = options;
  const personas = JSON.stringify([...options.availablePersonas].sort());
  const session = JSON.stringify([enabled, child, key, relayUrl, personas]);
  const latest = useRef(session); latest.current = session;
  const [state, setState] = useState<{ session: string; view: ChildContactDirectory } | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    setState(null);
    if (!enabled || !child || !key || !isValidRelayUrl(relayUrl)) return;
    let active = true, backend: LocalSigningBackend | undefined, relay: RelayClient | undefined;
    const current = () => active && latest.current === session;
    let queued = 0, chain = Promise.resolve();
    const clock = setInterval(() => tick(n => n + 1), 1000);
    const wake = () => tick(n => n + 1);
    document.addEventListener('visibilitychange', wake);
    void (async () => {
      const pair = await loadPairedChild(child, key);
      if (!current() || !pair?.guardianPubkey) return;
      const endpoint = extractEndpointPubkey(pair.bunkerUri);
      if (!endpoint) return;
      const cached = await loadChildContactDirectoryCache(pair, key, current);
      if (!current()) return;
      if (cached) setState({ session, view: cached });
      backend = new LocalSigningBackend(pair.clientKeypair.privateKey);
      const recipientBackend = backend;
      relay = new RelayClient(relayUrl);
      // Subscribe before connect so even a reconnect after the initial failure
      // installs the subscription. RelayClient handles its bounded retries.
      relay.subscribe([{ kinds: [30078], authors: [endpoint], '#d': [CHILD_CONTACT_DIRECTORY_TAG] } as never], event => {
        if (!current() || queued >= 32) return;
        queued++;
        chain = chain.then(async () => {
          if (!current()) return;
          const view = await openChildContactDirectory(event, { endpoint, guardian: pair.guardianPubkey!,
            recipient: pair.clientKeypair.publicKey, availablePersonas: JSON.parse(personas), backend: recipientBackend,
            now: Math.floor(Date.now() / 1000), isCurrent: current });
          if (!view || !current()) return;
          const merged = await saveChildContactDirectoryCache(pair, key, view, current);
          if (current()) setState({ session, view: merged });
        }).catch(() => { if (current()) setState(null); }).finally(() => { queued--; });
      });
      await relay.connect();
      if (!current()) relay.disconnect();
    })().catch(() => { if (current()) setState(null); });
    return () => {
      active = false; clearInterval(clock); document.removeEventListener('visibilitychange', wake);
      relay?.disconnect(); backend?.destroy();
    };
  }, [enabled, child, key, relayUrl, personas, session]);
  const view = state?.session === session ? state.view : null;
  return childDirectoryVisible(view, Math.floor(Date.now() / 1000))
    && view!.personas.every(p => options.availablePersonas.includes(p)) ? view : null;
}

/** Open-socket adapter: never queues signed events through reconnect. Each
 * change/retry creates a fresh publication with its own durable revision. */
export function useChildContactDirectoryPublisher(options: {
  enabled: boolean; session: string; changeToken: string; relayUrl: string;
  publish(send: (event: NostrEvent) => void, current: () => boolean): Promise<void>;
}) {
  const latest = useRef(options); latest.current = options;
  const { enabled, session, changeToken, relayUrl } = options;
  useEffect(() => {
    if (!enabled || !isValidRelayUrl(relayUrl)) return;
    let active = true, busy = false, socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const current = () => active && latest.current.enabled && latest.current.session === session
      && latest.current.changeToken === changeToken && latest.current.relayUrl === relayUrl;
    const run = async () => {
      if (!current() || busy) return;
      busy = true;
      let connected: WebSocket | undefined;
      const acknowledgements = new Map<string, (ok: boolean) => void>();
      const confirmations: Promise<boolean>[] = [];
      try {
        connected = new WebSocket(relayUrl); socket = connected;
        const transport = connected;
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => { reject(new Error('Directory relay timeout')); transport.close(); }, 5000);
          const fail = () => { clearTimeout(timeout); reject(new Error('Directory relay unavailable')); };
          transport.onopen = () => { clearTimeout(timeout); resolve(); };
          transport.onerror = fail; transport.onclose = fail;
        });
        if (!current()) return;
        transport.onmessage = message => {
          if (!current() || typeof message.data !== 'string' || message.data.length > 16384) return;
          try {
            const packet = JSON.parse(message.data);
            if (packet[0] === 'OK') acknowledgements.get(packet[1])?.(packet[2] === true);
          } catch { /* Malformed acknowledgements cannot confirm a publication. */ }
        };
        await latest.current.publish(event => {
          if (!current() || transport.readyState !== WebSocket.OPEN) throw new Error('Directory session or relay changed');
          confirmations.push(new Promise(resolve => {
            const timeout = setTimeout(() => { acknowledgements.delete(event.id); resolve(false); }, 5000);
            acknowledgements.set(event.id, ok => { clearTimeout(timeout); acknowledgements.delete(event.id); resolve(ok); });
          }));
          transport.send(JSON.stringify(['EVENT', event]));
        }, current);
        if ((await Promise.all(confirmations)).some(ok => !ok)) throw new Error('Directory relay did not confirm publication');
      } catch {
        if (current()) retry = setTimeout(() => { void run(); }, 5000);
      } finally {
        for (const settle of [...acknowledgements.values()]) settle(false);
        connected?.close(); if (socket === connected) socket = undefined; busy = false;
      }
    };
    const initial = setTimeout(() => { void run(); }, 1000);
    const refresh = setInterval(() => { void run(); }, 5 * 60_000);
    return () => { active = false; clearTimeout(initial); clearTimeout(retry); clearInterval(refresh); socket?.close(); };
  }, [enabled, session, changeToken, relayUrl]);
}
