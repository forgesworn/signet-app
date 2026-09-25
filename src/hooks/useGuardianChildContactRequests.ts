import { useCallback, useEffect, useRef, useState } from 'react';
import { RelayClient } from 'signet-protocol';
import { isValidRelayUrl } from '../lib/relay-url';
import { LocalSigningBackend } from '../lib/signing-backend';
import { openChildContactRequest, storeChildContactRequest, type ChildRequestReceipt, type ChildRequestScope } from '../lib/child-contact-requests';
import { guardianChildContactHistory, loadChildContactLifecycle } from '../lib/child-contact-lifecycle';
import type { ChildContactExchangePlan } from '../lib/child-contact-review';

export interface GuardianChildRequestSource { scope: ChildRequestScope; endpointPrivateKey: string }
export interface GuardianChildRequest { source: GuardianChildRequestSource; receipt: ChildRequestReceipt }
/** A request that stopped partway (D3). Only an explicit Cancel resolves it. */
export interface GuardianChildStuckRequest { source: GuardianChildRequestSource; plan: ChildContactExchangePlan }
export function useGuardianChildContactRequests(options: {
  enabled: boolean; key: string | null; relayUrl: string; sources: () => Promise<GuardianChildRequestSource[]>; changeToken: string;
  /** Sweep a stuck row whose request expiry has passed (D3), or an approval
   * whose exchange expired unanswered. */
  expireStuck?(item: GuardianChildStuckRequest, current: () => boolean): Promise<void>;
  /** Retry queued, unacknowledged replies with their stored signed events. */
  retryReplies?(source: GuardianChildRequestSource, current: () => boolean): Promise<void>;
}) {
  const { enabled, key, relayUrl, sources, changeToken } = options;
  const latest = useRef(options); latest.current = options;
  // Moves after every decision so a reviewed request cannot resurface (D1).
  const [version, setVersion] = useState(0);
  const versionRef = useRef(version); versionRef.current = version;
  const reload = useCallback(() => setVersion(v => v + 1), []);
  const session = JSON.stringify([enabled, key, relayUrl, changeToken, version]);
  const [requests, setRequests] = useState<GuardianChildRequest[]>([]);
  const [stuck, setStuck] = useState<GuardianChildStuckRequest[]>([]);
  // D4: the 10 most recently updated terminal receipts per source, read-only
  // over the same lifecycle load — no separate fetch, no new retention.
  const [history, setHistory] = useState<GuardianChildRequest[]>([]);
  useEffect(() => {
    setRequests([]); setStuck([]); setHistory([]);
    if (!enabled || !key || !isValidRelayUrl(relayUrl)) return;
    let active = true, relay: RelayClient | undefined, queued = 0;
    const backends: LocalSigningBackend[] = [];
    const current = () => active && latest.current.enabled && latest.current.key === key && latest.current.relayUrl === relayUrl
      && latest.current.changeToken === changeToken && versionRef.current === version;
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
      relay = new RelayClient(relayUrl);
      for (const source of rows) {
        if (!current()) return;
        const backend = new LocalSigningBackend(source.endpointPrivateKey); backends.push(backend);
        let chain = Promise.resolve();
        relay.subscribe([{ kinds: [30078], authors: [source.scope.client] } as never], event => {
          if (!current() || queued >= 64) return; queued++;
          chain = chain.then(async () => {
            const opened = await openChildContactRequest(event, { scope: source.scope, endpoint: backend, now: Math.floor(Date.now() / 1000), isCurrent: current });
            if (!opened || !current()) return;
            const receipt = await storeChildContactRequest({ scope: source.scope, key, request: opened.request, fingerprint: opened.fingerprint, now: Math.floor(Date.now() / 1000), isCurrent: current });
            if (current() && receipt.status === 'pending' && !stuckIds.has(`${source.scope.client}:${receipt.id}`))
              setRequests(old => old.some(item => item.source.scope.client === source.scope.client && item.receipt.id === receipt.id) ? old : [...old, { source, receipt }]);
          }).catch(() => {}).finally(() => { queued--; });
        });
      }
      await relay.connect(); if (!current()) relay.disconnect();
    })().catch(() => { if (current()) { setRequests([]); setStuck([]); setHistory([]); } });
    return () => { active = false; relay?.disconnect(); for (const backend of backends) backend.destroy(); };
  }, [enabled, key, relayUrl, sources, changeToken, version, session]);
  const pending = requests.filter(item => item.receipt.status === 'pending');
  return { pending, pendingCount: pending.length, stuck, history, reload };
}
