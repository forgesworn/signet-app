/**
 * Child side of the child-direct activity rails (spec §9.1, §9.2).
 *
 *   activity  every gate decision (`report`) → one kind-31000 rumor, sealed by
 *             the client key, gift-wrapped to the rail pubkey, published on the
 *             rail relay. Queued and flushed every FLUSH_MS, at most
 *             FLUSH_BATCH per flush (≤ 120 a minute); the queue holds QUEUE_MAX
 *             (oldest dropped). A `blocked` decision is reported at most once a
 *             minute per (app, persona, kind): a blocked app retrying in a loop
 *             must not flood the rail. A failed publish goes back to the head
 *             of the queue and the next flush waits RETRY_MS. In memory only.
 *   apps      the connected-apps record (replaceable), republished 5 s after
 *             the list changes. The list lives in the gate's memory, so on
 *             start the child first reads its OWN last record back (NIP-44 is
 *             symmetric) and seeds the gate from it; nothing is published
 *             until that read settles or times out, every publish is merged
 *             with the last record read (A55), and an empty list is never
 *             published.
 *
 * Inert unless the record is `heartwood-direct` and the phone is paired.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NostrEvent, NostrFilter } from 'signet-protocol';
import type { PairedChildRecord } from '../types';
import {
  buildConnectedAppsEvent, openOwnConnectedAppsEvent, wrapChildActivity,
  CHILD_CONNECTED_APPS_D_TAG, type ChildActivityEntry, type ConnectedChildApp,
} from '../lib/child-activity';
import { isValidRelayUrl } from '../lib/relay-url';
import { publishEvent, subscribeEvents } from '../lib/relay-service';

export const ACTIVITY_FLUSH_MS = 5_000;
export const ACTIVITY_FLUSH_BATCH = 10;
export const ACTIVITY_QUEUE_MAX = 200;
export const ACTIVITY_RETRY_MS = 30_000;
export const BLOCKED_REPORT_EVERY_MS = 60_000;
export const CONNECTED_APPS_DEBOUNCE_MS = 5_000;
export const CONNECTED_APPS_SEED_WAIT_MS = 5_000;

export interface ChildActivityTransport {
  publish(event: NostrEvent, relays: string[]): Promise<{ ok: boolean; message: string }>;
  subscribe(filters: NostrFilter[], relays: string[], onEvent: (ev: NostrEvent) => void): () => void;
}
const defaultTransport: ChildActivityTransport = {
  publish: (event, relays) => publishEvent(event, { relays }),
  subscribe: (filters, relays, onEvent) => subscribeEvents(filters, relays, onEvent),
};

export interface UseChildActivityPublisherOpts {
  record: PairedChildRecord | null;
  unpaired: boolean;
  connectedApps: ConnectedChildApp[];
  noteConnectedApp(app: ConnectedChildApp): void;
  transport?: ChildActivityTransport;
  now?: () => number;
}

const HEX64 = /^[0-9a-f]{64}$/;
/** Mirrors the gate's cap (CHILD_CONNECTED_APPS_MAX). */
const APPS_MAX = 64;

/** A55: union by appId — max lastUsed, min firstSeen, the newer entry's fields — newest first. */
export function mergeConnectedApps(a: ConnectedChildApp[], b: ConnectedChildApp[]): ConnectedChildApp[] {
  const byId = new Map<string, ConnectedChildApp>();
  for (const x of [...a, ...b]) {
    const prev = byId.get(x.appId);
    if (!prev) { byId.set(x.appId, x); continue; }
    const newer = x.lastUsed >= prev.lastUsed ? x : prev;
    byId.set(x.appId, { ...newer, firstSeen: Math.min(prev.firstSeen, x.firstSeen), lastUsed: Math.max(prev.lastUsed, x.lastUsed) });
  }
  return [...byId.values()].sort((x, y) => y.lastUsed - x.lastUsed).slice(0, APPS_MAX);
}

