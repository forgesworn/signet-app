/**
 * NIP-46 bunker server hook (Phase 2; multi-identity
 * routing added later).
 *
 * When `enabled` is true AND at least one route is provided with a valid
 * relay URL, opens a WebSocket to the relay, subscribes for kind-24133
 * events `p`-tagged with any of the route pubkeys, decrypts each into an
 * inbound NIP-46 request using the matching route's backend, and dispatches:
 *
 * - **`sign_event`**: if the route is the guardian's and the client has
 *   `allowAlways: true` in IDB, sign and publish the response immediately.
 *   Otherwise, surface the request via `pendingApproval` for user decision.
 * - **Silent crypto methods** (nip04_* / nip44_*): served only after the
 *   owner/dependant policy gates pass. No approval prompt path exists for
 *   these transport-level methods.
 * - **Management methods** (ping / switch_relays / logout / get_public_key):
 *   respond directly according to NIP-46.
 *
 * Approval callbacks:
 * - `approveOnce(handle)` — signs + publishes the response without persisting.
 * - `approveAlways(handle)` — same + saves `allowAlways: true` on the client
 *   record (guardian routes only — dependant routes use the `grants` store
 *   instead).
 * - `deny(handle)` — publishes `error: "user denied"`. Not persisted.
 *
 * **Routing:**
 * - `handleInboundEvent` finds the matching route by the event's `p` tag and
 *   uses that route's backend for decrypt + sign. Requests addressed to a
 *   pubkey outside the route list are dropped.
 * - `pendingApproval.route` carries the dependantId (or null for guardian)
 *   so the UI can frame the prompt accordingly.
 *
 * **Concurrency:** one outstanding approval at a time (busy guard) across
 * ALL routes — matches the mobile holodeck OQ8 decision (serial approval
 * modals). Additional requests during a pending approval are rejected
 * with `error: "busy"`. Future work may add a FIFO queue.
 *
 * **Security invariants:**
 * - Never auto-approves on timeout.
 * - Private-key material flows only through the backends provided at hook
 *   init; all nip44Encrypt/Decrypt + signEvent calls delegate.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { NostrEvent } from 'signet-protocol';
import { verifyEvent } from 'nostr-tools/pure';
import type { Event as NTEvent } from 'nostr-tools/pure';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import {
  parseInboundRequest,
  parseSignEventTemplate,
  describeEventTemplate,
  buildResponseEvent,
} from '../lib/nip46-server';
import type { UnsignedEvent } from 'signet-protocol';
import type { AutonomyStage, RememberedGrant, GrantSchedule } from '../types';
import { intersectSchedules, isWithinSchedule } from '../lib/grant-schedule';
import { inferScope, inferOrigin, type Scope } from '../lib/scope-inference';
import { resolvePolicy, isOriginScopedScope } from '../lib/autonomy-gate';
import { checkRateLimit, type RateLimitState } from '../lib/rate-limit';
import type { AuditEventParams } from '../lib/audit';
import { parseConnectMetadata, pairingMatches } from '../lib/app-bunker-routing';
import { isValidRelayUrl } from '../lib/relay-url';
import { ownerRoutePubkeyMismatch, ownerRouteNip44Authorised } from '../lib/persona-bunker-routes';
import * as db from '../lib/db';

/**
 * Dev-only diagnostics for the bunker-serve socket lifecycle. Stripped from
 * production builds (Vite dead-code-eliminates the `import.meta.env.DEV` branch)
 * so the "no console output in production" invariant holds, while the
 * connect/reconnect/close traces stay available during local development.
 * Security audit 2026-06-15.
 */
const devLog = (...args: unknown[]): void => {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.info(...args);
  }
};

/**
 * A single identity the bunker server listens for.
 *
 * **Guardian route:** `{ pubkey: guardianPubkey, backend }` — the guardian's
 * NIP-46 transport pubkey and signing key are the same identity, so one
 * backend handles both envelope transport (nip44Encrypt/Decrypt, sign the
 * kind-24133 response) and inner template signing.
 *
 * **Dependant route:** `{ pubkey: endpointPubkey, backend, signingBackend,
 * dependantId, autonomyStage }` — the endpoint keypair is a *transport*
 * identity (what the child's device encrypts to and what the response is
 * signed by). `signingBackend` wraps the dependant's *signing* keypair and
 * is used to sign the USER event template the client requested. Keeping
 * them separate prevents accidentally signing a kind-1 note with the
 * endpoint key (which would not match the dependant's pubkey).
 */
export interface BunkerRoute {
  /** Explicit discriminator: bot routes never enter the human grant handlers. */
  source?: 'human' | 'bot';
  handleBotEvent?: (event: NostrEvent, send: (response: NostrEvent) => boolean) => Promise<void>;
  /** The recipient pubkey (hex) NIP-46 requests will be `p`-tagged to. */
  pubkey: string;
  /**
   * Transport backend: nip44 encrypt/decrypt of envelopes + signs the
   * kind-24133 response events. For a guardian route this is also the
   * signing backend.
   */
  backend: DecryptingSigningBackend;
  /**
   * Signing backend for inner USER templates. When present, the policy
   * path uses this for `signEvent(template)` instead of `backend`. Absent
   * on guardian routes (defaults to `backend`).
   */
  signingBackend?: DecryptingSigningBackend;
  /**
   * When present, this route represents a paired child device for a
   * dependant. The value is the dependant's primary (signing) pubkey.
   */
  dependantId?: string;
  /**
   * Dependant-route only. The dependant's current autonomy stage — drives
   * the policy matrix in `resolvePolicy`. When absent on a dependant route,
   * the server falls back to surfacing the prompt (conservative).
   */
  autonomyStage?: AutonomyStage;
  /**
   * Dependant-route only. Snapshot of the dep's `defaultSchedule` at
   * route-construction time. Read-only here — App.tsx re-builds the
   * route when the dep record changes (including defaultSchedule), so
   * a re-render gives the bunker a fresh value. Treated as the
   * fallback-tier of schedule enforcement: applies whenever a sign
   * request lacks a per-origin grant schedule.
   */
  defaultSchedule?: GrantSchedule;
  /**
   * Dependant-route only. Current pair-in-flight secret — checked against
   * `connect` params[1] on first handshake. Persisted by the guardian pair
   * UI whenever a fresh QR is minted. Cleared server-side after a
   * successful bind via `onPairingComplete`.
   */
  pairingSecret?: string;
  /**
   * Dependant-route only. Client pubkey bound on the first successful
   * `connect`. Once set, subsequent connect / sign_event / get_public_key
   * requests must come from this pubkey or they are rejected.
   */
  authorizedClientPubkey?: string;
  /**
   * Distinguishes per-dependant route variants. Default 'device' for
   * existing routes (the child's own paired device, single-slot via
   * `authorizedClientPubkey`). 'app' routes
   * are app-bunker endpoints holding up to TRUSTED_APP_PAIRING_CAP
   * `TrustedAppPairing` records, looked up via `db.listAppBunkerPairings`
   * on every inbound request.
   */
  routeKind?: 'device' | 'app';
  /**
   * Per-persona signing-backend resolver. Returns a SigningBackend bound to
   * the requested persona pubkey, or null when no matching persona exists.
   * Used by the §5.4.1 publicProfile pre-auth path so kid-initiated kind-0
   * publishes for non-NP slots (default Persona, extra personas) sign with
   * the right key — `route.signingBackend` is bound to the dep's NP and
   * would produce a signature that doesn't verify under the persona's
   * pubkey.
   *
   * When absent, the pre-auth gate falls back to `route.signingBackend`
   * (single-key behaviour) — which still works for the dep's NP slot.
   * App.tsx wires the resolver when building dep routes; the
   * per-persona-public-profile design's Phase D depends on it.
   */
  personaSigningBackendByPubkey?: (eventPubkey: string) => DecryptingSigningBackend | null;
}

/** Shape exposed to the approval modal while a sign_event is waiting. */
export interface PendingApproval {
  /** Opaque id — the hook's internal handle for resolving this request. */
  handle: number;
  /** Client identity recovered from the envelope sender pubkey. */
  client: {
    pubkey: string;
    appName: string;
    appUrl?: string;
    existing: boolean;
  };
  /** Which route received this request — lets the UI frame it per-dependant. */
  route: {
    pubkey: string;
    /** Null when the request hit the guardian's own bunker endpoint. */
    dependantId: string | null;
  };
  /** Method — currently only 'sign_event' surfaces here. */
  method: 'sign_event';
  /** Event template the client wants signed. */
  template: UnsignedEvent;
  /** One-liner label suitable for modal copy. */
  description: string;
}

