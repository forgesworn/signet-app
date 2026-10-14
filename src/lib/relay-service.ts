import { RelayClient, type NostrFilter, type RelayState, type NostrEvent } from 'signet-protocol';
import { isValidRelayUrl } from './relay-url';
import { defaultRelays, primaryRelayUrl } from './relay-defaults';
import { anyRelayAccepted } from './relay-operations';
import type { RelayConfig } from '../types';

export { DEFAULT_RELAY_URL, defaultRelays, primaryRelayUrl } from './relay-defaults';

export const MAX_RELAYS = 10;
const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

// ─── Pool state ──────────────────────────────────────────────────────────────
let configs: RelayConfig[] = defaultRelays();
let primaryUrl: string = primaryRelayUrl(configs);
let configurationGeneration = 0;
const clients = new Map<string, RelayClient>();
let connectionWanted = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelayMs = 1_000;
let connecting: { generation: number; promise: Promise<void> } | undefined;

function cancelReconnect(): void {
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
}

function scheduleReconnect(): void {
  if (!connectionWanted || reconnectTimer !== undefined || !configs.some(r => r.enabled)) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connectRelay().catch(() => { /* connectRelay schedules the next retry */ });
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
}

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
const connectionStartedAt = new WeakMap<RelayClient, number>();

// Let the SDK restore its live subscriptions rather than opening a second
// socket over an automatic reconnect. After its finite retries are exhausted,
// an explicit attempt is allowed again, at most once a minute per relay.
function waitForReconnect(c: RelayClient, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (c.getState() === 'connected') { clearInterval(poll); clearTimeout(timer); resolve(); }
    }, 50);
    const timer = setTimeout(() => { clearInterval(poll); reject(new Error('reconnect timeout')); }, timeoutMs);
  });
}
function ensureConnected(c: RelayClient, timeoutMs: number): Promise<void> {
  if (c.getState() === 'connected') return Promise.resolve();
  let p = pendingConnects.get(c);
  if (!p) {
    const startedAt = connectionStartedAt.get(c);
    const manual = startedAt === undefined || (Date.now() - startedAt >= 60_000 && c.getState() !== 'connecting');
    if (manual) connectionStartedAt.set(c, Date.now());
    p = (manual ? withTimeout(c.connect(), timeoutMs, 'connect timeout') : waitForReconnect(c, timeoutMs))
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
  configurationGeneration++;
  cancelReconnect();
  const seen = new Set<string>();
  const valid = (Array.isArray(next) ? next : [])
    // Drop malformed entries: invalid scheme, or a meaningless config with
    // neither read nor write (spec invariant — disable via `enabled:false`).
    .filter(r => r && typeof r.url === 'string' && isValidRelayUrl(r.url) && (r.read || r.write))
    .filter(r => { try { const url = new URL(r.url).href; if (seen.has(url)) return false; seen.add(url); return true; } catch { return false; } })
    .slice(0, MAX_RELAYS);
  configs = valid.length > 0 ? valid : defaultRelays();
  primaryUrl = primaryRelayUrl(configs);
  const live = new Set(configs.filter(r => r.enabled).map(r => r.url));
  for (const [url, c] of clients) {
    if (!live.has(url)) { clients.delete(url); try { c.disconnect(); } catch { /* ignore */ } }
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
let muxBoundClient: RelayClient | null = null;

function bindStateMultiplexer(): void {
  const boundClient = clientFor(primaryUrl);
  if (muxBoundUrl === primaryUrl && muxBoundClient === boundClient) return;
  const boundUrl = primaryUrl;
  muxBoundUrl = boundUrl;
  muxBoundClient = boundClient;
  boundClient.onStateChanged((state) => {
    if (boundUrl !== primaryUrl || clients.get(boundUrl) !== boundClient) return;
    if (state === 'disconnected' || state === 'error') scheduleReconnect();
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

/** Prefer an already-connected relay, then try enabled alternatives. Never use a
 * disabled relay or create a second socket for an in-flight connection. */
export function connectRelay(): Promise<void> {
  connectionWanted = true;
  const generation = configurationGeneration;
  if (connecting?.generation === generation) return connecting.promise;
  cancelReconnect();
  bindStateMultiplexer();
  const promise = (async () => {
    const candidates = configs.filter(r => r.enabled).sort((a, b) => Number(clients.get(b.url)?.getState() === 'connected') - Number(clients.get(a.url)?.getState() === 'connected') || Number(b.url === primaryUrl) - Number(a.url === primaryUrl));
    for (const candidate of candidates) {
      try {
        await ensureConnected(clientFor(candidate.url), DEFAULT_CONNECT_TIMEOUT_MS);
        if (generation !== configurationGeneration) throw new Error('Relay configuration changed');
        primaryUrl = candidate.url;
        reconnectDelayMs = 1_000;
        cancelReconnect();
        bindStateMultiplexer();
        for (const listener of stateListeners) listener('connected');
        return;
      } catch {
        if (generation !== configurationGeneration) throw new Error('Relay configuration changed');
      }
    }
    throw new Error('No configured relay is reachable');
  })().finally(() => {
    if (connecting?.promise === promise) connecting = undefined;
    if (generation === configurationGeneration && getRelayState() !== 'connected') scheduleReconnect();
  });
  connecting = { generation, promise };
  return promise;
}

export function disconnectRelay(): void {
  connectionWanted = false;
  cancelReconnect();
  configurationGeneration++;
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
  const accepted = await anyRelayAccepted([...new Set(targetUrls)].map(async url => {
    const c = clientFor(url);
    await ensureConnected(c, timeoutMs);
    if (!opts?.relays?.length && !configs.some(r => r.url === url && r.enabled && r.write)) return false;
    return (await withTimeout(c.publish(event), timeoutMs, 'publish timeout')).ok;
  }));
  return { ok: accepted, message: accepted ? 'Accepted by a relay; other deliveries continue' : 'No relay accepted the event' };
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
    return withTimeout(c.fetch(filters, timeoutMs), timeoutMs, 'fetch timeout');
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

export type { RelayConfig };
