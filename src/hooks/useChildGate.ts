/**
 * The child's gate (child-direct Heartwood pairing, spec §8, §7 child side).
 *
 * ONE choke point for everything the child's phone signs or decrypts as a
 * persona: Sign in with Signet (`siteOrigin`), the child's NIP-46 server
 * (appId = client pubkey), NIP-55 (appId `nip55:<package>`) and the app's own
 * acts (appId `mysignet`). `authorise` resolves when the request may be
 * forwarded to the persona's Heartwood route:
 *
 *   sign   → { ok, requestCreatedAt, template } at once
 *   ask    → an ask to the guardian on the rail relay (≤ 20 held, else
 *            `busy`); resolves on the verdict (`once`/`always` ⇒ ok,
 *            `deny` ⇒ denied), on expiry (`expired`) or on unpairing
 *            (`unpaired`, Review Focus 5)
 *   deny / blocked → refused, nothing asked
 *
 * `requestCreatedAt` comes from `reserveRequestCreatedAt(persona)`: strictly
 * increasing per persona, ≥ now and never more than 30 s ahead (A58: a burst
 * waits), stamped by the caller on the NIP-46
 * request envelope (`withRequestCreatedAt`) — the Heartwood echoes it in its
 * C5 rumor and the guardian joins the two records on it (§9.2).
 *
 * A12: the persona is set on the template BEFORE the ask is built, and only
 * the template the ask was built from (its `templateHash`) is ever forwarded.
 * A60: a forwarded request is recorded as signed / approved only after the
 * Heartwood returns it; the child's own asks are kept (in memory) for its
 * read-only Permissions page.
 * The rate limit (10/min) is read by the pure gate and advanced here, once
 * per request. `rules === null` ⇒ every request asks (fail closed).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NostrEvent, NostrFilter, UnsignedEvent } from 'signet-protocol';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import type { PairedChildRecord } from '../types';
import type { ChildRulesPayload } from '../lib/child-rules-wire';
import type { ChildRuleTarget } from '../types/child-rules';
import { childTargetsFor, decideChildCrypto, decideChildRequest, type ChildGateVerdict } from '../lib/child-gate';
import { appTarget, peerTarget } from '../lib/child-rules';
import { inferScope } from '../lib/scope-inference';
import { checkRateLimit, type RateLimitState } from '../lib/rate-limit';
import {
  buildAskEvent, openVerdictEvent, CHILD_SIGN_ASK_TTL_S, type ChildSignAsk,
} from '../lib/child-sign-asks';
import type { ChildActivityEntry, ConnectedChildApp } from '../lib/child-activity';
import type { ChildGateError, ChildGateMethod, ChildGateOutcome } from '../lib/child-bunker';
import { publishEvent, subscribeEvents } from '../lib/relay-service';
import { observeStampedCalls } from '../lib/signing-backend';

export type { ChildGateOutcome, ChildGateError, ChildGateMethod } from '../lib/child-bunker';

/** Asks held waiting for the guardian at once; the next is `busy`. */
export const CHILD_GATE_MAX_HELD = 20;
/** Connected apps kept (most recently used). */
export const CHILD_CONNECTED_APPS_MAX = 64;

const REPLY_PREFIX = 'signet:child-sign-reply:v1:';
const HEX64 = /^[0-9a-f]{64}$/;

// ── Forced request created_at ─────────────────────────────────────────────
const lastStamp = new Map<string, number>();

/** A58: a stamp never runs more than this far ahead of the clock (seconds). */
export const REQUEST_STAMP_MAX_AHEAD_S = 30;

/**
 * Strictly increasing per persona, never below now (unix seconds). Null —
 * nothing reserved — when the next stamp would run more than
 * REQUEST_STAMP_MAX_AHEAD_S ahead of now (A58); `reserveRequestCreatedAt` waits.
 */
export function nextRequestCreatedAt(persona: string, nowMs: number = Date.now()): number | null {
  const p = persona.toLowerCase();
  const nowS = Math.floor(nowMs / 1000);
  const next = Math.max(nowS, (lastStamp.get(p) ?? 0) + 1);
  if (next > nowS + REQUEST_STAMP_MAX_AHEAD_S) return null;
  lastStamp.set(p, next);
  return next;
}