interface Options {
  enabled: boolean;
  relayUrl: string;
  /**
   * Identities to listen for. At least one entry = guardian's own identity.
   * Pass an empty array (or `enabled: false`) to stop the server.
   */
  routes: BunkerRoute[];
  /**
   * Called when a dependant-route `connect` with a matching `pairingSecret`
   * succeeds, so the caller can persist the client pubkey binding and clear
   * the one-shot secret. Should be idempotent — this hook may fire it more
   * than once if multiple `connect` requests arrive before state settles.
   */
  onPairingComplete?: (dependantId: string, clientPubkey: string) => Promise<void>;
  /**
   * Called when an app-route (`routeKind === 'app'`) `connect` with a
   * matching `pairingSecret` succeeds. The caller persists a new
   * `TrustedAppPairing` to the dependant's `appBunkerEndpoint.pairings`
   * (capped at TRUSTED_APP_PAIRING_CAP) and clears the in-flight secret.
   * Sanitised label + origin captured from the consumer's NIP-46
   * metadata blob (third `connect` param).
   */
  onAppPairingComplete?: (
    dependantId: string,
    clientPubkey: string,
    label: string,
    origin?: string,
  ) => Promise<void>;
  /**
   * Dependency for app-route per-request gating: the encryption key
   * needed to read the pairings list out of IDB on each inbound
   * request. When absent, app-route requests cannot be served. The
   * caller passes the unlock-derived key (same one used to mint
   * routes) — non-null while the user is unlocked.
   */
  appPairingsEncryptionKey?: string | null;
  /**
   * Short-lived register of pairing secrets minted by the redirect-flow
   * auto-pair (`buildAuthCallbackUrl({bunker})`). When a guardian-route
   * `connect` arrives carrying a secret found in this map, the connect
   * handler calls `onAuthFlowPairingComplete` so the caller can save a
   * `ConnectedClient` with `allowAlways: true` — the user already
   * authorised the app via the redirect screen, no extra prompt needed.
   *
   * Held in a ref by the caller so connect-time mutations (delete on
   * use, GC on TTL) don't require a re-render.
   */
  pendingAuthPairingsRef?: { current: Map<string, {
    origin: string;
    appName: string;
    signingPubkey: string;
    expiresAt: number;
  }> };
  /**
   * Fires after a guardian-route `connect` whose secret matched an entry
   * in `pendingAuthPairingsRef`. The caller persists a `ConnectedClient`
   * with `allowAlways: true` so subsequent sign_event / nip44_* requests
   * from this client skip the approval modal.
   */
  onAuthFlowPairingComplete?: (params: {
    clientPubkey: string;
    appName: string;
    origin: string;
    signingPubkey: string;
  }) => Promise<void>;
  /**
   * Fires the FIRST time a dependant crosses the per-minute sign-request
   * cap in a given window. Intended for a debounced in-app notification
   * ("<name> is making requests faster than usual"). See
   * Not called again until the window resets.
   */
  onRateLimit?: (dependantId: string) => void;
  /**
   * Fires when an inbound request lands in the pending-approval queue
   * (the prompt path) — i.e. a human decision is now required. Native
   * shells use this to raise a local notification so a screen-off
   * guardian learns about the request. Auto-signed / auto-denied
   * requests never fire it.
   */
  onApprovalPending?: (entry: PendingApproval) => void;
  /**
   * Bump to force the serve socket to tear down and reconnect now
   * (e.g. native app resume after Doze). The socket already
   * self-reconnects on close; this is an external kick for the cases
   * where the OS silently killed the connection without an onclose.
   */
  reconnectNonce?: number;
  /**
   * Fires on every decision made against a dependant route — auto-approved
   * (grant allow / stage auto-sign), auto-denied (grant deny / stage
   * blocked), guardian-approved, guardian-denied. Not called for guardian
   * routes (the guardian's own signing decisions aren't audited). The
   * caller wraps `publishAuditEvent` with the guardian's pubkey + backend
   * + relay so this hook stays transport-agnostic. See
   * the 2026-04-22 holodeck OQ1.
   */
  onAuditEvent?: (params: AuditEventParams) => void;
  /**
   * Fires after every RememberedGrant write (approve-always, deny,
   * revoke, lastUsedAt update). Callers that drive cross-device sync
   * use this to reload the grants list from IDB and re-publish
   * after the debounced window. Safe no-op when grants sync isn't
   * active.
   */
  onGrantMutated?: () => void;
  /**
   * Returns true while an owner serve session is active. Owner-route requests
   * (no dependantId) are declined when this returns false — owner serving is
   * time-boxed. Dependant routes are exempt. Optional: when omitted, owner
   * serving is always active (back-compat).
   */
  isOwnerServingActive?: () => boolean;
}

/**
 * Constant-time string compare. Plain `===` / `!==` on strings short-circuits
 * at the first mismatched character — a relay-observable timing oracle
 * against the pairing secret. XOR-accumulate over the full length of both
 * sides (padding the shorter) so the loop always runs the same number of
 * iterations regardless of where the mismatch lies.
 */
function constantTimeStringEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/** Stable-ish key for the routes dependency — avoids re-subscribing on every render. */
function routesKey(routes: BunkerRoute[]): string {
  return routes.map(r => `${r.pubkey}:${r.dependantId ?? ''}:${r.source ?? 'human'}`).sort().join('|');
}

/**
 * Extract the first `p` tag from an unsigned template and validate it as
 * a 64-char hex pubkey. Used to surface the counterparty in the audit
 * record — e.g. the DM recipient, vouch target, zap recipient. A
 * non-conforming value is dropped rather than emitted, so the audit tag
 * is always a valid pubkey or absent.
 */
