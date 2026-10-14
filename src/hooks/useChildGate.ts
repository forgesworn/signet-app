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
import { childTargetsFor, decideChildCrypto, decideChildRequest, preflight, type ChildGateVerdict } from '../lib/child-gate';
import { appTarget, peerTarget, siteTarget } from '../lib/child-rules';
import type { AppPermissionClaim } from '../lib/app-permission';
import { inferScope } from '../lib/scope-inference';
import { checkRateLimit, type RateLimitState } from '../lib/rate-limit';
import {
  buildAskEvent, openVerdictEvent, CHILD_SIGN_ASK_TTL_S, type ChildSignAsk,
} from '../lib/child-sign-asks';
import { childOutcomeForSignerError, type ChildActivityEntry, type ConnectedChildApp } from '../lib/child-activity';
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
  /**
   * D6: the app's claim for a kind-30420 app-permission request (the app's
   * own acts only). An ask in that scope carries it and is addressed to
   * `site:<origin>`; on any other request it is ignored.
   */
  appPermission?: AppPermissionClaim;
  appPermissionApproved?: boolean;
  /** Local presentation callback; never serialized into a request. */
  onGuardianAsk?: () => void;
  /**
   * Part B: My Signet's own relay-mode Sign in with Signet (the answer seal
   * pass sets it, on the 21236 only). An ask for a kind-21236 signature in
   * scope sign-in carries it so the guardian's card can say so and its Allow
   * once opens the seal too; on any other request it is ignored.
   */
  signIn?: { sharesHandle: boolean };
  /**
   * M2: the caller withdrew the request (the person cancelled). A held ask
   * is dropped at once — its verdict is no longer listened for, so a later
   * Allow on the guardian's card is never forwarded to the Heartwood — and
   * the request settles `withdrawn`. Nothing is sent to the guardian.
   */
  abort?: AbortSignal;
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
  /**
   * Run once the gate has allowed a request (signed, or an ask approved) and
   * BEFORE its request stamp is reserved: a deferred ("Later") persona's
   * ALLOW AS probe. A refused request never reaches it, and the stamp is taken
   * after it, so waiting on the device button never ages a stamp or lets a
   * later request's stamp go out first (A58). False ⇒ `blocked`.
   */
  beforeStamp?(persona: string): Promise<boolean>;
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
  /** `sent`: raised for a caller that could not wait (the answer applies to its next try). `withdrawn`: the child cancelled it. */
  state: 'waiting' | 'sent' | 'approved' | 'denied' | 'expired' | 'withdrawn';
}
export const CHILD_GATE_ASK_HISTORY_MAX = 50;
/** A60: a forwarded request whose result never comes back is forgotten after this. */
const PENDING_REPORT_TTL_MS = 10 * 60_000;

export interface ChildGate {
  authorise(req: ChildGateRequest): Promise<ChildGateOutcome>;
  /**
   * D7: forward WITHOUT a gate decision. Keeps everything else `authorise`
   * does — the unpaired / persona checks, the persona on the template (A12),
   * the preflight (disconnected app, blocking app rule, rate limit), the
   * `beforeStamp` probe, the request stamp and the activity record — and
   * skips only `decideChildRequest` / `decideChildCrypto`.
   *
   * For the answer seal pass ONLY (`answer-seal-pass.ts`), which calls it
   * just for the exact encrypt and seal of an answer it has itself built
   * around a signature the gate already allowed. The NIP-46 and NIP-55
   * server paths never see it: they are handed `authorise` alone.
   */
  forwardPassed(req: ChildGateRequest): Promise<ChildGateOutcome>;
  pendingAsks: PendingChildGateAsk[];
  /** A60: the child's own asks (newest first, pending and answered; in memory). */
  askHistory: ChildGateAskRecord[];
  noteConnectedApp(app: ConnectedChildApp): void;
  connectedApps: ConnectedChildApp[];
}

interface Held { id: string; settle(outcome: ChildGateOutcome): void }

/** A request past its opening checks (`prepare`). */
interface Prepared {
  at: { direct: PairedChildRecord | null; rules: ChildRulesPayload | null; relays: string[]; unpaired: boolean; recordKey: string };
  rec: PairedChildRecord & { railPubkey: string };
  persona: string;
  nowMs: number;
  base: { persona: string; method: ChildGateMethod; appId: string; appLabel: string };
  template?: UnsignedEvent;
  kind: number | null;
}