/** A58: the next stamp for `persona`, waiting until it fits within now + 30 s. */
export async function reserveRequestCreatedAt(
  persona: string,
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  for (;;) {
    const n = nextRequestCreatedAt(persona, now());
    if (n !== null) return n;
    const last = lastStamp.get(persona.toLowerCase()) ?? 0;
    const waitS = last + 1 - REQUEST_STAMP_MAX_AHEAD_S - Math.floor(now() / 1000);
    await sleep(Math.max(1, waitS) * 1000);
  }
}

/** Test seam only. */
export function resetRequestCreatedAtForTests(): void {
  lastStamp.clear();
}

// ── Hook ─────────────────────────────────────────────────────────────────
export interface ChildGateRequest {
  persona: string;
  appId: string;
  appLabel: string;
  siteOrigin?: string;
  method: ChildGateMethod;
  template?: UnsignedEvent;
  peer?: string;
  /** False: raise an ask but do not hold the caller (NIP-55 content provider) ⇒ `asked`. */
  wait?: boolean;
}

export interface ChildGateTransport {
  publish(event: NostrEvent, relays: string[]): Promise<{ ok: boolean; message: string }>;
  subscribe(filters: NostrFilter[], relays: string[], onEvent: (ev: NostrEvent) => void): () => void;
}
const defaultTransport: ChildGateTransport = {
  publish: (event, relays) => publishEvent(event, { relays }),
  subscribe: (filters, relays, onEvent) => subscribeEvents(filters, relays, onEvent),
};

export interface UseChildGateOpts {
  record: PairedChildRecord | null;
  rules: ChildRulesPayload | null;
  /** The rail relay(s) asks go out on and verdicts come back on. */
  relays: string[];
  unpaired: boolean;
  onActivity(e: ChildActivityEntry): void;
  transport?: ChildGateTransport;
  /** Unix ms clock (test seam). */
  now?: () => number;
  /** Test seam: how long an ask is held (default the ask TTL). */
  askTimeoutMs?: number;
}

export interface PendingChildGateAsk { id: string; targetLabel: string; since: number }

/** A60: one of the child's own asks, as its read-only Permissions page shows it. */
export interface ChildGateAskRecord {
  id: string;
  targetLabel: string;
  persona: string;
  kind: number;
  /** Rule scope (`sign-in`, …) or `kind:<n>`. */
  scope: string;
  /** Unix seconds. */
  since: number;
  /** `sent`: raised for a caller that could not wait (the answer applies to its next try). */
  state: 'waiting' | 'sent' | 'approved' | 'denied' | 'expired';
}
export const CHILD_GATE_ASK_HISTORY_MAX = 50;
/** A60: a forwarded request whose result never comes back is forgotten after this. */
const PENDING_REPORT_TTL_MS = 10 * 60_000;

export interface ChildGate {
  authorise(req: ChildGateRequest): Promise<ChildGateOutcome>;
  pendingAsks: PendingChildGateAsk[];
  /** A60: the child's own asks (newest first, pending and answered; in memory). */
  askHistory: ChildGateAskRecord[];
  noteConnectedApp(app: ConnectedChildApp): void;
  connectedApps: ConnectedChildApp[];
}

interface Held { id: string; settle(outcome: ChildGateOutcome): void }

function refusal(v: ChildGateVerdict): ChildGateError {
  return v.verdict === 'blocked' ? 'blocked' : 'denied';
}

