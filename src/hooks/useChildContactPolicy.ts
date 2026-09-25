import { useEffect, useRef, useState } from 'react';
import { RelayClient, type NostrEvent } from 'signet-protocol';
import { loadPairedChild } from '../lib/db';
import { LocalSigningBackend } from '../lib/signing-backend';
import { extractEndpointPubkey } from '../lib/dependant-status-sync';
import { isValidRelayUrl } from '../lib/relay-url';
import { CHILD_CONTACT_POLICY_TAG, openChildContactPolicy, type ChildContactPolicyView } from '../lib/child-contact-policy-wire';
import { loadChildContactPolicyCache, saveChildContactPolicyCache } from '../lib/child-contact-policy-cache';

/** Short-lived advisory policy; no signing authority or identity keys delivered. */
export function useChildContactPolicy(options: { enabled: boolean; child: string | null; key: string | null; relayUrl: string }) {
  const { enabled, child, key, relayUrl } = options;
  const session = JSON.stringify([enabled, child, key, relayUrl]);
  const [state, setState] = useState<{ session: string; view: ChildContactPolicyView } | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!enabled || !child || !key || !isValidRelayUrl(relayUrl)) return;
    let active = true, backend: LocalSigningBackend | undefined, relay: RelayClient | undefined;
    let queued = 0, chain = Promise.resolve();
    const clock = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 10_000);
    void (async () => {
      const pair = await loadPairedChild(child, key);
      if (!active || !pair?.guardianPubkey) return;
      const endpoint = extractEndpointPubkey(pair.bunkerUri);
      if (!endpoint) return;
      const cached = await loadChildContactPolicyCache(pair, key);
      if (!active) return;
      if (cached) setState({ session, view: cached });
      backend = new LocalSigningBackend(pair.clientKeypair.privateKey);
      const recipientBackend = backend;
      relay = new RelayClient(relayUrl);
      await relay.connect();
      if (!active) { relay.disconnect(); return; }
      relay.subscribe([{ kinds: [30078], authors: [endpoint], '#d': [CHILD_CONTACT_POLICY_TAG] } as never], event => {
        if (!active || queued >= 32) return;
        queued++;
        chain = chain.then(async () => {
          if (!active) return;
          const view = await openChildContactPolicy(event, { endpoint, guardian: pair.guardianPubkey!, recipient: pair.clientKeypair.publicKey,
            backend: recipientBackend, now: Math.floor(Date.now() / 1000) });
          if (!view || !active) return;
          const merged = await saveChildContactPolicyCache(pair, key, view);
          if (active) { setNow(Math.floor(Date.now() / 1000)); setState({ session, view: merged }); }
        }).catch(() => { if (active) setState(null); }).finally(() => { queued--; });
      });
    })().catch(() => { if (active) setState(null); });
    return () => { active = false; clearInterval(clock); relay?.disconnect(); backend?.destroy(); };
  }, [enabled, child, key, relayUrl, session]);
  const view = state?.session === session ? state.view : null;
  return view && view.expiresAt > now && view.revision <= now + 300 ? view : null;
}

/** Re-publish at five-minute intervals and after local changes; expiry remains
 * fifteen minutes, so a disconnected guardian's cached view becomes unavailable. */
export function useChildContactPolicyPublisher(options: {
  enabled: boolean; session: string; changeToken: string; relayUrl: string;
  build: () => Promise<NostrEvent[]>;
}) {
  const { enabled, session, changeToken, relayUrl } = options;
  const buildRef = useRef(options.build); buildRef.current = options.build;
  useEffect(() => {
    if (!enabled || !isValidRelayUrl(relayUrl)) return;
    let active = true, busy = false, relay: RelayClient | undefined;
    const run = async () => {
      if (!active || busy) return;
      busy = true;
      try {
        const events = await buildRef.current();
        if (!active || !events.length) return;
        relay = new RelayClient(relayUrl);
        await relay.connect();
        for (const event of events) { if (!active) return; await relay.publish(event); }
      } catch { /* Retry on the next refresh. Child views expire, never widen. */ }
      finally { relay?.disconnect(); relay = undefined; busy = false; }
    };
    const timer = setTimeout(() => { void run(); }, 1000);
    const refresh = setInterval(() => { void run(); }, 5 * 60_000);
    return () => { active = false; clearTimeout(timer); clearInterval(refresh); relay?.disconnect(); };
  }, [enabled, session, changeToken, relayUrl]);
}
