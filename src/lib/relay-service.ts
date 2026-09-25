import { RelayClient, type NostrFilter, type RelayState, type NostrEvent } from 'signet-protocol';
import { isValidRelayUrl } from './relay-url';
import { isNativeApp } from './native';
import type { RelayConfig } from '../types';

const DEV_RELAY_URL = 'ws://localhost:7777';
const PRODUCTION_RELAY_URL = 'wss://relay.trotters.cc';
// In the Capacitor APK the WebView origin IS localhost — that must not
// select the dev relay. Only a real browser tab on a dev server does.
const DEFAULT_RELAY_URL = typeof window !== 'undefined' && window.location?.hostname === 'localhost' && !isNativeApp()
  ? DEV_RELAY_URL
  : PRODUCTION_RELAY_URL;

/** Hard cap on the relay set (spec §Data model). */
export const MAX_RELAYS = 10;

const DEFAULT_PUBLISH_TIMEOUT_MS = 30000;
const DEFAULT_FETCH_TIMEOUT_MS = 10000;

/** The 5 public relays added to every fresh install. nostr.band is an
 *  indexer that rejects most writes, so it defaults read-only. */
const PUBLIC_DEFAULT_RELAYS: ReadonlyArray<Omit<RelayConfig, 'url'> & { url: string }> = [
  { url: 'wss://nos.lol', enabled: true, read: true, write: true },
  { url: 'wss://relay.damus.io', enabled: true, read: true, write: true },
  { url: 'wss://relay.nostr.band', enabled: true, read: true, write: false },
  { url: 'wss://relay.primal.net', enabled: true, read: true, write: true },
  { url: 'wss://relay.ditto.pub', enabled: true, read: true, write: true },
];

/** Fresh default relay set: primary (trotters.cc, write) + 5 public. */
export function defaultRelays(): RelayConfig[] {
  return [
    { url: DEFAULT_RELAY_URL, enabled: true, read: true, write: true },
    ...PUBLIC_DEFAULT_RELAYS.map(r => ({ ...r })),
  ];
}

/** Derived primary = first enabled+write → first enabled → DEFAULT_RELAY_URL. */
export function primaryRelayUrl(relays: RelayConfig[]): string {
  const w = relays.find(r => r.enabled && r.write);
  if (w) return w.url;
  const e = relays.find(r => r.enabled);
  if (e) return e.url;
  return DEFAULT_RELAY_URL;
}

// ─── Pool state ──────────────────────────────────────────────────────────────
let configs: RelayConfig[] = defaultRelays();
let primaryUrl: string = primaryRelayUrl(configs);
const clients = new Map<string, RelayClient>();

function clientFor(url: string): RelayClient {
  let c = clients.get(url);
  if (!c) { c = new RelayClient(url); clients.set(url, c); }
  return c;
}