export function useChildGate(opts: UseChildGateOpts): ChildGate {
  const direct = opts.record?.mode === 'heartwood-direct' ? opts.record : null;
  const recordKey = direct ? `${direct.id}:${direct.clientKeypair.publicKey}` : '';
  const live = useRef({ direct, rules: opts.rules, relays: opts.relays, unpaired: opts.unpaired, recordKey });
  live.current = { direct, rules: opts.rules, relays: opts.relays, unpaired: opts.unpaired, recordKey };
  const onActivityRef = useRef(opts.onActivity);
  onActivityRef.current = opts.onActivity;
  const transportRef = useRef(opts.transport ?? defaultTransport);
  transportRef.current = opts.transport ?? defaultTransport;
  const nowRef = useRef(opts.now ?? (() => Date.now()));
  nowRef.current = opts.now ?? (() => Date.now());
  const askTimeoutMs = opts.askTimeoutMs ?? CHILD_SIGN_ASK_TTL_S * 1000;

  const rateRef = useRef<RateLimitState>({ count: 0, windowStart: 0 });
  const held = useRef(new Map<string, Held>());
  const [pendingAsks, setPendingAsks] = useState<PendingChildGateAsk[]>([]);
  const [connectedApps, setConnectedApps] = useState<ConnectedChildApp[]>([]);
  const [askHistory, setAskHistory] = useState<ChildGateAskRecord[]>([]);
  const noteAsk = useCallback((rec: ChildGateAskRecord) => {
    setAskHistory(prev => [rec, ...prev.filter(r => r.id !== rec.id)].slice(0, CHILD_GATE_ASK_HISTORY_MAX));
  }, []);
  const answerAsk = useCallback((id: string, state: ChildGateAskRecord['state']) => {
    setAskHistory(prev => prev.map(r => (r.id === id ? { ...r, state } : r)));
  }, []);

  // Review Focus 5: unpairing (or a different pairing) rejects every held ask.
  useEffect(() => {
    if (!opts.unpaired && recordKey) return;
    for (const h of [...held.current.values()]) h.settle({ ok: false, error: 'unpaired' });
  }, [opts.unpaired, recordKey]);
  useEffect(() => () => {
    for (const h of [...held.current.values()]) h.settle({ ok: false, error: 'unpaired' });
  }, [recordKey]);

  const emit = useCallback((e: Omit<ChildActivityEntry, 'at'>) => {
    try { onActivityRef.current({ ...e, at: Math.floor(nowRef.current() / 1000) }); } catch { /* bookkeeping only */ }
  }, []);

  // A60: a forwarded request is recorded as signed / approved only once the
  // Heartwood has answered it (matched on persona + request stamp); a refusal
  // there is recorded as denied.
  const pendingReports = useRef(new Map<string, { entry: Omit<ChildActivityEntry, 'at'>; addedAt: number }>());
  useEffect(() => {
    pendingReports.current.clear();
    if (!recordKey) return;
    return observeStampedCalls((r) => {
      const k = `${r.persona}:${r.createdAt}`;
      const hit = pendingReports.current.get(k);
      if (!hit) return;
      pendingReports.current.delete(k);
      emit(r.ok ? hit.entry : { ...hit.entry, outcome: 'denied' });
    });
  }, [recordKey, emit]);

  // A55: every gated request touches its app — and lists one not seen yet (a
  // NIP-46 app that resumed without `connect`), so the guardian can find and
  // block it. The app's own acts (`mysignet`) are not an app.
  const touchApp = useCallback((appId: string, persona: string, label: string) => {
    const kind: ConnectedChildApp['kind'] | null = HEX64.test(appId) ? 'nip46'
      : appId.startsWith('nip55:') ? 'nip55' : appId.startsWith('site:') ? 'site' : null;
    if (!kind) return;
    const at = Math.floor(nowRef.current() / 1000);
    setConnectedApps(prev => prev.some(a => a.appId === appId)
      ? prev.map(a => a.appId === appId ? { ...a, persona, lastUsed: Math.max(a.lastUsed, at) } : a)
      : [{ appId, kind, label: (label || `App ${appId.slice(0, 8)}`).slice(0, 100), persona, firstSeen: at, lastUsed: at }, ...prev]
        .sort((a, b) => b.lastUsed - a.lastUsed).slice(0, CHILD_CONNECTED_APPS_MAX));
  }, []);

  const authorise = useCallback(async (req: ChildGateRequest): Promise<ChildGateOutcome> => {
    const at = live.current;
    const rec = at.direct;
    if (at.unpaired || !rec || !rec.railPubkey) return { ok: false, error: 'unpaired' };
    const persona = (req.persona ?? '').toLowerCase();
    if (!HEX64.test(persona)) return { ok: false, error: 'denied' };
    const nowMs = nowRef.current();
    const base = { persona, method: req.method, appId: req.appId, appLabel: req.appLabel };
    touchApp(req.appId, persona, req.appLabel);

    // A12: the persona is on the template before anything is decided or asked.
    let template: UnsignedEvent | undefined;
    if (req.method === 'sign_event') {
      if (!req.template) return { ok: false, error: 'denied' };
      template = {
        kind: req.template.kind, created_at: req.template.created_at,
        tags: req.template.tags.map(t => [...t]), content: req.template.content, pubkey: persona,
      };
    } else if (!req.peer || !HEX64.test(req.peer.toLowerCase())) {
      return { ok: false, error: 'denied' };
    }
    const kind = template ? template.kind : null;

    const verdict = template
      ? decideChildRequest({ rules: at.rules, persona, template, appId: req.appId, siteOrigin: req.siteOrigin, nowMs, rateState: rateRef.current })
      : decideChildCrypto({ rules: at.rules, persona, appId: req.appId, method: req.method as 'nip44_encrypt' | 'nip44_decrypt', peer: req.peer!.toLowerCase(), nowMs, rateState: rateRef.current });
    rateRef.current = checkRateLimit(rateRef.current, nowMs).newState;

    const forward = async (outcome: 'signed' | 'approved', target?: string): Promise<ChildGateOutcome> => {
      const requestCreatedAt = await reserveRequestCreatedAt(persona, { now: () => nowRef.current() });
      const t = nowRef.current();
      for (const [k, v] of pendingReports.current) if (t - v.addedAt > PENDING_REPORT_TTL_MS) pendingReports.current.delete(k);
      pendingReports.current.set(`${persona}:${requestCreatedAt}`, {
        entry: { ...base, kind, outcome, ...(target ? { target } : {}), requestCreatedAt }, addedAt: t,
      });
      touchApp(req.appId, persona, req.appLabel);
      return { ok: true, requestCreatedAt, ...(template ? { template } : {}) };
    };

    if (verdict.verdict === 'sign') return forward('signed');
    if (verdict.verdict !== 'ask') {
      emit({ ...base, kind, outcome: verdict.verdict === 'blocked' ? 'blocked' : 'denied' });
      return { ok: false, error: refusal(verdict) };
    }

    // ── Ask the guardian ──────────────────────────────────────────────────
    if (held.current.size >= CHILD_GATE_MAX_HELD) return { ok: false, error: 'busy' };
    const scope = template ? inferScope(template) : 'dm-private';
    let target: ChildRuleTarget | null;
    if (template) {
      // A site/peer target must be one the guardian can re-derive from the
      // template itself (A12); otherwise the ask names the app.
      target = childTargetsFor(template, scope, '')[0] ?? (req.appId ? appTarget(req.appId) : null);
    } else {
      target = peerTarget(req.peer!);
    }
    if (!target) { emit({ ...base, kind, outcome: 'denied' }); return { ok: false, error: 'denied' }; }

    const nowS = Math.floor(nowMs / 1000);
    const id = bytesToHex(randomBytes(16));
    const ask: ChildSignAsk = {
      v: 1, id, dependantId: rec.dependantPubkey.toLowerCase(), persona, scope, kind: kind ?? 0,
      method: req.method, target, targetLabel: (req.appLabel || req.siteOrigin || 'An app').slice(0, 100),
      createdAt: nowS, expiresAt: nowS + CHILD_SIGN_ASK_TTL_S, ...(template ? { template } : {}),
    };
    let ev: NostrEvent;
    try { ev = await buildAskEvent(ask, rec.clientKeypair.privateKey, rec.railPubkey); }
    catch { emit({ ...base, kind, outcome: 'denied', target }); return { ok: false, error: 'denied' }; }
    if (live.current.recordKey !== at.recordKey || live.current.unpaired) return { ok: false, error: 'unpaired' };
    if (held.current.size >= CHILD_GATE_MAX_HELD) return { ok: false, error: 'busy' };

    const relays = at.relays;
    const clientPriv = rec.clientKeypair.privateKey;
    const clientPub = rec.clientKeypair.publicKey;
    const railPub = rec.railPubkey;
    const wait = req.wait !== false;

    return new Promise<ChildGateOutcome>((resolve) => {
      let done = false;
      let unsubscribe: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (outcome: ChildGateOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe?.();
        held.current.delete(id);
        setPendingAsks(prev => prev.filter(p => p.id !== id));
        resolve(outcome);
      };
      // The caller does not wait: the ask stays live on the guardian's phone
      // (an "always" there lets the next attempt through), nothing held here.
      const record: ChildGateAskRecord = { id, targetLabel: ask.targetLabel, persona, kind: ask.kind, scope: ask.scope ?? `kind:${ask.kind}`, since: nowS, state: wait ? 'waiting' : 'sent' };
      noteAsk(record);
      if (!wait) {
        emit({ ...base, kind, outcome: 'asked', target });
        void transportRef.current.publish(ev, relays).catch(() => { /* the next attempt asks again */ });
        done = true;
        resolve({ ok: false, error: 'asked' });
        return;
      }
      held.current.set(id, { id, settle });
      setPendingAsks(prev => [...prev, { id, targetLabel: ask.targetLabel, since: nowS }]);
      emit({ ...base, kind, outcome: 'asked', target });
      timer = setTimeout(() => {
        emit({ ...base, kind, outcome: 'expired', target });
        answerAsk(id, 'expired');
        settle({ ok: false, error: 'expired' });
      }, askTimeoutMs);
      unsubscribe = transportRef.current.subscribe(
        [{ kinds: [30078], authors: [railPub], '#d': [REPLY_PREFIX + id], '#p': [clientPub] }],
        relays,
        (reply) => {
          void openVerdictEvent(reply, clientPriv, { railPubkey: railPub, id }).then((v) => {
            if (!v || done) return;
            if (live.current.unpaired || live.current.recordKey !== at.recordKey) { settle({ ok: false, error: 'unpaired' }); return; }
            if (v.verdict === 'deny') {
              emit({ ...base, kind, outcome: 'denied', target });
              answerAsk(id, 'denied');
              settle({ ok: false, error: 'denied' });
              return;
            }
            // A12: the forwarded template is the one the guardian was asked
            // about — `template` itself, never re-read from the caller.
            answerAsk(id, 'approved');
            void forward('approved', target).then(settle);
          });
        },
      );
      const unsent = () => { emit({ ...base, kind, outcome: 'denied', target }); answerAsk(id, 'denied'); settle({ ok: false, error: 'denied' }); };
      void transportRef.current.publish(ev, relays).then((r) => { if (!r.ok) unsent(); }).catch(unsent);
    });
  }, [emit, touchApp, askTimeoutMs, noteAsk, answerAsk]);

  const noteConnectedApp = useCallback((app: ConnectedChildApp) => {
    setConnectedApps(prev => {
      const existing = prev.find(a => a.appId === app.appId);
      const merged: ConnectedChildApp = existing
        ? { ...existing, ...app, firstSeen: Math.min(existing.firstSeen, app.firstSeen), lastUsed: Math.max(existing.lastUsed, app.lastUsed) }
        : app;
      return [merged, ...prev.filter(a => a.appId !== app.appId)]
        .sort((a, b) => b.lastUsed - a.lastUsed)
        .slice(0, CHILD_CONNECTED_APPS_MAX);
    });
  }, []);

  useEffect(() => { setConnectedApps([]); setAskHistory([]); }, [recordKey]);

  return useMemo(() => ({ authorise, pendingAsks, askHistory, noteConnectedApp, connectedApps }),
    [authorise, pendingAsks, askHistory, noteConnectedApp, connectedApps]);
}
