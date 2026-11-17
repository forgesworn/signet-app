import { useCallback, useEffect, useRef, useState } from 'react';
import { RelayClient, type NostrEvent } from 'signet-protocol';
import { isValidRelayUrl } from '../lib/relay-url';
import { LocalSigningBackend } from '../lib/signing-backend';
import { openChildContactRequest, storeChildContactRequest, type ChildRequestReceipt, type ChildRequestScope } from '../lib/child-contact-requests';
import { guardianChildContactHistory, loadChildContactLifecycle } from '../lib/child-contact-lifecycle';
import type { ChildContactExchangePlan } from '../lib/child-contact-review';

export interface GuardianChildRequestSource {
  scope: ChildRequestScope; endpointPrivateKey: string;
  /** A56: a direct child's rail relay (`childRailRelay`) — the child asks there, and replies must reach it. */
  railRelay?: string;
}
export interface GuardianChildRequest { source: GuardianChildRequestSource; receipt: ChildRequestReceipt }
/** A request that stopped partway (D3). Only an explicit Cancel resolves it. */
export interface GuardianChildStuckRequest { source: GuardianChildRequestSource; plan: ChildContactExchangePlan }

/** Requests waiting to be opened, per relay: a relay flooding junk fills only its own queue. */
export const CHILD_REQUEST_QUEUE_PER_RELAY = 64;

/**
 * The relay each source's child asks on, grouped: `relayUrl` for a legacy
 * child (and a direct child without a distinct rail relay), the rail relay for
 * a direct child (A56). Each relay's subscription names only its own children.
 */
export function childRequestRelayGroups(sources: readonly GuardianChildRequestSource[], relayUrl: string): Map<string, GuardianChildRequestSource[]> {
  const groups = new Map<string, GuardianChildRequestSource[]>();
  for (const source of sources) {
    const relay = source.railRelay && isValidRelayUrl(source.railRelay) ? source.railRelay : relayUrl;
    groups.set(relay, [...(groups.get(relay) ?? []), source]);
  }
  return groups;
}