// One in-flight connect per relay. `RelayClient.connect()` opens a NEW
// WebSocket whenever state !== 'connected', so two concurrent callers (e.g.
// the operator-channel subscription and a sync publish at unlock) would
// race: the first socket opens and resolves, but the client's `ws` field
// already points at the second, still-CONNECTING socket, and the first
// caller's subscribe/publish throws "Still in CONNECTING state". Memoising
// the pending promise makes every caller await the same open.
const pendingConnects = new Map<RelayClient, Promise<void>>();
function ensureConnected(c: RelayClient, timeoutMs: number): Promise<void> {
  if (c.getState() === 'connected') return Promise.resolve();
  let p = pendingConnects.get(c);
  if (!p) {
    p = withTimeout(c.connect(), timeoutMs, 'connect timeout')
      .finally(() => { pendingConnects.delete(c); });
    pendingConnects.set(c, p);
  }
  return p;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

/** Replace the relay set. Validates + clamps to MAX_RELAYS, recomputes the
 *  primary, and drops clients for relays that are no longer enabled/present. */
export function setRelays(next: RelayConfig[]): void {
  const valid = (Array.isArray(next) ? next : [])
    // Drop malformed entries: invalid scheme, or a meaningless config with
    // neither read nor write (spec invariant — disable via `enabled:false`).
    .filter(r => r && typeof r.url === 'string' && isValidRelayUrl(r.url) && (r.read || r.write))
    .slice(0, MAX_RELAYS);
  configs = valid.length > 0 ? valid : defaultRelays();
  primaryUrl = primaryRelayUrl(configs);
  const live = new Set(configs.filter(r => r.enabled).map(r => r.url));
  for (const [url, c] of clients) {
    if (!live.has(url)) { try { c.disconnect(); } catch { /* ignore */ } clients.delete(url); }
  }
  // Re-bind the state-change multiplexer if it was already active and the
  // primary relay (and so the underlying client instance) changed — see
  // `addStateListener`. Skipped when nothing has ever registered a
  // listener (`muxBoundUrl` still null), so `setRelays` doesn't require
  // every RelayClient in the pool to implement `onStateChanged`.
  if (muxBoundUrl !== null) bindStateMultiplexer();
}

// ─── State-change multiplexer (M8, 2026-07-02 audit) ───────────────────────
// `RelayClient.onStateChanged` (signet-protocol) supports only ONE listener
// — each call silently overwrites the previous registration. Several
// signet-app hooks (useRelay, useVerifierProfile, useNostrEvents,
// useProRoleAnchor) each want their own listener on the SAME primary
// client; calling `onStateChanged` directly from more than one of them
// clobbers all but the last registration (useProRoleAnchor, mounted at App
// root, silently lost its reconnect-refresh whenever a later hook mounted
// and re-registered). Fix: register ONE listener with the underlying
// client and fan state changes out to every locally-registered listener.
const stateListeners = new Set<(state: RelayState) => void>();
/** The primaryUrl the multiplexer is currently bound to, or null before
 *  the first bind. Re-bound in `setRelays` whenever the primary changes. */
let muxBoundUrl: string | null = null;

function bindStateMultiplexer(): void {
  if (muxBoundUrl === primaryUrl) return;
  muxBoundUrl = primaryUrl;
  clientFor(primaryUrl).onStateChanged((state) => {
    for (const listener of stateListeners) listener(state);
  });
}

/**
 * Register a relay connection-state listener. Returns an unsubscribe
 * function that removes ONLY that listener — other registered listeners
 * are unaffected. See the module doc comment above for why this exists
 * instead of calling `getRelayClient().onStateChanged(cb)` directly.
 */
export function addStateListener(listener: (state: RelayState) => void): () => void {
  bindStateMultiplexer();
  stateListeners.add(listener);
  return () => { stateListeners.delete(listener); };
}

export function getRelayClient(): RelayClient {
  return clientFor(primaryUrl);
}

export function getRelayUrl(): string {
  return primaryUrl;
}

/** Legacy single-relay setter — collapses the set to one primary entry.
 *  Retained for back-compat (Heartwood/NIP-07 connect, tests). The relay
 *  manager UI uses `setRelays`. Throws on invalid scheme (message contains
 *  'wss://' for the existing test). */
export function setRelayUrl(url: string): void {
  if (!isValidRelayUrl(url)) {
    throw new Error('Relay URL must use wss:// (or ws:// for localhost only)');
  }
  setRelays([{ url, enabled: true, read: true, write: true }]);
}

export async function connectRelay(): Promise<void> {
  const c = clientFor(primaryUrl);
  if (c.getState() !== 'connected') await c.connect();
}

export function disconnectRelay(): void {
  for (const [url, c] of clients) { try { c.disconnect(); } catch { /* ignore */ } clients.delete(url); }
}

export function getRelayState(): RelayState {
  const c = clients.get(primaryUrl);
  return c ? c.getState() : 'disconnected';
}

/** Publish to every enabled+write relay. ok=true if ANY relay accepts.
 *  Per-relay rejects/timeouts are swallowed (public relays drop unknown
 *  Signet kinds — harmless).
 *
 *  `opts.relays`, when provided, publishes ONLY to that explicit relay
 *  list instead of the configured pool — clients are created/reused for
 *  those URLs even if they aren't part of the pool. Needed for retraction
 *  flows that must target the exact relay an earlier event was published
 *  to (`lastPublishedRelay`), which may differ from the currently
 *  configured `preferences.relayUrl` ("three-rail model").
 *  Publishing a kind-5 deletion to the wrong relay leaves the original
 *  event live forever — see 2026-07-02 audit finding C2. Omitted/empty
 *  keeps the existing pool behaviour for backward compatibility.
 */
export async function publishEvent(
  event: NostrEvent,
  opts?: { timeoutMs?: number; relays?: string[] },
): Promise<{ ok: boolean; message: string }> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
  const targetUrls = opts?.relays && opts.relays.length > 0
    ? opts.relays.filter(u => isValidRelayUrl(u))
    : configs.filter(r => r.enabled && r.write).map(r => r.url);
  if (targetUrls.length === 0) return { ok: false, message: 'no write relay configured' };
  const settled = await Promise.allSettled(targetUrls.map(async url => {
    const c = clientFor(url);
    await ensureConnected(c, timeoutMs);
    return withTimeout(c.publish(event), timeoutMs, 'publish timeout');
  }));
  const accepted = settled.filter(s => s.status === 'fulfilled' && (s.value as { ok: boolean }).ok).length;
  return { ok: accepted > 0, message: `${accepted}/${targetUrls.length} relays accepted` };
}

