/**
 * Backlog fetch + live subscription for escalation notices (C4/C5).
 *
 * A guardian device that parks a request pending same-device approval, or
 * that receives a paired-child petition for a decision, publishes a
 * kind-31001 gift-wrapped notice addressed to the guardian's own pubkey
 * (see `lib/escalation-fetch.ts`). This hook is the "Family asks" inbox:
 * one backlog fetch on mount/arg-change, then a resident live subscription
 * so new asks show up without a manual refresh — mirrors the
 * `subscribePersonaInventory` + `usePersonaInventory` idiom for the
 * live-subscription-with-cleanup shape, and `useAuditLog`'s own-RelayClient
 * + validation-preflight + generation-guard shape for the one-shot half.
 *
 * Non-escalation 1059s addressed to the guardian (audit wraps, persona-sync
 * wraps) fail `unwrapEscalationNotice`'s kind/tag gate and are skipped
 * silently — the same inbox coexistence pattern as the audit consumer.
 *
 * **Live-vs-backlog decision lives here, not in the caller.** `onLiveNotice`
 * fires only from the live `subscribe` callback, only for an id genuinely
 * new to THIS effect run's session (`knownIds`, seeded from the backlog and
 * extended as live events land) — never for anything the backlog fetch
 * turned up. Because `knownIds` is re-seeded fresh on every effect re-run,
 * this stays correct no matter WHY the effect re-ran (args going from
 * disabled→enabled, a relay-URL edit mid-session, a Heartwood reconnect
 * swapping `backend`, a guardian-pubkey change) — a caller-side "have I
 * seen this before" baseline would have to be reset in lockstep with every
 * one of those triggers to stay correct; keeping the decision here means
 * there's only one thing to get right.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NostrEvent } from 'signet-protocol';
import { fetchEvents, subscribeEvents } from '../lib/relay-service';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import {
  unwrapEscalationNotice,
  parseEscalationNotice,
  coalesceNotices,
  type EscalationNotice,
} from '../lib/escalation-fetch';
import { isValidRelayUrl } from '../lib/relay-url';

const BACKLOG_LIMIT = 100;
const RETAINED_CAP = 50;
const HEX64 = /^[0-9a-f]{64}$/i;

export interface UseEscalationsArgs {
  relayUrl?: string;
  guardianPubkey?: string;                     // NP hex — wrap recipient AND expected signer
  backend: DecryptingSigningBackend | null;    // guardianAuditBackend
  enabled: boolean;                             // bunker mode + unlocked
  /**
   * Fires once per notice id that arrives via the LIVE subscription and
   * wasn't already known to this effect run (backlog included) — never for
   * backlog items, never twice for a coalesce-replace of an id already
   * seen. Held in a ref internally, so passing a new closure each render
   * does not tear down / re-open the subscription.
   */
  onLiveNotice?: (notice: EscalationNotice) => void;
}

export interface UseEscalationsReturn {
  notices: EscalationNotice[];                  // coalesced, newest-first
  dismiss: (id: string) => void;                // local-only hide (until a newer notice re-raises the id)
  loading: boolean;
  error: string | null;
}

/** Coalesce + cap at RETAINED_CAP, dropping the oldest (list is newest-first). */
function coalesceAndCap(notices: EscalationNotice[]): EscalationNotice[] {
  const merged = coalesceNotices(notices);
  return merged.length > RETAINED_CAP ? merged.slice(0, RETAINED_CAP) : merged;
}