export function useGuardianChildContactRequests(options: {
  enabled: boolean; key: string | null; relayUrl: string; sources: () => Promise<GuardianChildRequestSource[]>; changeToken: string;
  /** A56: every direct child's rail relay (`childRailExtraRelays`). The listener restarts when this set changes. */
  extraRelays?: readonly string[];
  /** Sweep a stuck row whose request expiry has passed (D3), or an approval
   * whose exchange expired unanswered. */
  expireStuck?(item: GuardianChildStuckRequest, current: () => boolean): Promise<void>;
  /** Retry queued, unacknowledged replies with their stored signed events. */
  retryReplies?(source: GuardianChildRequestSource, current: () => boolean): Promise<void>;
}) {
  const { enabled, key, relayUrl, sources, changeToken } = options;
  const extraKeyOf = (o: typeof options) => [...new Set(o.extraRelays ?? [])].filter(r => r !== o.relayUrl && isValidRelayUrl(r)).sort().join(' ');
  const extraKey = extraKeyOf(options);
  const latest = useRef(options); latest.current = options;
  // Moves after every decision so a reviewed request cannot resurface (D1).
  const [version, setVersion] = useState(0);
  const versionRef = useRef(version); versionRef.current = version;
  const reload = useCallback(() => setVersion(v => v + 1), []);
  const session = JSON.stringify([enabled, key, relayUrl, extraKey, changeToken, version]);
  const [requests, setRequests] = useState<GuardianChildRequest[]>([]);
  const [stuck, setStuck] = useState<GuardianChildStuckRequest[]>([]);
  // D4: the 10 most recently updated terminal receipts per source, read-only
  // over the same lifecycle load — no separate fetch, no new retention.
  const [history, setHistory] = useState<GuardianChildRequest[]>([]);
  useEffect(() => {
    setRequests([]); setStuck([]); setHistory([]);
    if (!enabled || !key || !isValidRelayUrl(relayUrl)) return;
    let active = true;
    const relays: RelayClient[] = [];
    const backends: LocalSigningBackend[] = [];
    const current = () => active && latest.current.enabled && latest.current.key === key && latest.current.relayUrl === relayUrl
      && extraKeyOf(latest.current) === extraKey && latest.current.changeToken === changeToken && versionRef.current === version;
    void (async () => {
      const rows = await sources(); if (!current()) return;
      const stuckIds = new Set<string>();
      for (const source of rows) {
        const now = Math.floor(Date.now() / 1000);
        let lifecycle = await loadChildContactLifecycle(source.scope, key, now, current);
        // Stuck rows past their request expiry, and approvals whose exchange can
        // no longer complete, are both swept to expired.
        const expired = [...lifecycle.stuck.filter(plan => plan.request.expiresAt <= now), ...lifecycle.abandoned];
        if (expired.length && latest.current.expireStuck) {
          for (const plan of expired) {
            try { await latest.current.expireStuck({ source, plan }, current); } catch { if (!current()) return; }
          }
          lifecycle = await loadChildContactLifecycle(source.scope, key, Math.floor(Date.now() / 1000), current);
        }
        if (!current()) return;
        for (const plan of lifecycle.stuck) stuckIds.add(`${source.scope.client}:${plan.requestId}`);
        setStuck(old => [...old, ...lifecycle.stuck.map(plan => ({ source, plan }))]);
        setRequests(old => [...old, ...lifecycle.receipts.filter(r => r.status === 'pending' && !stuckIds.has(`${source.scope.client}:${r.id}`))
          .map(receipt => ({ source, receipt }))]);
        setHistory(old => [...old, ...guardianChildContactHistory(lifecycle.receipts).map(receipt => ({ source, receipt }))]);
        try { await latest.current.retryReplies?.(source, current); } catch { if (!current()) return; }
      }
      // One chain per child, whichever relay the event came from.
      const chains = new Map<string, Promise<void>>();
      // The same event (id is checked by the relay client) arriving on two
      // relays, or replayed on a reconnect, is processed once: held while in
      // flight, and kept only once it opened as this child's request and was
      // stored, so junk cannot grow the set and a failed store can try again.
      const seen = new Set<string>();
      for (const [url, group] of childRequestRelayGroups(rows, relayUrl)) {
        if (!current()) return;
        const relay = new RelayClient(url); relays.push(relay);
        let queued = 0;
        for (const source of group) {
          const backend = new LocalSigningBackend(source.endpointPrivateKey); backends.push(backend);
          relay.subscribe([{ kinds: [30078], authors: [source.scope.client] } as never], (event: NostrEvent) => {
            // Another author is never this child's request; it takes no queue place.
            if (!current() || event?.pubkey !== source.scope.client || queued >= CHILD_REQUEST_QUEUE_PER_RELAY || seen.has(event.id)) return;
            queued++; seen.add(event.id);
            let kept = false;
            const chain = (chains.get(source.scope.client) ?? Promise.resolve()).then(async () => {
              const opened = await openChildContactRequest(event, { scope: source.scope, endpoint: backend, now: Math.floor(Date.now() / 1000), isCurrent: current });
              if (!opened || !current()) return;
              const receipt = await storeChildContactRequest({ scope: source.scope, key, request: opened.request, fingerprint: opened.fingerprint, now: Math.floor(Date.now() / 1000), isCurrent: current });
              kept = true;
              if (current() && receipt.status === 'pending' && !stuckIds.has(`${source.scope.client}:${receipt.id}`))
                setRequests(old => old.some(item => item.source.scope.client === source.scope.client && item.receipt.id === receipt.id) ? old : [...old, { source, receipt }]);
            }).catch(() => {}).finally(() => { queued--; if (!kept) seen.delete(event.id); });
            chains.set(source.scope.client, chain);
          });
        }
      }
      // Each relay on its own: one that is down never holds up the others
      // (the relay client keeps retrying it and re-subscribes on reconnect).
      await Promise.all(relays.map(relay => relay.connect().catch(() => {})));
      if (!current()) for (const relay of relays) relay.disconnect();
    })().catch(() => { if (current()) { setRequests([]); setStuck([]); setHistory([]); } });
    return () => { active = false; for (const relay of relays) relay.disconnect(); for (const backend of backends) backend.destroy(); };
  }, [enabled, key, relayUrl, extraKey, sources, changeToken, version, session]);
  const pending = requests.filter(item => item.receipt.status === 'pending');
  return { pending, pendingCount: pending.length, stuck, history, reload };
}
