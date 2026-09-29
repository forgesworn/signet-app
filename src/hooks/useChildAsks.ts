/**
 * Guardian asks inbox (child-direct Heartwood pairing, spec §7 guardian half).
 *
 * For every dependant whose own phone is paired straight to the Heartwood,
 * subscribe on that phone's rail relay (A25: `childDevice.railRelay`, falling
 * back to the configured relays) for asks authored by the child's client key
 * and addressed to the rail key. Each event is opened and scope-checked
 * (`openAskEvent`: persona in the child's inventory, kind/scope/target
 * consistent with the template, A12 integrity) — anything else is dropped and
 * never shown.
 *
 * `decide()` — first verdict per ask id wins:
 *   always → ChildRule (persona-specific, target from the ask) + `onRulesChanged`;
 *   once   → nothing stored here (the caller keeps the approved-once kind);
 *   deny   → an optional deny rule when "Always deny" is ticked.
 * When a sign_event's kind is outside the dependant's CURRENT ceiling, the
 * widened ceiling is pushed (`pushCeiling`) BEFORE the verdict is published;
 * a failed push sends `deny` with `device-unreachable` (Review Focus 3). An
 * "Always" or "Allow once" the 64-kind ceiling cannot hold is refused and
 * answered `deny` (A5).
 *
 * History (last 200 verdicts) is guardian-local, in an encrypted row.
 * Never throws out of an effect.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NostrEvent, NostrFilter } from 'signet-protocol';
import type { DependantIdentity } from '../types';
import type { ChildRule } from '../types/child-rules';
import {
  buildVerdictEvent, openAskEvent, CHILD_SIGN_ASK_LIVE_LIMIT, CHILD_SIGN_ASK_TTL_S,
  type ChildSignAsk, type ChildSignVerdict,
} from '../lib/child-sign-asks';
import { childRuleId } from '../lib/child-rules';
import { compileChildDirectPolicy } from '../lib/policy-compiler';
import { resolveAuditVisibility } from '../lib/audit-visibility';
import { replyPersonas } from '../lib/child-device-pairing';
import { isValidRelayUrl } from '../lib/relay-url';
import { listChildRules, loadChildAskHistory, saveChildAskHistory, saveChildRule, type ApprovedOnceKinds } from '../lib/db';
import { publishEvent, subscribeEvents } from '../lib/relay-service';
import type { OnceEntry } from '../lib/policy-push';

export interface PendingChildAsk {
  ask: ChildSignAsk;
  dependantId: string;
  dependantName: string;
  personaName: string;
  /** Unix ms. */
  receivedAt: number;
}

export interface ChildAskHistoryEntry { ask: ChildSignAsk; verdict: ChildSignVerdict }

export type ChildAskDecideReason =
  | 'device-unreachable' | 'ceiling-full' | 'paused' | 'expired' | 'publish-failed'
  | 'always-unavailable' | 'already-decided' | 'not-found' | 'locked';

export interface ChildAskTransport {
  publish(event: NostrEvent, relays: string[]): Promise<{ ok: boolean; message: string }>;
  subscribe(filters: NostrFilter[], relays: string[], onEvent: (ev: NostrEvent) => void): () => void;
}
const defaultTransport: ChildAskTransport = {
  publish: (event, relays) => publishEvent(event, { relays }),
  subscribe: (filters, relays, onEvent) => subscribeEvents(filters, relays, onEvent),
};

export interface UseChildAsksOpts {
  dependants: DependantIdentity[];
  /** Fallback rail relays for records without `childDevice.railRelay`. */
  relays: string[];
  encryptionKey: string | null;
  /** Approved-once kinds per dependant (the caller's state) — part of the current ceiling. */
  approvedOnceKinds?: ApprovedOnceKinds;
  /**
   * Push the dependant's ceiling now (a no-op on the device when it already
   * matches); `extraOnce` is added as approved-once first, and removed again
   * by the pusher if the push fails.
   */
  pushCeiling(depId: string, extraOnce?: OnceEntry): Promise<'ok' | 'failed'>;
  /** A34: give back an approved-once entry whose `once` verdict never reached the child. */
  dropOnce?(depId: string, entry: OnceEntry): Promise<void>;
  onRulesChanged(): void;
  onNewAsk?(a: PendingChildAsk): void;
  transport?: ChildAskTransport;
  now?: () => number;
}

