import { useEffect, useRef, useState } from 'react';
import { RelayClient, type NostrEvent } from 'signet-protocol';
import { loadPairedChild } from '../lib/db';
import { LocalSigningBackend } from '../lib/signing-backend';
import { guardianRailPubkey } from '../lib/paired-child-rail';
import { isValidRelayUrl } from '../lib/relay-url';
import { CHILD_CONTACT_DIRECTORY_TAG, childDirectoryVisible, openChildContactDirectory, type ChildContactDirectory } from '../lib/child-contact-directory';
import { loadChildContactDirectoryCache, saveChildContactDirectoryCache } from '../lib/child-contact-directory-cache';

/** Separate read-only state. A directory is never folded into local operations. */
export function useChildContactDirectory(options: {
  enabled: boolean; child: string | null; key: string | null; relayUrl: string; availablePersonas: string[];
  /** Bumped on an in-session re-pair (App's `pairedChildBumpCounter`): the record's client key and endpoint change under the same child id. */
  pairingGeneration?: number;
}) {
  const { enabled, child, key, relayUrl, pairingGeneration = 0 } = options;
  const personas = JSON.stringify([...options.availablePersonas].sort());
  const session = JSON.stringify([enabled, child, key, relayUrl, personas, pairingGeneration]);
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
      // The guardian seals the directory with `dep.bunkerEndpoint` — the rail key on a direct pairing.
      const endpoint = guardianRailPubkey(pair);
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
 * change/retry creates a fresh publication with its own durable revision.
 *
 * One socket per relay, each with its own retry: `publish(send, current,
 * relay)` sends only the directories bound for that relay — every
 * dependant's on `relayUrl`, and on each of `extraRelays` (A56: a direct
 * child's rail relay) only the dependants that read there. */
export function useChildContactDirectoryPublisher(options: {
  enabled: boolean; session: string; changeToken: string; relayUrl: string;
  extraRelays?: readonly string[];
  publish(send: (event: NostrEvent) => void, current: () => boolean, relay: string): Promise<void>;
}) {
  const latest = useRef(options); latest.current = options;
  const { enabled, session, changeToken, relayUrl } = options;
  const extraKeyOf = (o: typeof options) => [...new Set(o.extraRelays ?? [])].filter(r => r !== o.relayUrl && isValidRelayUrl(r)).sort().join(' ');
  const extraKey = extraKeyOf(options);
  useEffect(() => {
    if (!enabled || !isValidRelayUrl(relayUrl)) return;
    const targets = [relayUrl, ...(extraKey ? extraKey.split(' ') : [])];
    let active = true;
    const busy = new Set<string>();
    const sockets = new Map<string, WebSocket>();
    const retries = new Map<string, ReturnType<typeof setTimeout>>();
    const current = () => active && latest.current.enabled && latest.current.session === session
      && latest.current.changeToken === changeToken && latest.current.relayUrl === relayUrl
      && extraKeyOf(latest.current) === extraKey;
    const run = async (target: string) => {
      if (!current() || busy.has(target)) return;
      busy.add(target);
      let connected: WebSocket | undefined;
      const acknowledgements = new Map<string, (ok: boolean) => void>();
      const confirmations: Promise<boolean>[] = [];
      try {
        connected = new WebSocket(target); sockets.set(target, connected);
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
        }, current, target);
        if ((await Promise.all(confirmations)).some(ok => !ok)) throw new Error('Directory relay did not confirm publication');
      } catch {
        if (current()) { clearTimeout(retries.get(target)); retries.set(target, setTimeout(() => { void run(target); }, 5000)); }
      } finally {
        for (const settle of [...acknowledgements.values()]) settle(false);
        connected?.close(); if (sockets.get(target) === connected) sockets.delete(target); busy.delete(target);
      }
    };
    const runAll = () => { for (const target of targets) void run(target); };
    const initial = setTimeout(runAll, 1000);
    const refresh = setInterval(runAll, 5 * 60_000);
    return () => {
      active = false; clearTimeout(initial); clearInterval(refresh);
      for (const t of retries.values()) clearTimeout(t);
      for (const s of sockets.values()) s.close();
    };
  }, [enabled, session, changeToken, relayUrl, extraKey]);
}