/** A refusing verdict's code. Only the guardian's own rules are `denied` (I1). */
function refusal(v: ChildGateVerdict): ChildGateError {
  if (v.verdict === 'blocked') return 'blocked';
  return v.verdict === 'deny' && v.reason === 'rate-limit' ? 'rate-limited' : 'denied';
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
  const beforeStampRef = useRef(opts.beforeStamp);
  beforeStampRef.current = opts.beforeStamp;

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
  // there is recorded as denied — but a timeout or an unreachable Heartwood
  // is not a refusal, and is recorded as unanswered / failed.
  const pendingReports = useRef(new Map<string, { entry: Omit<ChildActivityEntry, 'at'>; addedAt: number }>());
  useEffect(() => {
    pendingReports.current.clear();
    if (!recordKey) return;
    return observeStampedCalls((r) => {
      const k = `${r.persona}:${r.createdAt}`;
      const hit = pendingReports.current.get(k);
      if (!hit) return;
      pendingReports.current.delete(k);
      emit(r.ok ? hit.entry : { ...hit.entry, outcome: childOutcomeForSignerError(r.error) });
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

  /** The checks every request starts with; A12: the persona is on the template before anything is decided or asked. */
  const prepare = useCallback((req: ChildGateRequest): Prepared | { ok: false; error: ChildGateError } => {
    const at = live.current;
    const rec = at.direct;
    if (at.unpaired || !rec || !rec.railPubkey) return { ok: false, error: 'unpaired' };
    const persona = (req.persona ?? '').toLowerCase();
    if (!HEX64.test(persona)) return { ok: false, error: 'denied' };
    const nowMs = nowRef.current();
    const base = { persona, method: req.method, appId: req.appId, appLabel: req.appLabel };
    touchApp(req.appId, persona, req.appLabel);

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
    return { at, rec: { ...rec, railPubkey: rec.railPubkey }, persona, nowMs, base, template, kind: template ? template.kind : null };
  }, [touchApp]);

  /**
   * Probe (beforeStamp), stamp, and the pending activity record. `redecide`
   * (an unprompted `signed` only) re-runs the decision when the rules changed
   * while the probe waited.
   */
  const forwardFor = useCallback(async (
    p: Prepared, req: ChildGateRequest, outcome: 'signed' | 'approved', target?: string, redecide?: (rules: ChildRulesPayload | null) => ChildGateVerdict,
  ): Promise<ChildGateOutcome> => {
    const { at, persona, base, kind, template } = p;
    const probe = beforeStampRef.current;
    let probed = true;
    if (probe) { try { probed = await probe(persona); } catch { probed = false; } }
    // As before the reorder: a refused probe is not a gate decision, so nothing is reported.
    if (!probed) return { ok: false, error: 'blocked' };
    if (req.abort?.aborted) return { ok: false, error: 'withdrawn' };
    if (probe) {
      // The probe can wait on the Heartwood's button: the record or the
      // rules may have changed meanwhile. An unprompted allow is re-decided
      // on the rules as they are now (a guardian approval stands).
      const now = live.current;
      if (now.unpaired || now.recordKey !== at.recordKey) return { ok: false, error: 'unpaired' };
      if (redecide && now.rules !== at.rules) {
        const again = redecide(now.rules);
        if (again.verdict !== 'sign') {
          emit({ ...base, kind, outcome: again.verdict === 'blocked' ? 'blocked' : 'denied' });
          return { ok: false, error: again.verdict === 'ask' ? 'denied' : refusal(again) };
        }
      }
    }
    const requestCreatedAt = await reserveRequestCreatedAt(persona, { now: () => nowRef.current() });
    const t = nowRef.current();
    for (const [k, v] of pendingReports.current) if (t - v.addedAt > PENDING_REPORT_TTL_MS) pendingReports.current.delete(k);
    pendingReports.current.set(`${persona}:${requestCreatedAt}`, {
      entry: { ...base, kind, outcome, ...(target ? { target } : {}), requestCreatedAt }, addedAt: t,
    });
    touchApp(req.appId, persona, req.appLabel);
    return { ok: true, requestCreatedAt, ...(template ? { template } : {}) };
  }, [emit, touchApp]);

  const forwardPassed = useCallback(async (req: ChildGateRequest): Promise<ChildGateOutcome> => {
    if (req.abort?.aborted) return { ok: false, error: 'withdrawn' };
    const p = prepare(req);
    if (!('at' in p)) return p;
    const early = preflight(p.at.rules, p.persona, req.appId, p.nowMs, rateRef.current);
    rateRef.current = checkRateLimit(rateRef.current, p.nowMs).newState;
    if (early) {
      emit({ ...p.base, kind: p.kind, outcome: early.verdict === 'blocked' ? 'blocked' : 'denied' });
      return { ok: false, error: refusal(early) };
    }
    return forwardFor(p, req, 'approved');
  }, [prepare, forwardFor, emit]);

  const authorise = useCallback(async (req: ChildGateRequest): Promise<ChildGateOutcome> => {
    if (req.abort?.aborted) return { ok: false, error: 'withdrawn' };
    const p = prepare(req);
    if (!('at' in p)) return p;
    const { at, rec, persona, nowMs, base, template, kind } = p;

    const rateBefore = rateRef.current;
    const decide = (rules: typeof at.rules) => template
      ? decideChildRequest({ rules, persona, template, appId: req.appId, siteOrigin: req.siteOrigin, nowMs, rateState: rateBefore, appPermission: req.appPermission, appPermissionApproved: req.appPermissionApproved })
      : decideChildCrypto({ rules, persona, appId: req.appId, method: req.method as 'nip44_encrypt' | 'nip44_decrypt', peer: req.peer!.toLowerCase(), nowMs, rateState: rateBefore });
    const verdict = decide(at.rules);
    rateRef.current = checkRateLimit(rateRef.current, nowMs).newState;

    const forward = (outcome: 'signed' | 'approved', target?: string) =>
      forwardFor(p, req, outcome, target, outcome === 'signed' ? decide : undefined);

    if (verdict.verdict === 'sign') return forward('signed');
    if (verdict.verdict !== 'ask') {
      emit({ ...base, kind, outcome: verdict.verdict === 'blocked' ? 'blocked' : 'denied' });
      return { ok: false, error: refusal(verdict) };
    }

    try { req.onGuardianAsk?.(); } catch { /* presentation must not change the decision */ }

    // ── Ask the guardian ──────────────────────────────────────────────────
    if (held.current.size >= CHILD_GATE_MAX_HELD) return { ok: false, error: 'busy' };
    const scope = template ? inferScope(template) : 'dm-private';
    // D6: an app-permission ask carries the app's claim and names its origin.
    const appPermission = scope === 'app-permission' ? req.appPermission : undefined;
    // Part B: the sign-in marker, on a 21236 signature in scope sign-in only.
    const signIn = scope === 'sign-in' && kind === 21236 && req.signIn ? { sharesHandle: req.signIn.sharesHandle } : undefined;
    let target: ChildRuleTarget | null;
    if (appPermission) {
      target = siteTarget(appPermission.origin);
    } else if (template) {
      // A site/peer target must be one the guardian can re-derive from the
      // template itself (A12); otherwise the ask names the app.
      target = childTargetsFor(template, scope, '')[0] ?? (req.appId ? appTarget(req.appId) : null);
    } else {
      target = peerTarget(req.peer!);
    }
    if (!target) { emit({ ...base, kind, outcome: 'denied' }); return { ok: false, error: 'unsent' }; }

    const nowS = Math.floor(nowMs / 1000);
    const id = bytesToHex(randomBytes(16));
    const ask: ChildSignAsk = {
      v: 1, id, dependantId: rec.dependantPubkey.toLowerCase(), persona, scope, kind: kind ?? 0,
      method: req.method, target, targetLabel: (req.appLabel || req.siteOrigin || 'An app').slice(0, 100),
      createdAt: nowS, expiresAt: nowS + CHILD_SIGN_ASK_TTL_S, ...(template ? { template } : {}),
      ...(appPermission ? { appPermission } : {}),
      ...(signIn ? { signIn } : {}),
    };
    let ev: NostrEvent;
    try { ev = await buildAskEvent(ask, rec.clientKeypair.privateKey, rec.railPubkey); }
    catch { emit({ ...base, kind, outcome: 'denied', target }); return { ok: false, error: 'unsent' }; }
    if (live.current.recordKey !== at.recordKey || live.current.unpaired) return { ok: false, error: 'unpaired' };
    if (held.current.size >= CHILD_GATE_MAX_HELD) return { ok: false, error: 'busy' };
    if (req.abort?.aborted) return { ok: false, error: 'withdrawn' };

    const relays = at.relays;
    const clientPriv = rec.clientKeypair.privateKey;
    const clientPub = rec.clientKeypair.publicKey;
    const railPub = rec.railPubkey;
    const wait = req.wait !== false;

    return new Promise<ChildGateOutcome>((resolve) => {
      let done = false;
      let unsubscribe: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = req.abort;
      const onAbort = () => {
        if (done) return;
        answerAsk(id, 'withdrawn');
        settle({ ok: false, error: 'withdrawn' });
      };
      const settle = (outcome: ChildGateOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe?.();
        abort?.removeEventListener('abort', onAbort);
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
      abort?.addEventListener('abort', onAbort);
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
              // I1: a deny that carries a reason is the guardian's phone
              // failing (or the ask running out), not their No.
              settle({ ok: false, error: v.reason === 'device-unreachable' ? 'device-unreachable' : v.reason === 'expired' ? 'expired' : 'denied' });
              return;
            }
            // A12: the forwarded template is the one the guardian was asked
            // about — `template` itself, never re-read from the caller.
            answerAsk(id, 'approved');
            // Part B: what else the guardian's push opened for THIS answer
            // (Allow once or Always; `checkVerdict` refuses it on a deny)
            // rides on the outcome, for the answer seal pass. A request
            // allowed by a rule or the stage has no verdict, so never sets it.
            const also = v.verdict === 'once' || v.verdict === 'always' ? v.alsoOpened : undefined;
            void forward('approved', target)
              .then(o => (o.ok && also && also.length > 0 ? { ...o, alsoOpened: [...also] } : o))
              .then(settle);
          });
        },
      );
      const unsent = () => { emit({ ...base, kind, outcome: 'denied', target }); answerAsk(id, 'denied'); settle({ ok: false, error: 'unsent' }); };
      void transportRef.current.publish(ev, relays).then((r) => { if (!r.ok) unsent(); }).catch(unsent);
    });
  }, [prepare, forwardFor, emit, askTimeoutMs, noteAsk, answerAsk]);

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

  return useMemo(() => ({ authorise, forwardPassed, pendingAsks, askHistory, noteConnectedApp, connectedApps }),
    [authorise, forwardPassed, pendingAsks, askHistory, noteConnectedApp, connectedApps]);
}