export interface UseChildAsks {
  asks: PendingChildAsk[];
  decide(id: string, verdict: 'once' | 'always' | 'deny', opts?: { alwaysDeny?: boolean }): Promise<{ sent: boolean; reason?: ChildAskDecideReason }>;
  history: ChildAskHistoryEntry[];
}

export const CHILD_ASK_HISTORY_MAX = 200;
export const CHILD_ASK_ONCE_WINDOW_S = 600;
const PRUNE_MS = 15_000;
const HEX64 = /^[0-9a-f]{64}$/;

interface DirectChild {
  dep: DependantIdentity;
  id: string;
  railPub: string;
  railPriv: string;
  client: string;
  relays: string[];
}

/** Dependants whose own phone is paired straight to the Heartwood and fully bound. */
export function directChildren(dependants: DependantIdentity[], fallbackRelays: string[]): DirectChild[] {
  const out: DirectChild[] = [];
  for (const dep of dependants) {
    const cd = dep.childDevice;
    const ep = dep.bunkerEndpoint;
    if (cd?.mode !== 'heartwood-direct' || !ep?.privateKey || !HEX64.test(ep.publicKey ?? '')) continue;
    const client = (cd.clientPubkey ?? '').toLowerCase();
    if (!HEX64.test(client) || (ep.authorizedClientPubkey ?? '').toLowerCase() !== client) continue;
    const relays = cd.railRelay && isValidRelayUrl(cd.railRelay) ? [cd.railRelay] : fallbackRelays.filter(r => isValidRelayUrl(r));
    if (relays.length === 0) continue;
    out.push({ dep, id: dep.id.toLowerCase(), railPub: ep.publicKey, railPriv: ep.privateKey, client, relays });
  }
  return out;
}

/** The kinds the dependant's slot would list; `'all'` at full-autonomy. */
function ceilingFor(dep: DependantIdentity, rules: ChildRule[], once: { kind: number; until: number }[], nowS: number): number[] | 'all' {
  const paused = dep.defaultSchedule?.paused === true;
  if (!paused && dep.autonomyStage === 'full-autonomy') return 'all';
  return compileChildDirectPolicy({
    stage: dep.autonomyStage,
    paused,
    rules,
    approvedOnceKinds: once,
    boundPersona: dep.childDevice!.boundPersona,
    auditVisible: resolveAuditVisibility(dep.autonomyStage, dep.auditVisibility),
    nowSeconds: nowS,
  }).allowedKinds;
}
const holds = (c: number[] | 'all', kind: number) => c === 'all' || c.includes(kind);
/**
 * A5: the widened ceiling must list the new kind AND keep every kind it lists
 * now — the firmware holds at most 64, and the compiler would otherwise make
 * room by silently dropping an older rule's kind.
 */
const fits = (current: number[] | 'all', widened: number[] | 'all', kind: number) =>
  widened === 'all' || (widened.includes(kind) && (current === 'all' || current.every(k => widened.includes(k))));

function isHistoryEntry(x: unknown): x is ChildAskHistoryEntry {
  if (!x || typeof x !== 'object') return false;
  const o = x as { ask?: { id?: unknown }; verdict?: { id?: unknown; verdict?: unknown } };
  return typeof o.ask?.id === 'string' && typeof o.verdict?.id === 'string' && o.ask.id === o.verdict.id
    && (o.verdict.verdict === 'once' || o.verdict.verdict === 'always' || o.verdict.verdict === 'deny');
}