/** Fetch from every enabled+read relay, merge, dedupe by event id.
 *  A relay that errors/times out contributes nothing (best-effort).
 *
 *  `opts.relays`, when provided, fetches ONLY from that explicit relay
 *  list instead of the configured pool — see `publishEvent` for why this
 *  matters (targeted lookups against a specific `lastPublishedRelay`).
 */
export async function fetchEvents(
  filters: NostrFilter[],
  opts?: { timeoutMs?: number; relays?: string[] },
): Promise<NostrEvent[]> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const targetUrls = opts?.relays && opts.relays.length > 0
    ? opts.relays.filter(u => isValidRelayUrl(u))
    : configs.filter(r => r.enabled && r.read).map(r => r.url);
  if (targetUrls.length === 0) return [];
  const settled = await Promise.allSettled(targetUrls.map(async url => {
    const c = clientFor(url);
    await ensureConnected(c, timeoutMs);
    return withTimeout(c.fetch(filters), timeoutMs, 'fetch timeout');
  }));
  const byId = new Map<string, NostrEvent>();
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      for (const ev of s.value as NostrEvent[]) {
        if (ev && typeof ev.id === 'string' && !byId.has(ev.id)) byId.set(ev.id, ev);
      }
    }
  }
  return [...byId.values()];
}

/** Open a live subscription on every relay in `relays` (an empty list falls
 *  back to every enabled+read relay in the pool). Returns a combined
 *  unsubscribe that closes the per-relay subscription on each. Each relay is
 *  connected first (best-effort, bounded by `withTimeout`); a relay that
 *  fails to connect simply contributes no events. Calling the returned
 *  function before a relay's connect has resolved suppresses that relay's
 *  subscription rather than leaking it. Events are NOT deduped across relays
 *  — a caller that cares about duplicates (e.g. request/reply correlation by
 *  inner id) must dedupe itself. Used by the Heartwood operator channel
 *  (`heartwood-mgmt.ts`) for its kind-24134 reply subscription.
 */
export function subscribeEvents(
  filters: NostrFilter[],
  relays: string[],
  onEvent: (event: NostrEvent) => void,
  opts?: { timeoutMs?: number },
): () => void {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const targetUrls = relays.length > 0
    ? relays.filter(u => isValidRelayUrl(u))
    : configs.filter(r => r.enabled && r.read).map(r => r.url);
  let closed = false;
  const open: Array<{ client: RelayClient; subId: string }> = [];
  for (const url of targetUrls) {
    const c = clientFor(url);
    ensureConnected(c, timeoutMs).then(() => {
      if (closed) return;
      try {
        const subId = c.subscribe(filters, (ev) => { if (!closed) onEvent(ev); });
        open.push({ client: c, subId });
      } catch { /* socket not writable — this relay contributes nothing */ }
    }, () => { /* best-effort: this relay contributes nothing */ });
  }
  return () => {
    if (closed) return;
    closed = true;
    for (const { client, subId } of open) {
      try { client.closeSubscription(subId); } catch { /* already gone */ }
    }
    open.length = 0;
  };
}

export { DEFAULT_RELAY_URL };
export type { RelayConfig };