function firstPTagPubkey(template: UnsignedEvent): string | undefined {
  if (!Array.isArray(template.tags)) return undefined;
  for (const tag of template.tags) {
    if (!Array.isArray(tag) || tag[0] !== 'p' || typeof tag[1] !== 'string') continue;
    const candidate = tag[1].toLowerCase();
    if (/^[0-9a-f]{64}$/.test(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Truthful, low-rate view of the serve subscription's lifecycle, for the
 * Bunker panel. The panel previously asserted "Listening for requests" from
 * UI state alone — a subscription that never opened (empty relay URL, no
 * routes), was severed upstream (proxy idle timeout the device never saw),
 * or is stuck reconnecting looked identical to a healthy one. Updated only
 * on transitions and inbound frames, never per-render.
 */
export interface BunkerServeStatus {
  phase: 'off' | 'no-routes' | 'bad-relay' | 'connecting' | 'open' | 'reconnecting';
  /** Relay the socket targets (or the invalid value, for `bad-relay`). */
  relayUrl: string | null;
  /** Pubkeys in the live REQ's `#p` filter. */
  routePubkeys: string[];
  /** Epoch ms the current socket opened, null when not open. */
  openedAt: number | null;
  /** Epoch ms of the last inbound frame of ANY kind — liveness proof. */
  lastFrameAt: number | null;
  /** Epoch ms of the last NIP-46 request EVENT for our sub. */
  lastEventAt: number | null;
  /** Most recent relay NOTICE text — relays explain dropped REQs here. */
  lastNotice: string | null;
  /** Current reconnect attempt (0 while healthy). */
  reconnectAttempt: number;
  /** Total inbound frames on the current effect run. */
  frameCount: number;
}

const INITIAL_SERVE_STATUS: BunkerServeStatus = {
  phase: 'off', relayUrl: null, routePubkeys: [], openedAt: null,
  lastFrameAt: null, lastEventAt: null, lastNotice: null,
  reconnectAttempt: 0, frameCount: 0,
};

async function publishResponseToSocket(
  ws: WebSocket | null,
  backend: DecryptingSigningBackend,
  clientPubkey: string,
  requestId: string,
  result?: string,
  error?: string,
): Promise<void> {
  const response = { id: requestId, ...(result !== undefined ? { result } : {}), ...(error !== undefined ? { error } : {}) };
  let signed: NostrEvent;
  try {
    signed = await buildResponseEvent(response, clientPubkey, backend);
  } catch {
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(['EVENT', signed])); } catch { /* ignore */ }
  }
}

export function useBunkerServer({ enabled, relayUrl, routes, onPairingComplete, onAppPairingComplete, appPairingsEncryptionKey, pendingAuthPairingsRef, onAuthFlowPairingComplete, onRateLimit, onApprovalPending, reconnectNonce, onAuditEvent, onGrantMutated, isOwnerServingActive }: Options) {
  // Keep the onPairingComplete callback in a ref so the inbound handler
  // always sees the latest — callers typically pass inline arrows.
  const onPairingCompleteRef = useRef(onPairingComplete);
  onPairingCompleteRef.current = onPairingComplete;
  // Read isOwnerServingActive fresh at request time — never stale-capture.
  const isOwnerServingActiveRef = useRef(isOwnerServingActive);
  isOwnerServingActiveRef.current = isOwnerServingActive;
  const onAuthFlowPairingCompleteRef = useRef(onAuthFlowPairingComplete);
  onAuthFlowPairingCompleteRef.current = onAuthFlowPairingComplete;
  const onAppPairingCompleteRef = useRef(onAppPairingComplete);
  onAppPairingCompleteRef.current = onAppPairingComplete;
  const appPairingsKeyRef = useRef<string | null | undefined>(appPairingsEncryptionKey);
  appPairingsKeyRef.current = appPairingsEncryptionKey;
  const onRateLimitRef = useRef(onRateLimit);
  onRateLimitRef.current = onRateLimit;
  const onApprovalPendingRef = useRef(onApprovalPending);
  onApprovalPendingRef.current = onApprovalPending;
  const onAuditEventRef = useRef(onAuditEvent);
  onAuditEventRef.current = onAuditEvent;
  const onGrantMutatedRef = useRef(onGrantMutated);
  onGrantMutatedRef.current = onGrantMutated;

  const fireGrantMutated = useCallback(() => {
    try { onGrantMutatedRef.current?.(); } catch { /* non-fatal */ }
  }, []);

  /**
   * Safely fire the audit callback — swallow exceptions so an audit
   * failure never blocks the signing flow that triggered it. Auditing
   * is a secondary duty; signing is primary.
   */
  const fireAudit = useCallback((params: AuditEventParams) => {
    try { onAuditEventRef.current?.(params); } catch { /* non-fatal */ }
  }, []);
  // Pending queue. Mobile renders only the head via the exposed
  // `pendingApproval` alias; desktop renders the full list via
  // `pendingApprovals`. Cap at
  // PENDING_APPROVALS_CAP to bound memory under a flood that slips past
  // the per-dependant rate-limit — the cap rejects overflow
  // with `busy` to the client.
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);

  // Serve-status telemetry — see BunkerServeStatus. Transitions + frames only.
  const [serveStatus, setServeStatus] = useState<BunkerServeStatus>(INITIAL_SERVE_STATUS);

  // WebSocket + subscription state lives in refs — no need to re-render
  // when they change. The effect-teardown closes them.
  const wsRef = useRef<WebSocket | null>(null);
  const subIdRef = useRef<string | null>(null);
  // Live view of the current route list — lets handleInboundEvent look up
  // routes without forcing a re-subscribe on every render.
  const routesRef = useRef<BunkerRoute[]>(routes);
  routesRef.current = routes;
  // Next handle for PendingApproval — monotonically increasing so
  // stale approve/deny clicks can't resolve a fresh request.
  const handleCounterRef = useRef<number>(0);
  // Active request metadata (full context) keyed by handle.
  const activeRequestRef = useRef<Map<number, {
    requestId: string;
    clientPubkey: string;
    template: UnsignedEvent;
    /** The route that received this request — determines which backend signs. */
    route: BunkerRoute;
    /** Cached scope/origin so resolveApproval can persist a grant without re-inference. */
    scope: Scope | null;
    origin: string | null;
  }>>(new Map());
  // Snapshot of the queue length for the sync `handleInboundEvent` path —
  // React state updates are batched / async, so a rapid inbound burst
  // would otherwise all pass the cap check before any of them landed in
  // state. The ref is updated synchronously alongside `setPendingApprovals`.
  const queueSizeRef = useRef<number>(0);
  // Dependant IDs that are currently mid-bind. Prevents a second concurrent
  // `connect` with the same (or another) valid secret from double-binding
  // while the first `onPairingComplete` IDB write is still in flight —
  // the route object in `routesRef.current` won't show the updated
  // `authorizedClientPubkey` until React re-renders. See audit pass 2.
  const bindingInFlightRef = useRef<Set<string>>(new Set());
  /**
   * How many concurrent unresolved approvals to buffer before rejecting
   * further requests with `error: busy`. 20 is well above the holodeck
   * OQ8 working assumption (one guardian, a few children, rare
   * coincidences) and far below any memory concern.
   */
  const PENDING_APPROVALS_CAP = 20;

  // Per-dependant sign-event counters for the rate limit. In-memory only; a page
  // reload resets both the bunker subscription and these counters
  // together. `notifiedInWindow` debounces the `onRateLimit` callback so
  // we fire it once per 60s window even if the compromised client keeps
  // hammering after the first reject.
  const rateLimitRef = useRef<Map<string, RateLimitState>>(new Map());
  const rateLimitNotifiedRef = useRef<Map<string, number>>(new Map());

  // Event ids already handled. Every (re)subscription asks the relay for the
  // last 60 s (`since: now - 60`), and the subscription is rebuilt whenever
  // the route set changes (a transient connect route installed or cleared, a
  // relay switch, a reconnect kick) — so without this, each rebuild replays
  // every recent request and handles it again. For a route whose key is on
  // the paired Heartwood each replay is a real NIP-46 round trip (decrypt,
  // then encrypt the response): a few rebuilds turned a handful of requests
  // into a burst of over a hundred calls that queued ahead of everything
  // else on the device. Kept across subscriptions; bounded.
  const handledEventIdsRef = useRef<Set<string>>(new Set());
  const HANDLED_EVENT_IDS_CAP = 1000;

  /** Publish a response event to the relay the client spoke to us on. */
  const publishResponse = useCallback(
    async (backend: DecryptingSigningBackend, clientPubkey: string, requestId: string, result?: string, error?: string) => {
      await publishResponseToSocket(wsRef.current, backend, clientPubkey, requestId, result, error);
    },
    [],
  );

  /** Dispatch an inbound kind-24133 event to the right handler. */
  const handleInboundEvent = useCallback(async (event: NostrEvent) => {
    // Structural validation — the event is an untyped cast from a relay
    // message. A malicious or buggy relay could send anything, and we
    // access .tags before verifyEvent runs below. Without these guards,
    // a malformed payload would throw synchronously and bubble up to the
    // outer .catch in ws.onmessage — handled, but noisy.
    if (!event || typeof event !== 'object') return;
    if (typeof event.kind !== 'number' || event.kind !== 24133) return;
    if (typeof event.pubkey !== 'string') return;
    if (!Array.isArray(event.tags)) return;

    // Freshness gate — mirrors the 5-min window enforced for QR / URL-auth
    // (the project's security conventions). The relay filter already passes
    // `since: now - 60`, but it doesn't bound the upper edge (future-dated
    // events from a clock-skewed or malicious client). Reject both.
    if (typeof event.created_at !== 'number' || !Number.isFinite(event.created_at)) return;
    const nowS = Math.floor(Date.now() / 1000);
    if (event.created_at < nowS - 300 || event.created_at > nowS + 60) return;

    // NIP-46 envelopes have exactly one recipient. Reject events with
    // more than one `p` tag so an attacker can't send a dependant-
    // targeted payload through a guardian route's less-strict path.
    const pTags = event.tags.filter(t => Array.isArray(t) && t[0] === 'p');
    if (pTags.length !== 1) return;
    const pTagRaw = pTags[0][1];
    if (typeof pTagRaw !== 'string') return;
    const pTag = pTagRaw.toLowerCase();
    const route = routesRef.current.find(r => r.pubkey.toLowerCase() === pTag);
    if (!route) return;

    // Never serve our OWN outgoing NIP-46 requests. A served route whose key
    // lives on the paired signer (a RoutedBunkerSigningBackend) talks to that
    // signer on the same relay, as a request addressed to the route's
    // pubkey — exactly what this subscription listens for. Handling it
    // costs a decrypt and a reply through the same routed backend, i.e. two
    // more requests to that pubkey, each of which arrives here again: a
    // feedback loop that flooded the board (~30 requests/s) and starved the
    // connect response. Drop anything authored by this app's client keys.
    const author = event.pubkey.toLowerCase();
    if (routesRef.current.some(r =>
      r.backend.transportClientPubkeyHex === author
      || r.signingBackend?.transportClientPubkeyHex === author)) {
      return;
    }

    // Verify envelope signature — a relay can serve forged events.
    if (!verifyEvent(event as unknown as NTEvent)) return;

    // Handle each request once (after verification, so a forged event can
    // never mark a genuine id as seen). A replay on a later subscription is
    // dropped before it can cost a decrypt.
    const handled = handledEventIdsRef.current;
    if (typeof event.id !== 'string' || handled.has(event.id)) return;
    handled.add(event.id);
    if (handled.size > HANDLED_EVENT_IDS_CAP) {
      const oldest = handled.values().next().value;
      if (oldest !== undefined) handled.delete(oldest);
    }

    // Bot handlers authorise the verified envelope author from their own fresh
    // encrypted grants before identity decryption. Missing handler means deny;
    // it must never fall through to owner allowAlways or dependant policy.
    if (route.source === 'bot') {
      await route.handleBotEvent?.(event, response => {
        const live = routesRef.current.find(r => r.pubkey === route.pubkey && r.source === 'bot');
        const socket = wsRef.current;
        if (!live || live.handleBotEvent !== route.handleBotEvent || socket?.readyState !== WebSocket.OPEN
          || response.pubkey !== route.pubkey || response.kind !== 24133) return false;
        socket.send(JSON.stringify(['EVENT', response]));
        return true;
      });
      return;
    }

    const request = await parseInboundRequest(event, route.backend);
    if (!request) return;

    // Owner serving is time-boxed. Outside an active owner serve session,
    // decline owner-route requests (third-party apps acting as the user).
    // Dependant/app routes (route.dependantId set) are exempt — guardian
    // approval must work whenever the app is open. This dominates every
    // owner-route method (connect / get_public_key / nip04_* / nip44_* /
    // sign_event).
    const ownerServingActive = isOwnerServingActiveRef.current ? isOwnerServingActiveRef.current() : true;
    if (!route.dependantId && !ownerServingActive) {
      await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'serving paused');
      return;
    }

    // Handshake + ongoing-request methods. Guardian routes ACK
    // `connect` unconditionally (existing behaviour). Dependant
    // routes enforce the pairing secret on first `connect` and bind
    // the connecting client pubkey — subsequent requests from other
    // clients are rejected.
    if (request.method === 'connect') {
      if (route.dependantId) {
        // App-route binding flow. Distinct from the device-route
        // single-slot binding below — app routes hold up to
        // TRUSTED_APP_PAIRING_CAP pairings in IDB. The pairings list IS
        // the binding state; route.authorizedClientPubkey is unused for
        // app routes.
        if (route.routeKind === 'app') {
          if (!route.pairingSecret) {
            await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'pairing not active');
            return;
          }
          const clientSecret = typeof request.params[1] === 'string' ? request.params[1] : '';
          if (!constantTimeStringEqual(clientSecret, route.pairingSecret)) {
            await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'invalid secret');
            return;
          }
          // Defence against in-flight double-bind, same pattern as device routes.
          const flightKey = `app:${route.dependantId}`;
          if (bindingInFlightRef.current.has(flightKey)) {
            await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'pairing in progress');
            return;
          }
          bindingInFlightRef.current.add(flightKey);
          const bindApp = onAppPairingCompleteRef.current;
          const dependantId = route.dependantId;
          // params[2] carries the consumer's metadata blob per NIP-46.
          const meta = parseConnectMetadata(request.params[2]);
          let bindError: string | null = null;
          if (bindApp) {
            try {
              await bindApp(dependantId, request.clientPubkey.toLowerCase(), meta.label, meta.origin);
            } catch (err) {
              const message = err instanceof Error ? err.message : 'pairing failed';
              bindError = message;
            }
          }
          bindingInFlightRef.current.delete(flightKey);
          if (bindError) {
            // Surface the cap rejection (and any other persistence error)
            // back to the client so the consumer-side pair UI can render
            // a clear message rather than silently timing out.
            await publishResponse(route.backend, request.clientPubkey, request.id, undefined, bindError);
            return;
          }
          await publishResponse(route.backend, request.clientPubkey, request.id, 'ack');
          return;
        }
        // Device route: secret-verified binding flow.
        //
        // Check-order matters for the re-pair UX. A fresh `pairingSecret`
        // (mounted by `saveDependantPairingSecret` when the guardian opens
        // a new pair QR) takes precedence over an existing
        // `authorizedClientPubkey` binding, so the guardian can re-pair a
        // new device without first tapping Revoke. An attacker can't
        // exploit this because they don't know the new secret. If the
        // pair window is closed (no secret), existing bindings are
        // enforced — a rogue client can't reach the endpoint at all.
        if (route.pairingSecret) {
          const clientSecret = typeof request.params[1] === 'string' ? request.params[1] : '';
          if (!constantTimeStringEqual(clientSecret, route.pairingSecret)) {
            await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'invalid secret');
            return;
          }
          // Match. But guard against a concurrent `connect` that arrived
          // in the same microtask as this one and would double-bind under
          // the stale `routesRef.current` snapshot.
          if (bindingInFlightRef.current.has(route.dependantId)) {
            await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'pairing in progress');
            return;
          }
          bindingInFlightRef.current.add(route.dependantId);
          const bind = onPairingCompleteRef.current;
          const dependantId = route.dependantId;
          // Persist the binding BEFORE ACKing. If the IDB write fails
          // (e.g. encryption key nulled mid-flight) we must NOT ACK —
          // the kid's app would otherwise mark itself paired and never
          // re-issue a `connect` (it would `reconnect` on next session,
          // which the server rejects because `authorizedClientPubkey`
          // was never written). Root cause of a bug fixed since.
          // Match the app-pairing flow: surface the failure to the
          // client so it retries the connect.
          let bindFailed = false;
          if (bind) {
            try {
              await bind(dependantId, request.clientPubkey.toLowerCase());
            } catch {
              bindFailed = true;
            }
          }
          bindingInFlightRef.current.delete(dependantId);
          if (bindFailed) {
            await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'bind failed — try again');
            return;
          }
          await publishResponse(route.backend, request.clientPubkey, request.id, 'ack');
          return;
        }
        if (route.authorizedClientPubkey) {
          // No pair window open — enforce existing binding.
          if (request.clientPubkey.toLowerCase() !== route.authorizedClientPubkey.toLowerCase()) {
            await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'not paired');
            return;
          }
          await publishResponse(route.backend, request.clientPubkey, request.id, 'ack');
          return;
        }
        // No pair in flight, no bound client — reject.
        await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'pairing not active');
        return;
      }
      // Guardian route — unconditional ACK (existing behaviour),
      // plus the redirect-bunker auto-pair lookup. When the connect's
      // secret matches a register entry minted by the redirect-flow
      // approval, the connecting client_pubkey is auto-approved with
      // `allowAlways: true` so subsequent sign_event / nip04_* / nip44_* don't
      // surface a prompt for every event. If no match (or the register
      // is empty), behaviour is identical to before — ACK and let the
      // first sign_event prompt as usual.
      const authSecret = typeof request.params[1] === 'string' ? request.params[1] : '';
      const register = pendingAuthPairingsRef?.current;
      if (register && authSecret.length >= 8) {
        const now = Date.now();
        let matched: { origin: string; appName: string; signingPubkey: string } | undefined;
        let matchedKey: string | undefined;
        for (const [secret, entry] of register) {
          if (entry.expiresAt < now) {
            register.delete(secret);
            continue;
          }
          // Bind the secret only to the route whose signing pubkey was
          // chosen at approval time — a redirect approval as persona
          // shouldn't auto-pair an app to the NP route just because both
          // routes are on this device.
          if (entry.signingPubkey.toLowerCase() !== route.pubkey.toLowerCase()) continue;
          if (constantTimeStringEqual(secret, authSecret)) {
            matched = { origin: entry.origin, appName: entry.appName, signingPubkey: entry.signingPubkey };
            matchedKey = secret;
            break;
          }
        }
        if (matched && matchedKey) {
          const meta = parseConnectMetadata(request.params[2]);
          const finishAuthPair = onAuthFlowPairingCompleteRef.current;
          if (finishAuthPair) {
            try {
              await finishAuthPair({
                clientPubkey: request.clientPubkey.toLowerCase(),
                appName: meta.label || matched.appName,
                origin: meta.origin || matched.origin,
                signingPubkey: matched.signingPubkey,
              });
            } catch {
              // Persistence failed. Do NOT ACK this as paired: owner-route
              // silent crypto is gated on the ConnectedClient.allowAlways row,
              // so ACK-without-persist creates a "paired" client whose first
              // nip44_decrypt fails as "not connected" and cannot retry the
              // one-shot secret. Keep the secret until TTL so the consumer can
              // retry after a transient IndexedDB/version problem.
              await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'pairing failed — try again');
              return;
            }
          }
          register.delete(matchedKey);
        }
      }
      await publishResponse(route.backend, request.clientPubkey, request.id, 'ack');
      return;
    }

    // For non-connect methods on a bound dependant route, enforce the
    // client-pubkey binding up front. An unpaired endpoint (no bound
    // client, no pair in flight) also refuses — same "not paired" code.
    if (route.dependantId) {
      if (route.routeKind === 'app') {
        // App route: walk the on-disk pairings list (read fresh from IDB
        // to avoid stale React state after a recent bind). Reject any
        // request whose client pubkey doesn't match a stored pairing.
        // Without an encryption key in the parent we can't load — fail
        // closed.
        const key = appPairingsKeyRef.current;
        if (!key) {
          await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'not paired');
          return;
        }
        let pairings: import('../types').TrustedAppPairing[] = [];
        try {
          pairings = await db.listAppBunkerPairings(route.dependantId, key);
        } catch {
          pairings = [];
        }
        if (!pairingMatches(pairings, request.clientPubkey)) {
          await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'not paired');
          return;
        }
        // Note `lastSeenAt` for this pairing. Per-request DB write is
        // simpler than a debounced ref-cache; the pairings store is
        // small (cap = TRUSTED_APP_PAIRING_CAP = 5) and the write goes
        // through saveDependant which already runs on each sign anyway.
        // Best-effort — never fails the inbound request.
        db.touchAppBunkerPairing(route.dependantId, request.clientPubkey, key).catch(() => { /* non-fatal */ });
      } else if (route.authorizedClientPubkey) {
        if (request.clientPubkey.toLowerCase() !== route.authorizedClientPubkey.toLowerCase()) {
          await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'not paired');
          return;
        }
      } else {
        await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'not paired');
        return;
      }
    }

    if (request.method === 'ping') {
      await publishResponse(route.backend, request.clientPubkey, request.id, 'pong');
      return;
    }

    if (request.method === 'switch_relays') {
      // NIP-46 expects a JSON array of relay URLs or JSON null. MySignet's
      // relay choice is still owned by app state, so the truthful response is
      // "no change" until we wire a persisted server-side relay migration.
      await publishResponse(route.backend, request.clientPubkey, request.id, JSON.stringify(null));
      return;
    }

    if (request.method === 'logout') {
      // Per NIP-46, ACK before removing session state so the client receives a
      // definite result. Deletes are best-effort: failure should not make the
      // already-acknowledged logout look like a timeout.
      await publishResponse(route.backend, request.clientPubkey, request.id, 'ack');
      if (!route.dependantId) {
        db.deleteConnectedClient(request.clientPubkey).catch(() => { /* non-fatal */ });
      } else if (route.routeKind === 'app') {
        const key = appPairingsKeyRef.current;
        if (key) {
          db.removeAppBunkerPairing(route.dependantId, request.clientPubkey, key).catch(() => { /* non-fatal */ });
        }
      }
      return;
    }

    if (request.method === 'get_public_key') {
      // For dependant routes, return the DEPENDANT's signing pubkey (what
      // the client thinks it's paired with) — not the endpoint pubkey
      // which is just transport. For guardian routes the two are equal.
      const signingBackend = route.signingBackend ?? route.backend;
      await publishResponse(route.backend, request.clientPubkey, request.id, signingBackend.activePublicKeyHex);
      return;
    }

    if (
      request.method === 'nip04_encrypt'
      || request.method === 'nip04_decrypt'
      || request.method === 'nip44_encrypt'
      || request.method === 'nip44_decrypt'
    ) {
      const theirPubkey = request.params[0];
      const payload = request.params[1];
      if (typeof theirPubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(theirPubkey)
          || typeof payload !== 'string') {
        await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'invalid params');
        return;
      }
      // Owner-route gate (security audit 2026-06-15). NIP-04/NIP-44
      // encrypt/decrypt are SILENT operations — there is no approval prompt
      // for them. Without this
      // gate, any relay client could use the owner's key as a NIP-44 decryption/
      // encryption oracle during an owner-serve window (the route pubkey is the
      // user's public persona pubkey). Require the same bearer credential the
      // silent sign_event auto-approve path requires: a ConnectedClient with
      // allowAlways. Dependant/app routes are exempt — they hit the
      // autonomy-stage policy gate below instead.
      if (!route.dependantId) {
        let owner: import('../types').ConnectedClient | undefined;
        try { owner = await db.getConnectedClient(request.clientPubkey); }
        catch { owner = undefined; }
        if (!ownerRouteNip44Authorised(route.dependantId, owner)) {
          await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'not connected');
          return;
        }
      }
      // Dep-route policy gate (audit pass 4 high). Without this, a paired
      // app on a dep route could silently decrypt DMs / gift-wraps addressed
      // to the dep's signing key — bypassing Charter schedule + autonomy
      // stage + per-dep rate-limit. We treat silent crypto as null-scope (no
      // origin/scope inference possible — there's no Nostr event template).
      // Conservative this phase: ask-* policies REJECT (no prompt UI for
      // silent crypto yet — the security-correct stance is deny until we wire one);
      // auto-* policies allow and emit audit per the same matrix used by
      // sign_event. full-autonomy is silent like sign_event's `auto`.
      if (route.dependantId && route.autonomyStage) {
        // Rate-limit (same key as sign_event — share the per-dep budget).
        const prevRl = rateLimitRef.current.get(route.dependantId);
        const nowMs = Date.now();
        const rl = checkRateLimit(prevRl, nowMs);
        rateLimitRef.current.set(route.dependantId, rl.newState);
        if (!rl.allowed) {
          const lastNotified = rateLimitNotifiedRef.current.get(route.dependantId) ?? 0;
          if (lastNotified < rl.newState.windowStart) {
            rateLimitNotifiedRef.current.set(route.dependantId, nowMs);
            try { onRateLimitRef.current?.(route.dependantId); } catch { /* non-fatal */ }
          }
          await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'rate limited');
          return;
        }
        // Charter clause #1: schedule check. Silent crypto has no per-origin grant,
        // so only the dep's defaultSchedule applies.
        if (route.defaultSchedule) {
          const decision = isWithinSchedule(route.defaultSchedule);
          if (!decision.allowed) {
            const reason: 'paused' | 'outside-allowed-hours' = route.defaultSchedule.paused
              ? 'paused'
              : 'outside-allowed-hours';
            const wireReason = reason === 'paused' ? 'paused' : 'outside_allowed_hours';
            await publishResponse(
              route.backend,
              request.clientPubkey,
              request.id,
              undefined,
              `charter:clause_blocked:schedule:${wireReason}`,
            );
            fireAudit({
              dependantPubkey: route.dependantId,
              method: request.method,
              counterpartyPubkey: theirPubkey.toLowerCase(),
              outcome: 'clause-blocked',
              clauseType: 'schedule',
              clauseReason: reason,
              scheduleSource: 'dep-default',
              scheduleIssuedAt: route.defaultSchedule.issuedAt,
              nextAllowedAt: decision.nextAllowedAt
                ? Math.floor(decision.nextAllowedAt.getTime() / 1000)
                : undefined,
            });
            return;
          }
        }
        // Stage policy with null scope (no Nostr-event template to classify).
        const policy = resolvePolicy(route.autonomyStage, null);
        if (policy !== 'auto' && policy !== 'auto-alert' && policy !== 'auto-log') {
          // blocked / ask-origin / ask-every — deny + audit. We don't
          // surface a prompt for silent crypto yet; deny is the conservative call.
          await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'ask your guardian — this account cannot do that');
          fireAudit({
            dependantPubkey: route.dependantId,
            method: request.method,
            counterpartyPubkey: theirPubkey.toLowerCase(),
            outcome: 'auto-denied',
          });
          return;
        }
        // auto / auto-alert / auto-log all fall through to the operation.
        // auto-alert and auto-log emit audit; pure auto is silent.
        if (policy !== 'auto') {
          fireAudit({
            dependantPubkey: route.dependantId,
            method: request.method,
            counterpartyPubkey: theirPubkey.toLowerCase(),
            outcome: 'auto-approved',
          });
        }
      }
      try {
        // For dependant routes use signingBackend (the inner identity key),
        // NOT the transport backend — the consumer's NIP-44 is addressed
        // to the dependant's signing pubkey (the one returned by
        // get_public_key for that route), not the transport pubkey.
        const inner = route.signingBackend ?? route.backend;
        if (request.method === 'nip04_encrypt' && !inner.nip04Encrypt) {
          await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'NIP-04 not supported');
          return;
        }
        if (request.method === 'nip04_decrypt' && !inner.nip04Decrypt) {
          await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'NIP-04 not supported');
          return;
        }
        const result = request.method === 'nip04_encrypt'
          ? await inner.nip04Encrypt!(theirPubkey, payload)
          : request.method === 'nip04_decrypt'
            ? await inner.nip04Decrypt!(theirPubkey, payload)
            : request.method === 'nip44_encrypt'
              ? await inner.nip44Encrypt(theirPubkey, payload)
              : await inner.nip44Decrypt(theirPubkey, payload);
        await publishResponse(route.backend, request.clientPubkey, request.id, result);
        // `connectedClients` rows only exist for guardian-route NIP-46
        // sessions (the guardian-route server). Dependant routes (device + app)
        // have their own lastSeenAt mechanisms and never have a
        // ConnectedClient record, so the read+write here would be a
        // guaranteed no-op IDB round-trip per nip44 call. Skip it for
        // dependant routes — the binding gate above already updated
        // lastSeenAt for app-route pairings via touchAppBunkerPairing.
        if (!route.dependantId) {
          const existing = await db.getConnectedClient(request.clientPubkey);
          if (existing) {
            await db.saveConnectedClient({ ...existing, lastSeenAt: Math.floor(Date.now() / 1000) });
          }
        }
      } catch {
        const failedEncrypt = request.method === 'nip04_encrypt' || request.method === 'nip44_encrypt';
        await publishResponse(route.backend, request.clientPubkey, request.id, undefined,
          failedEncrypt ? 'encryption failed' : 'decryption failed');
      }
      return;
    }

    // Other methods still reject explicitly so
    // the client gets a definite answer rather than timing out. sign_event
    // is the 80% case for today's pairings.
    if (request.method !== 'sign_event') {
      await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'method not supported');
      return;
    }

    // Per-dependant rate-limit. Applies to dependant routes only —
    // a compromised child device must not be able to DoS the guardian's
    // approval modal by flooding sign requests. Guardian's own routes are
    // not rate-limited (same attack surface as today's guardian-route server).
    if (route.dependantId) {
      const prev = rateLimitRef.current.get(route.dependantId);
      const nowMs = Date.now();
      const rl = checkRateLimit(prev, nowMs);
      rateLimitRef.current.set(route.dependantId, rl.newState);
      if (!rl.allowed) {
        // Debounce the notification — fire once per window, not per request.
        const lastNotified = rateLimitNotifiedRef.current.get(route.dependantId) ?? 0;
        if (lastNotified < rl.newState.windowStart) {
          rateLimitNotifiedRef.current.set(route.dependantId, nowMs);
          try { onRateLimitRef.current?.(route.dependantId); } catch { /* non-fatal */ }
        }
        await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'rate limited');
        return;
      }
    }

    // Queue cap. Before this, it was a hard one-at-a-time busy guard so
    // mobile users wouldn't see stacked modals. Now we buffer up
    // to `PENDING_APPROVALS_CAP` requests so the desktop panel can
    // render the full queue (holodeck OQ8: serial modals on mobile, list
    // on desktop). Mobile UI still only exposes the head of the queue
    // via the `pendingApproval` alias below, so its behaviour is
    // unchanged. Overflow past the cap still rejects with `busy`.
    if (queueSizeRef.current >= PENDING_APPROVALS_CAP) {
      await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'busy');
      return;
    }

    const rawTemplate = request.params[0];
    if (typeof rawTemplate !== 'string') {
      await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'missing template');
      return;
    }
    const template = parseSignEventTemplate(rawTemplate);
    if (!template) {
      await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'invalid template');
      return;
    }

    // Infer scope + origin once. Used by both the dependant policy path
    // (grant lookup, policy decision) and the resolveApproval grant save.
    const scope = inferScope(template);
    const origin = scope ? inferOrigin(template, scope) : null;

    // Guardian-route auto-approve: whole-client "allow always" bit.
    // Dependant routes skip this — they use the per-(scope, origin) grants
    // store and the autonomy-stage policy matrix below instead.
    if (!route.dependantId) {
      // Owner persona routes are pubkey-keyed — the route's pubkey IS the
      // signing identity. Refuse a template that explicitly names a different
      // pubkey than this connection is bound to, so a client paired to persona
      // X can never obtain an event attributed to persona Y. Templates with no
      // pubkey (standard NIP-46) sign as the route's persona, unchanged. This
      // runs before both the allow-always auto-approve and the manual-approval
      // enqueue, so a mismatched request is never signed by either path.
      if (ownerRoutePubkeyMismatch(route.pubkey, template.pubkey)) {
        await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'pubkey mismatch');
        return;
      }
      const existing = await db.getConnectedClient(request.clientPubkey);
      // Identity-sensitive scopes (pairing new NIP-46 clients, mutating the
      // profile / display name) are never auto-approved even when a
      // connected client has `allowAlways: true`. `allowAlways` is a
      // whole-client bearer credential — without this carve-out, a single
      // "Allow always for <app>" click would authorise that app to pair
      // further bunker clients or rename the guardian's identity silently.
      const sensitiveForAllowAlways = scope === 'pair-device' || scope === 'mutate-identity';
      if (existing?.allowAlways && !sensitiveForAllowAlways) {
        try {
          const signed = await (route.signingBackend ?? route.backend).signEvent(template);
          await publishResponse(route.backend, request.clientPubkey, request.id, JSON.stringify(signed));
          await db.saveConnectedClient({
            ...existing,
            lastSeenAt: Math.floor(Date.now() / 1000),
          });
        } catch {
          await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'signing failed');
        }
        return;
      }
    }

    // Dependant-route policy path (phone-as-family-bunker). Grants honoured
    // at every stage (forward-only revocation); stage defaults only apply
    // when no grant exists for this (dependantId, scope, origin).
    if (route.dependantId && route.autonomyStage) {
      // Pre-compute audit identity fields for the decision points below.
      const auditCounterparty = firstPTagPubkey(template);

      // §5.4.1 publicProfile pre-auth gate: kid-initiated kind-0 (profile
      // publish) and kind-5 (retraction of a previous kind-0) auto-sign
      // when a valid pre-auth record exists for this (dep, persona,
      // kid-client, kind) tuple. The guardian explicitly enabled the
      // public profile from GuardianSettings — re-prompting per persona
      // per update would be high-friction and add nothing to the trust
      // story. Bypasses the charter schedule + grant + stage policy
      // layers because the per-auth record IS the authoritative policy
      // for these specific event kinds.
      //
      // Strict scoping per §5.4.1 step 3:
      //   - kind ∈ {0, 5} only
      //   - event.pubkey === pre-auth.personaPubkey (no cross-persona piggybacking)
      //   - request.clientPubkey === pre-auth.kidClientPubkey (no third-app piggybacking)
      //   - expiresAt > now (24h TTL, refreshed on each guardian save)
      // Any mismatch falls through to manual approval like any other sign_event.
      //
      // Empty-pubkey behaviour: standard NIP-46 clients send `sign_event`
      // templates WITHOUT a pubkey field (the bunker is the one bound to
      // an identity, so the client doesn't need to specify which key to
      // use). `parseInnerEventTemplate` parses missing pubkey to `''`.
      // For the gate to fire today we resolve the effective pubkey from
      // the route's bound signer when the template field is empty. Once
      // a multi-key NIP-46 extension lands that carries pubkey in the
      // template, this fallback becomes the rare case rather than the
      // common one — but the scoping invariant still holds because the
      // resolved pubkey is what actually gets signed.
      if (template.kind === 0 || template.kind === 5) {
        const effectivePubkey = template.pubkey
          || (route.signingBackend ?? route.backend).activePublicKeyHex;
        let preauth = false;
        try {
          preauth = await db.isPublicProfileSignAuthorised(
            route.dependantId,
            effectivePubkey,
            request.clientPubkey,
            template.kind,
          );
        } catch { preauth = false; }
        if (preauth) {
          try {
            // Pick the persona-specific signing backend via the resolver if
            // wired; falls back to the route's NP-bound backend. The
            // resolver is the only path that produces a signature
            // verifiable under a non-NP persona's pubkey — without it,
            // kind-0 for the dep's persona / extras would round-trip a
            // signature that doesn't match event.pubkey. Resolver lookup
            // uses the SAME effective pubkey the gate matched on.
            const personaBackend = route.personaSigningBackendByPubkey?.(effectivePubkey) ?? null;
            const signingBackend = personaBackend ?? route.signingBackend ?? route.backend;
            const signed = await signingBackend.signEvent(template);
            await publishResponse(route.backend, request.clientPubkey, request.id, JSON.stringify(signed));
            fireAudit({
              dependantPubkey: route.dependantId,
              eventKind: template.kind,
              counterpartyPubkey: auditCounterparty,
              origin: origin ?? undefined,
              outcome: 'auto-approved',
            });
          } catch {
            await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'signing failed');
          }
          return;
        }
      }
      // Pre-load grant so the schedule check below has the per-origin
      // schedule available before any decision branches. The actual
      // allow/deny branches still re-use this `grant` reference.
      let grant: RememberedGrant | undefined = undefined;
      if (scope && origin && isOriginScopedScope(scope)) {
        grant = await db.lookupGrant(route.dependantId, scope, origin);
      }

      // Charter clause #1: schedule check.
      // Wire format per the Charter schedule contract:
      // - error string: `charter:clause_blocked:schedule:<reason>`
      // - audit tags: `clause` = clause type, `reason` = specific cause
      // Apply BEFORE allow/deny branches so the parent's clock-bound
      // policy is enforced even when there's an existing "allow" grant.
      // An explicit deny still wins (no need to schedule-check that).
      // Intersection of per-origin (grant.schedule) and dep-default
      // (route.defaultSchedule) is the effective window — per-origin
      // can never extend dep-default. Empty = unrestricted.
      if (grant?.decision !== 'deny') {
        const effective = intersectSchedules(grant?.schedule, route.defaultSchedule);
        if (effective) {
          const decision = isWithinSchedule(effective);
          if (!decision.allowed) {
            // Distinguish paused (parent flipped the global pause) from
            // outside-allowed-hours (active clock-window is closed).
            // The contract names them as separate reasons so consumers
            // can render different copy.
            const reason: 'paused' | 'outside-allowed-hours' = effective.paused
              ? 'paused'
              : 'outside-allowed-hours';
            const wireReason = reason === 'paused' ? 'paused' : 'outside_allowed_hours';
            await publishResponse(
              route.backend,
              request.clientPubkey,
              request.id,
              undefined,
              `charter:clause_blocked:schedule:${wireReason}`,
            );
            const sourceTag: 'per-origin' | 'dep-default' | 'intersection' =
              grant?.schedule && route.defaultSchedule
                ? 'intersection'
                : grant?.schedule
                  ? 'per-origin'
                  : 'dep-default';
            fireAudit({
              dependantPubkey: route.dependantId,
              eventKind: template.kind,
              counterpartyPubkey: auditCounterparty,
              origin: origin ?? undefined,
              outcome: 'clause-blocked',
              clauseType: 'schedule',
              clauseReason: reason,
              scheduleSource: sourceTag,
              scheduleIssuedAt: effective.issuedAt,
              nextAllowedAt: decision.nextAllowedAt
                ? Math.floor(decision.nextAllowedAt.getTime() / 1000)
                : undefined,
            });
            return;
          }
        }
      }

      // 1) Grant lookup — origin-scoped scopes only. An existing allow/deny
      //    decision always wins, independently of the current stage.
      if (scope && origin && isOriginScopedScope(scope)) {
        if (grant?.decision === 'allow') {
          try {
            const signed = await (route.signingBackend ?? route.backend).signEvent(template);
            await publishResponse(route.backend, request.clientPubkey, request.id, JSON.stringify(signed));
            await db.saveGrant({ ...grant, lastUsedAt: Math.floor(Date.now() / 1000) });
            fireGrantMutated();
            fireAudit({
              dependantPubkey: route.dependantId,
              eventKind: template.kind,
              counterpartyPubkey: auditCounterparty,
              origin,
              outcome: 'auto-approved',
            });
          } catch {
            await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'signing failed');
          }
          return;
        }
        if (grant?.decision === 'deny') {
          await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'user denied');
          fireAudit({
            dependantPubkey: route.dependantId,
            eventKind: template.kind,
            counterpartyPubkey: auditCounterparty,
            origin,
            outcome: 'auto-denied',
          });
          return;
        }
      }

      // 2) Stage policy for this scope (or the null-scope fallback).
      const policy = resolvePolicy(route.autonomyStage, scope);
      if (policy === 'blocked') {
        await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'ask your guardian — this account cannot sign this');
        fireAudit({
          dependantPubkey: route.dependantId,
          eventKind: template.kind,
          counterpartyPubkey: auditCounterparty,
          origin: origin ?? undefined,
          outcome: 'auto-denied',
        });
        return;
      }
      if (policy === 'auto' || policy === 'auto-alert' || policy === 'auto-log') {
        try {
          const signed = await (route.signingBackend ?? route.backend).signEvent(template);
          await publishResponse(route.backend, request.clientPubkey, request.id, JSON.stringify(signed));
          // `auto-log` and `auto-alert` both emit an audit record — the
          // difference is whether the guardian's app also surfaces a
          // push-style notification (future UI concern, not the publisher's
          // job). Pure `auto` (full-autonomy) is the only stage that emits
          // nothing: the dependant is functionally independent and the
          // guardian opted out of visibility. See holodeck OQ1 / spec
          // §interaction matrix.
          if (policy !== 'auto') {
            fireAudit({
              dependantPubkey: route.dependantId,
              eventKind: template.kind,
              counterpartyPubkey: auditCounterparty,
              origin: origin ?? undefined,
              outcome: 'auto-approved',
            });
          }
        } catch {
          await publishResponse(route.backend, request.clientPubkey, request.id, undefined, 'signing failed');
        }
        return;
      }
      // ask-origin and ask-every both fall through to the prompt path below.
    }

    // Prompt path: surface to the UI for a decision. Now the
    // queue holds up to PENDING_APPROVALS_CAP entries; bump the
    // sync-visible ref alongside the React state update so the next
    // inbound-in-the-same-tick sees the new length against the cap.
    queueSizeRef.current += 1;
    const handle = ++handleCounterRef.current;
    activeRequestRef.current.set(handle, {
      requestId: request.id,
      clientPubkey: request.clientPubkey,
      template,
      route,
      scope,
      origin,
    });
    const existing = route.dependantId ? undefined : await db.getConnectedClient(request.clientPubkey);
    const appName = existing?.appName ?? 'Unknown app';
    const appUrl = existing?.appUrl;
    const entry: PendingApproval = {
      handle,
      client: {
        pubkey: request.clientPubkey,
        appName,
        appUrl,
        existing: !!existing,
      },
      route: {
        pubkey: route.pubkey,
        dependantId: route.dependantId ?? null,
      },
      method: 'sign_event',
      template,
      description: describeEventTemplate(template),
    };
    setPendingApprovals(prev => [...prev, entry]);
    try { onApprovalPendingRef.current?.(entry); } catch { /* non-fatal */ }
  }, [publishResponse]);

  /** Resolve a pending approval by its handle + decision. */
  const resolveApproval = useCallback(
    async (handle: number, decision: 'approve-once' | 'approve-always' | 'deny') => {
      const req = activeRequestRef.current.get(handle);
      if (!req) return;
      activeRequestRef.current.delete(handle);
      setPendingApprovals(prev => {
        const next = prev.filter(p => p.handle !== handle);
        queueSizeRef.current = next.length;
        return next;
      });

      const { backend } = req.route;

      if (decision === 'deny') {
        // Dependant-route denial with an origin-scoped scope: persist a deny
        // grant so the same site doesn't re-prompt on every retry.
        if (req.route.dependantId && req.scope && req.origin && isOriginScopedScope(req.scope)) {
          try {
            const existing = await db.lookupGrant(req.route.dependantId, req.scope, req.origin);
            const now = Math.floor(Date.now() / 1000);
            const grant: RememberedGrant = {
              dependantId: req.route.dependantId,
              scope: req.scope,
              origin: req.origin,
              decision: 'deny',
              decidedAt: existing?.decision === 'deny' ? existing.decidedAt : now,
              lastUsedAt: now,
            };
            await db.saveGrant(grant);
            fireGrantMutated();
          } catch { /* best-effort — denial still fires below */ }
        }
        await publishResponse(backend, req.clientPubkey, req.requestId, undefined, 'user denied');
        if (req.route.dependantId) {
          fireAudit({
            dependantPubkey: req.route.dependantId,
            eventKind: req.template.kind,
            counterpartyPubkey: firstPTagPubkey(req.template),
            origin: req.origin ?? undefined,
            outcome: 'denied',
          });
        }
        return;
      }

      let signed: NostrEvent;
      try {
        // Inner USER template signed with the dependant's signing key on
        // dependant routes; with the guardian's key on guardian routes.
        const signingBackend = req.route.signingBackend ?? req.route.backend;
        signed = await signingBackend.signEvent(req.template);
      } catch {
        await publishResponse(backend, req.clientPubkey, req.requestId, undefined, 'signing failed');
        return;
      }

      // Publish BEFORE persisting the approve-always grant, so a transient
      // IDB error doesn't mask a successful sign from the client.
      await publishResponse(backend, req.clientPubkey, req.requestId, JSON.stringify(signed));

      // Emit audit for dependant-route approvals (guardian-route signs of
      // the guardian's own identity aren't audited — OQ1 scope is the
      // dependant's activity, not the guardian's).
      if (req.route.dependantId) {
        fireAudit({
          dependantPubkey: req.route.dependantId,
          eventKind: req.template.kind,
          counterpartyPubkey: firstPTagPubkey(req.template),
          origin: req.origin ?? undefined,
          outcome: 'approved',
        });
      }

      if (decision === 'approve-always') {
        try {
          if (req.route.dependantId) {
            // Dependant: save a (dependantId, scope, origin) grant. For
            // non-origin-scoped scopes (pair-device, post-public, vouch,
            // mutate-identity) approve-always degrades to approve-once —
            // there's no natural origin to key the grant on.
            if (req.scope && req.origin && isOriginScopedScope(req.scope)) {
              // Re-read grants before writing. If the guardian explicitly
              // denied this origin previously (either just now from another
              // surface, or long ago via the Grants screen), preserve the
              // denial rather than silently upgrading to allow. The sign was
              // already published for this single request — the next sign
              // will hit the deny path as intended.
              const existing = await db.lookupGrant(req.route.dependantId, req.scope, req.origin);
              if (existing?.decision === 'deny') {
                // Keep the deny in place. Don't promote approve-once into
                // a deny-overwriting allow-always.
                return;
              }
              const now = Math.floor(Date.now() / 1000);
              const grant: RememberedGrant = {
                dependantId: req.route.dependantId,
                scope: req.scope,
                origin: req.origin,
                decision: 'allow',
                decidedAt: now,
                lastUsedAt: now,
              };
              await db.saveGrant(grant);
              fireGrantMutated();
            }
          } else {
            // Guardian route: whole-client ConnectedClient.allowAlways.
            const now = Math.floor(Date.now() / 1000);
            const existing = await db.getConnectedClient(req.clientPubkey);
            await db.saveConnectedClient({
              clientPubkey: req.clientPubkey,
              appName: existing?.appName ?? 'Unknown app',
              appUrl: existing?.appUrl,
              connectedAt: existing?.connectedAt ?? now,
              lastSeenAt: now,
              allowAlways: true,
            });
          }
        } catch { /* allowAlways persistence is best-effort; never leak internals */ }
      }
    },
    [publishResponse],
  );

  const approveOnce = useCallback(
    (handle: number) => resolveApproval(handle, 'approve-once'),
    [resolveApproval],
  );
  const approveAlways = useCallback(
    (handle: number) => resolveApproval(handle, 'approve-always'),
    [resolveApproval],
  );
  const deny = useCallback(
    (handle: number) => resolveApproval(handle, 'deny'),
    [resolveApproval],
  );

  // Subscription lifecycle — open/close based on deps + auto-reconnect on
  // ws.onerror / onclose with exponential backoff. Real-world relays drop
  // connections silently (WiFi switch, idle timeout, relay restart); before
  // this loop the bunker server quietly died without user-visible signal.
  const routesKeyStr = routesKey(routes);
  useEffect(() => {
    // Every early return below was previously SILENT — an aborted subscription
    // was indistinguishable from a listening one. Each now reports its reason
    // to the panel (serveStatus) and the console.
    if (!enabled) {
      setServeStatus({ ...INITIAL_SERVE_STATUS, phase: 'off' });
      return;
    }
    if (routes.length === 0) {
      devLog('[bunker-serve] not listening: no routes to serve');
      setServeStatus({ ...INITIAL_SERVE_STATUS, phase: 'no-routes', relayUrl: relayUrl ?? null });
      return;
    }
    if (!relayUrl || !isValidRelayUrl(relayUrl)) {
      devLog('[bunker-serve] not listening: invalid relay URL:', JSON.stringify(relayUrl));
      setServeStatus({ ...INITIAL_SERVE_STATUS, phase: 'bad-relay', relayUrl: relayUrl ?? '(empty)' });
      return;
    }

    // §5.4.1 expired pre-auth sweep on mount. Cheap (typical record count
    // is single-digit), no scheduled timer needed — next mount cleans up.
    void db.sweepExpiredPublicProfileSignAuth().catch(() => { /* non-fatal */ });

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0; // 0 = first connect; grows on each reconnect

    const pubkeys = routes.map(r => r.pubkey);

    const scheduleReconnect = () => {
      if (cancelled) return;
      // Exponential backoff capped at 30s: 500ms, 1s, 2s, 4s, 8s, 16s, 30s.
      const delay = Math.min(30_000, 500 * Math.pow(2, attempt));
      attempt += 1;
      devLog(`[bunker-serve] reconnecting in ${delay}ms (attempt ${attempt})`);
      setServeStatus(s => ({ ...s, phase: 'reconnecting', reconnectAttempt: attempt, openedAt: null }));
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        openSocket();
      }, delay);
    };

    const openSocket = () => {
      if (cancelled) return;
      const subId = 'bunker-' + Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      subIdRef.current = subId;

      devLog(`[bunker-serve] connecting to ${relayUrl} (${pubkeys.length} route(s))`);
      setServeStatus(s => ({ ...s, phase: 'connecting', relayUrl, routePubkeys: pubkeys, openedAt: null }));

      let ws: WebSocket;
      try {
        ws = new WebSocket(relayUrl);
      } catch {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        // Reset the backoff on each successful connection.
        attempt = 0;
        const filter = {
          kinds: [24133],
          '#p': pubkeys,
          since: Math.floor(Date.now() / 1000) - 60,
        };
        try { ws.send(JSON.stringify(['REQ', subId, filter])); } catch { /* ignore */ }
        devLog(`[bunker-serve] open — REQ sent (#p: ${pubkeys.map(p => p.slice(0, 8)).join(',')})`);
        setServeStatus(s => ({ ...s, phase: 'open', openedAt: Date.now(), reconnectAttempt: 0 }));
      };

      ws.onmessage = (msg) => {
        let parsed: unknown;
        try { parsed = JSON.parse(typeof msg.data === 'string' ? msg.data : String(msg.data)); }
        catch { return; }
        if (!Array.isArray(parsed)) return;
        const [tag, ...rest] = parsed as unknown[];
        // Telemetry before any filtering: every inbound frame is liveness
        // proof, and a NOTICE is the relay explaining itself (rate limit,
        // rejected REQ) — exactly what a silent serve bug needs surfaced.
        if (!cancelled) {
          const isNotice = tag === 'NOTICE' && typeof rest[0] === 'string';
          const isOurEvent = tag === 'EVENT' && rest[0] === subId;
          if (isNotice) devLog('[bunker-serve] relay NOTICE:', rest[0]);
          setServeStatus(s => ({
            ...s,
            frameCount: s.frameCount + 1,
            lastFrameAt: Date.now(),
            ...(isNotice ? { lastNotice: rest[0] as string } : {}),
            ...(isOurEvent ? { lastEventAt: Date.now() } : {}),
          }));
        }
        if (tag !== 'EVENT' || rest[0] !== subId) return;
        const event = rest[1] as NostrEvent;
        handleInboundEvent(event).catch(() => { /* ignored per security invariant: never leak internals */ });
      };

      // Real-world relays don't always deliver onclose cleanly; onerror
      // often fires first. Either one triggers reconnection — unless the
      // cleanup below set `cancelled`, in which case we exit quietly.
      ws.onerror = () => {
        if (cancelled) return;
        try { ws.close(); } catch { /* ignore */ }
      };
      ws.onclose = (e) => {
        if (cancelled) return;
        devLog(`[bunker-serve] socket closed (code ${e.code})`);
        if (wsRef.current === ws) wsRef.current = null;
        if (subIdRef.current === subId) subIdRef.current = null;
        scheduleReconnect();
      };
    };

    openSocket();

    return () => {
      cancelled = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const ws = wsRef.current;
      const subId = subIdRef.current;
      const pendingRequests = Array.from(activeRequestRef.current.values());

      activeRequestRef.current.clear();
      queueSizeRef.current = 0;
      bindingInFlightRef.current.clear();
      setPendingApprovals([]);

      const closeSocket = () => {
        if (ws) {
          // Polite CLOSE before socket drop.
          if (ws.readyState === WebSocket.OPEN && subId) {
            try { ws.send(JSON.stringify(['CLOSE', subId])); } catch { /* ignore */ }
          }
          try { ws.close(); } catch { /* ignore */ }
        }
        if (wsRef.current === ws) wsRef.current = null;
        if (subIdRef.current === subId) subIdRef.current = null;
      };

      if (ws && ws.readyState === WebSocket.OPEN && pendingRequests.length > 0) {
        // Best-effort drain of queued approvals before teardown. Without this,
        // the requesting app waits until its own timeout even though MySignet
        // already knows the serve session ended.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const drain = Promise.allSettled(pendingRequests.map(req =>
          publishResponseToSocket(
            ws,
            req.route.backend,
            req.clientPubkey,
            req.requestId,
            undefined,
            'serving stopped',
          )));
        void Promise.race([
          drain,
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, 1000);
          }),
        ]).finally(() => {
          if (timer !== undefined) clearTimeout(timer);
          closeSocket();
        });
      } else {
        closeSocket();
      }
    };
    // routesKeyStr is the stable routes-list hash used instead of the
    // Array reference; handleInboundEvent reads from routesRef so it
    // doesn't need to be a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, relayUrl, routesKeyStr, handleInboundEvent, reconnectNonce]);

  // `pendingApproval` is the head-of-queue convenience alias used by the
  // BunkerApprovalModal (one-modal-at-a-time). `pendingApprovals` is the
  // full queue, consumed by the BunkerPanel pending-requests list.
  const pendingApproval = pendingApprovals[0] ?? null;
  return { pendingApproval, pendingApprovals, approveOnce, approveAlways, deny, serveStatus };
}