export function useChildAsks(opts: UseChildAsksOpts): UseChildAsks {
  const [asks, setAsks] = useState<PendingChildAsk[]>([]);
  const [history, setHistory] = useState<ChildAskHistoryEntry[]>([]);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const asksRef = useRef<PendingChildAsk[]>([]);
  const historyRef = useRef<ChildAskHistoryEntry[]>([]);
  /** Ask ids already shown, answered, or being answered — never raised twice. */
  const seenRef = useRef(new Set<string>());
  const decidingRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const now = () => (optsRef.current.now ?? Date.now)();
  const transport = () => optsRef.current.transport ?? defaultTransport;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const commitAsks = useCallback((next: PendingChildAsk[]) => {
    asksRef.current = next;
    if (mountedRef.current) setAsks(next);
  }, []);

  // History: load once per unlock; answered ids are never raised again.
  const { encryptionKey } = opts;
  const [historyLoaded, setHistoryLoaded] = useState(false);
  useEffect(() => {
    historyRef.current = [];
    setHistory([]);
    setHistoryLoaded(false);
    commitAsks([]);
    seenRef.current = new Set();
    if (!encryptionKey) return;
    let cancelled = false;
    loadChildAskHistory(encryptionKey)
      .then((raw) => {
        if (cancelled) return;
        const entries = raw.filter(isHistoryEntry).slice(0, CHILD_ASK_HISTORY_MAX);
        historyRef.current = entries;
        for (const e of entries) seenRef.current.add(e.ask.id);
        setHistory(entries);
        setHistoryLoaded(true);
      })
      .catch(() => { if (!cancelled) setHistoryLoaded(true); });
    return () => { cancelled = true; };
  }, [encryptionKey, commitAsks]);

  // Subscriptions, one per direct-paired child; re-armed only when a binding changes.
  const children = useMemo(() => directChildren(opts.dependants, opts.relays), [opts.dependants, opts.relays]);
  const bindingKey = children.map(c => `${c.id}|${c.railPub}|${c.client}|${c.relays.join(',')}`).join(';');
  useEffect(() => {
    if (!encryptionKey || !historyLoaded) return;
    const unsubs: (() => void)[] = [];
    for (const c of children) {
      const since = Math.floor(now() / 1000) - CHILD_SIGN_ASK_TTL_S;
      unsubs.push(transport().subscribe(
        [{ kinds: [30078], authors: [c.client], '#p': [c.railPub], since }],
        c.relays,
        (ev) => { void onAskEvent(c, ev); },
      ));
    }
    return () => { for (const u of unsubs) { try { u(); } catch { /* already closed */ } } };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindingKey, encryptionKey, historyLoaded]);

  const onAskEvent = async (c: DirectChild, ev: NostrEvent) => {
    const nowS = Math.floor(now() / 1000);
    const dep = optsRef.current.dependants.find(d => d.id.toLowerCase() === c.id) ?? c.dep;
    const inventory = replyPersonas(dep);
    const ask = await openAskEvent(ev, c.railPriv, { clientPubkey: c.client, dependantId: c.id, personas: inventory.map(p => p.pubkey), nowS });
    if (!ask || !mountedRef.current || seenRef.current.has(ask.id)) return;
    if (asksRef.current.filter(a => a.dependantId === c.id).length >= CHILD_SIGN_ASK_LIVE_LIMIT) return;
    seenRef.current.add(ask.id);
    const pending: PendingChildAsk = {
      ask, dependantId: c.id, dependantName: dep.displayName,
      personaName: inventory.find(p => p.pubkey === ask.persona)?.name ?? dep.displayName,
      receivedAt: now(),
    };
    commitAsks([...asksRef.current, pending]);
    try { optsRef.current.onNewAsk?.(pending); } catch { /* notification is best effort */ }
  };

  // Expired asks leave the list (the child has already given up on them).
  useEffect(() => {
    const id = setInterval(() => {
      const nowS = Math.floor(now() / 1000);
      const live = asksRef.current.filter(a => a.ask.expiresAt > nowS);
      if (live.length !== asksRef.current.length) commitAsks(live);
    }, PRUNE_MS);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitAsks]);

  const recordHistory = async (entry: ChildAskHistoryEntry) => {
    const next = [entry, ...historyRef.current.filter(e => e.ask.id !== entry.ask.id)].slice(0, CHILD_ASK_HISTORY_MAX);
    historyRef.current = next;
    if (mountedRef.current) setHistory(next);
    const key = optsRef.current.encryptionKey;
    if (key) { try { await saveChildAskHistory(next, key); } catch { /* kept in memory this session */ } }
  };

  const decide = useCallback(async (id: string, verdict: 'once' | 'always' | 'deny', dopts?: { alwaysDeny?: boolean }): Promise<{ sent: boolean; reason?: ChildAskDecideReason }> => {
    if (decidingRef.current.has(id)) return { sent: false, reason: 'already-decided' };
    const pending = asksRef.current.find(a => a.ask.id === id);
    if (!pending) return { sent: false, reason: historyRef.current.some(e => e.ask.id === id) ? 'already-decided' : 'not-found' };
    const o = optsRef.current;
    const key = o.encryptionKey;
    if (!key) return { sent: false, reason: 'locked' };
    const c = directChildren(o.dependants, o.relays).find(x => x.id === pending.dependantId);
    if (!c) return { sent: false, reason: 'not-found' };
    const dep = c.dep;
    if (verdict === 'always' && dep.autonomyStage === 'full-control') return { sent: false, reason: 'always-unavailable' };
    decidingRef.current.add(id);

    const ask = pending.ask;
    const nowMs = now();
    const nowS = Math.floor(nowMs / 1000);
    let reason: ChildAskDecideReason | undefined;
    let out: ChildSignVerdict = { v: 1, id, verdict, decidedAt: nowS };

    const finish = async (): Promise<{ sent: boolean; reason?: ChildAskDecideReason }> => {
      let ok = false;
      try {
        const ev = await buildVerdictEvent(out, c.railPriv, c.client);
        ok = (await transport().publish(ev, c.relays)).ok;
      } catch { ok = false; }
      if (!ok) {
        decidingRef.current.delete(id); // the guardian may try again; side effects are idempotent
        return { sent: false, reason: 'publish-failed' };
      }
      commitAsks(asksRef.current.filter(a => a.ask.id !== id));
      // History keeps what was asked, not the event body (the row stays small).
      const { template: _t, ...slim } = ask;
      void _t;
      await recordHistory({ ask: slim, verdict: out });
      return { sent: true, ...(reason ? { reason } : {}) };
    };
    const refuse = (r: ChildAskDecideReason, wire?: ChildSignVerdict['reason']) => {
      reason = r;
      out = { v: 1, id, verdict: 'deny', decidedAt: nowS, ...(wire ? { reason: wire } : {}) };
      return finish();
    };

    if (ask.expiresAt <= nowS) return refuse('expired', 'expired');

    let rules: ChildRule[];
    try { rules = await listChildRules(c.id, key); } catch { decidingRef.current.delete(id); return { sent: false, reason: 'publish-failed' }; }
    const onceFor = Object.entries(o.approvedOnceKinds ?? {}).filter(([k]) => k.toLowerCase() === c.id).flatMap(([, v]) => v);
    const scope = ask.scope ?? `kind:${ask.kind}`;
    const signs = ask.method === 'sign_event';

    if (verdict === 'deny') {
      if (dopts?.alwaysDeny) {
        const rule: ChildRule = {
          id: childRuleId(c.id, ask.persona, scope, ask.target), dependantId: c.id, persona: ask.persona, scope, target: ask.target,
          decision: 'deny', label: ask.targetLabel, createdAt: nowMs, updatedAt: nowMs,
        };
        try { await saveChildRule(rule, key); o.onRulesChanged(); out = { ...out, alwaysDeny: true, ruleId: rule.id }; } catch { /* a plain deny still goes */ }
      }
      return finish();
    }

    if (signs && dep.defaultSchedule?.paused === true) return refuse('paused');

    const current = ceilingFor(dep, rules, onceFor, nowS);
    const needsPush = signs && !holds(current, ask.kind);

    if (verdict === 'always') {
      const rule: ChildRule = {
        id: childRuleId(c.id, ask.persona, scope, ask.target), dependantId: c.id, persona: ask.persona, scope, target: ask.target,
        decision: 'allow', label: ask.targetLabel, createdAt: nowMs, updatedAt: nowMs,
      };
      // A5: the 64-kind ceiling must be able to hold it.
      if (needsPush && !fits(current, ceilingFor(dep, [...rules.filter(r => r.id !== rule.id), rule], onceFor, nowS), ask.kind)) return refuse('ceiling-full');
      try { await saveChildRule(rule, key); } catch { decidingRef.current.delete(id); return { sent: false, reason: 'publish-failed' }; }
      o.onRulesChanged();
      out = { ...out, ruleId: rule.id };
      if (needsPush && (await o.pushCeiling(c.id)) !== 'ok') return refuse('device-unreachable', 'device-unreachable');
      return finish();
    }

    // once
    if (needsPush) {
      const widened = ceilingFor(dep, rules, [...onceFor, { kind: ask.kind, until: nowS + CHILD_ASK_ONCE_WINDOW_S }], nowS);
      if (!fits(current, widened, ask.kind)) return refuse('ceiling-full');
      if ((await o.pushCeiling(c.id, { kind: ask.kind, until: nowS + CHILD_ASK_ONCE_WINDOW_S })) !== 'ok') return refuse('device-unreachable', 'device-unreachable');
    }
    return finish();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitAsks]);

  return { asks, decide, history };
}