export function useEscalations({ relayUrl, guardianPubkey, backend, enabled, onLiveNotice }: UseEscalationsArgs): UseEscalationsReturn {
  const [rawNotices, setRawNotices] = useState<EscalationNotice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // id -> createdAt of the notice AT DISMISSAL TIME. A later notice for the
  // same id with a newer createdAt clears the dismissal (re-ask surfaces).
  const [dismissed, setDismissed] = useState<Map<string, number>>(new Map());

  const rawNoticesRef = useRef(rawNotices);
  rawNoticesRef.current = rawNotices;

  // Ref, not a dependency — a new `onLiveNotice` closure every render (the
  // common case; App.tsx defines it inline) must not tear down and re-open
  // the relay subscription.
  const onLiveNoticeRef = useRef(onLiveNotice);
  onLiveNoticeRef.current = onLiveNotice;

  useEffect(() => {
    if (!enabled || !relayUrl || !guardianPubkey || !backend) {
      setRawNotices([]);
      setError(null);
      setLoading(false);
      return;
    }
    if (!isValidRelayUrl(relayUrl)) {
      setRawNotices([]);
      setError('Invalid relay URL');
      setLoading(false);
      return;
    }
    if (!HEX64.test(guardianPubkey)) {
      setRawNotices([]);
      setError('Invalid guardian pubkey');
      setLoading(false);
      return;
    }

    const gp = guardianPubkey.toLowerCase();
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    // Session-local "have we seen this id yet" set — seeded from the
    // backlog, extended by each live event. Re-created fresh every time
    // this effect runs, so the backlog/live boundary is always correct
    // regardless of what triggered the re-run.
    const knownIds = new Set<string>();
    // Wrap ids already unwrapped — the pool fans out to several relays, so
    // the same wrap can arrive more than once; never spend a device
    // nip44_decrypt round-trip twice on one event.
    const seenWraps = new Set<string>();

    setLoading(true);
    setError(null);
    setRawNotices([]);

    // The family device publishes notices to ITS relay set, which need not
    // include this app's primary — so read from every enabled relay in the
    // pool (`relayUrl` is kept as the effect trigger for a mid-session
    // relay-list edit), deduped by wrap id. An earlier hardware-bench finding:
    // a single-relay subscription on the app's primary missed a park that
    // only landed on the device's primary.
    const filter = { kinds: [1059], '#p': [gp], limit: BACKLOG_LIMIT } as never;

    const handleWrap = async (wrap: NostrEvent, live: boolean) => {
      if (cancelled) return;
      if (typeof wrap.id !== 'string' || seenWraps.has(wrap.id)) return;
      seenWraps.add(wrap.id);
      const rumor = await unwrapEscalationNotice(wrap, backend, gp);
      if (!rumor || cancelled) return;
      const notice = parseEscalationNotice(rumor);
      if (!notice || cancelled) return;
      if (!live) {
        knownIds.add(notice.id);
        setRawNotices((prev) => coalesceAndCap([...prev, notice]));
        return;
      }
      const isNew = !knownIds.has(notice.id);
      knownIds.add(notice.id);
      setRawNotices((prev) => coalesceAndCap([...prev, notice]));
      if (isNew) onLiveNoticeRef.current?.(notice);
    };

    void (async () => {
      try {
        const backlog = await fetchEvents([filter]);
        if (cancelled) return;
        for (const wrap of backlog) await handleWrap(wrap as NostrEvent, false);
        if (cancelled) return;
        setLoading(false);
        unsubscribe = subscribeEvents([filter], [], (event) => { void handleWrap(event, true); });
        if (cancelled && unsubscribe) { unsubscribe(); unsubscribe = null; }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load requests');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    };
  }, [enabled, relayUrl, guardianPubkey, backend]);

  const dismiss = useCallback((id: string) => {
    const notice = rawNoticesRef.current.find((n) => n.id === id);
    const dismissedAt = notice ? notice.createdAt : Math.floor(Date.now() / 1000);
    setDismissed((prev) => {
      const next = new Map(prev);
      next.set(id, dismissedAt);
      return next;
    });
  }, []);

  // Prune dismissal entries for ids that have fallen out of `rawNotices`
  // (aged past the retained-50 cap, or the whole session reset) — otherwise
  // `dismissed` grows without bound over a long-lived guardian session.
  useEffect(() => {
    setDismissed((prev) => {
      if (prev.size === 0) return prev;
      const liveIds = new Set(rawNotices.map((n) => n.id));
      let changed = false;
      const next = new Map(prev);
      for (const id of prev.keys()) {
        if (!liveIds.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rawNotices]);

  const notices = useMemo(
    () => rawNotices.filter((n) => {
      const dismissedAt = dismissed.get(n.id);
      if (dismissedAt === undefined) return true;
      return n.createdAt > dismissedAt;
    }),
    [rawNotices, dismissed],
  );

  return { notices, dismiss, loading, error };
}