export function useChildActivityPublisher(opts: UseChildActivityPublisherOpts): { report(e: ChildActivityEntry): void } {
  const direct = opts.record?.mode === 'heartwood-direct' ? opts.record : null;
  const clientPub = direct?.clientKeypair.publicKey ?? '';
  const clientPriv = direct?.clientKeypair.privateKey ?? '';
  const railPub = direct?.railPubkey ?? '';
  const relay = direct?.railRelay ?? '';
  const live = !opts.unpaired && HEX64.test(clientPub) && HEX64.test(railPub) && isValidRelayUrl(relay);
  const key = live ? `${clientPub}:${railPub}:${relay}` : '';

  const cfg = useRef({ key, clientPriv, railPub, relay });
  cfg.current = { key, clientPriv, railPub, relay };
  const transportRef = useRef(opts.transport ?? defaultTransport);
  transportRef.current = opts.transport ?? defaultTransport;
  const nowRef = useRef(opts.now ?? (() => Date.now()));
  nowRef.current = opts.now ?? (() => Date.now());
  const noteRef = useRef(opts.noteConnectedApp);
  noteRef.current = opts.noteConnectedApp;

  // ── Activity queue ───────────────────────────────────────────────────────
  const queue = useRef<ChildActivityEntry[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushing = useRef(false);
  const lastBlocked = useRef(new Map<string, number>());

  const schedule = useCallback((ms: number) => {
    if (timer.current || !cfg.current.key) return;
    timer.current = setTimeout(() => { timer.current = null; void flushRef.current(); }, ms);
  }, []);

  const flushRef = useRef<() => Promise<void>>(async () => {});
  flushRef.current = async () => {
    const at = cfg.current;
    if (flushing.current || !at.key || queue.current.length === 0) return;
    flushing.current = true;
    let failed = false;
    try {
      const batch = queue.current.splice(0, ACTIVITY_FLUSH_BATCH);
      for (let i = 0; i < batch.length; i++) {
        if (cfg.current.key !== at.key) return; // re-paired / unpaired mid-flush: drop
        let ev: NostrEvent;
        try { ev = await wrapChildActivity(batch[i], at.clientPriv, at.railPub); } catch { continue; }
        let ok = false;
        try { ok = (await transportRef.current.publish(ev, [at.relay])).ok; } catch { ok = false; }
        if (!ok) {
          queue.current.unshift(...batch.slice(i));
          queue.current.splice(ACTIVITY_QUEUE_MAX);
          failed = true;
          break;
        }
      }
    } finally {
      flushing.current = false;
      if (queue.current.length > 0) schedule(failed ? ACTIVITY_RETRY_MS : ACTIVITY_FLUSH_MS);
    }
  };

  useEffect(() => {
    queue.current = [];
    lastBlocked.current.clear();
    return () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  }, [key]);

  const report = useCallback((e: ChildActivityEntry) => {
    if (!cfg.current.key) return;
    if (e.outcome === 'blocked') {
      const k = `${e.appId}|${e.persona}|${e.kind}`;
      const nowMs = nowRef.current();
      const prev = lastBlocked.current.get(k);
      if (prev !== undefined && nowMs - prev < BLOCKED_REPORT_EVERY_MS) return;
      lastBlocked.current.set(k, nowMs);
    }
    queue.current.push(e);
    if (queue.current.length > ACTIVITY_QUEUE_MAX) queue.current.splice(0, queue.current.length - ACTIVITY_QUEUE_MAX);
    schedule(ACTIVITY_FLUSH_MS);
  }, [schedule]);

  // ── Connected apps ──────────────────────────────────────────────────────
  // A55: the read-back of our own record stays open for the whole pairing.
  // Whatever it yields — before or after the seed timeout — is merged into
  // the gate AND into every publish (union by appId, max lastUsed), so a slow
  // read can never let a shorter list overwrite the relay record.
  const seeded = useRef(false);
  const lastPublished = useRef('');
  const remoteApps = useRef<ConnectedChildApp[]>([]);
  const [seedTick, setSeedTick] = useState(0);
  useEffect(() => {
    seeded.current = false;
    lastPublished.current = '';
    remoteApps.current = [];
    if (!key) return;
    let closed = false;
    const finish = () => { if (!closed && !seeded.current) { seeded.current = true; setSeedTick(t => t + 1); } };
    let newest = -1;
    const unsub = transportRef.current.subscribe(
      [{ kinds: [30078], authors: [clientPub], '#d': [CHILD_CONNECTED_APPS_D_TAG], '#p': [railPub] }],
      [relay],
      (ev) => {
        if (closed || !ev || typeof ev.created_at !== 'number' || ev.created_at <= newest) return;
        void openOwnConnectedAppsEvent(ev, cfg.current.clientPriv, railPub).then((apps) => {
          if (closed || !apps || ev.created_at <= newest) return;
          newest = ev.created_at;
          remoteApps.current = mergeConnectedApps(remoteApps.current, apps);
          for (const a of apps) noteRef.current(a);
          finish();
        });
      },
    );
    const t = setTimeout(finish, CONNECTED_APPS_SEED_WAIT_MS);
    return () => { closed = true; clearTimeout(t); unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on `key`
  }, [key]);

  const appsHash = JSON.stringify(opts.connectedApps);
  const appsRef = useRef(opts.connectedApps);
  appsRef.current = opts.connectedApps;
  useEffect(() => {
    if (!key || !seeded.current || appsRef.current.length === 0 || appsHash === lastPublished.current) return;
    const t = setTimeout(() => {
      const at = cfg.current;
      if (at.key !== key) return;
      const snapshot = appsHash;
      const apps = mergeConnectedApps(remoteApps.current, appsRef.current);
      void buildConnectedAppsEvent(apps, at.clientPriv, at.railPub, Math.floor(nowRef.current() / 1000))
        .then(ev => transportRef.current.publish(ev, [at.relay]))
        .then(r => { if (r.ok && cfg.current.key === key) { lastPublished.current = snapshot; remoteApps.current = apps; } })
        .catch(() => { /* the next change retries */ });
    }, CONNECTED_APPS_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [key, appsHash, seedTick]);

  return { report };
}
