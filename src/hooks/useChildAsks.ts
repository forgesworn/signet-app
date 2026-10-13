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
 * `decide()` — first verdict per ask id wins, and (A34) it is written to the
 * encrypted history row BEFORE any side effect or publish:
 *   always → ChildRule (persona-specific, target from the ask) + `onRulesChanged`;
 *            on a marked sign-in also ONE approved-once seal (kind 13) for this
 *            answer, in the same push, reported as `alsoOpened` (the rule
 *            itself stays sign-in / 21236);
 *   once   → an approved-once entry for the kind (added by `pushCeiling`);
 *   deny   → an optional deny rule when "Always deny" is ticked.
 * For a sign_event `once` / `always` the ceiling is ALWAYS pushed
 * (`pushCeiling`, a no-op on the device when it already matches — A33) BEFORE
 * the verdict is published; a failed push sends `deny` with
 * `device-unreachable` (Review Focus 3). An "Always" or "Allow once" the
 * 64-kind ceiling cannot hold is refused and answered `deny` (A5).
 * If the publish fails the ask stays listed with its chosen verdict and the
 * only answer offered is "Send again" of that verdict; a `once` that did not
 * reach the child gives its approved-once entry back (`dropOnce`, A32 path).
 *
 * A35: the rail key's own replies are watched too — a verdict another
 * guardian device already published marks the ask answered here, and it is
 * never answered twice. An expired ask leaves the list and is not answerable (A37).
 *
 * History (last 200 verdicts) is guardian-local, in an encrypted row.
 * Never throws out of an effect.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NostrEvent, NostrFilter } from 'signet-protocol';
import type { DependantIdentity } from '../types';
import type { ChildRule } from '../types/child-rules';
import {
  buildVerdictEvent, openAskEvent, openRailVerdictEvent, signInAskDetails, CHILD_SIGN_ASK_LIVE_LIMIT, CHILD_SIGN_ASK_TTL_S,
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
import { appPermissionAskDetails } from '../lib/app-permission';

export interface PendingChildAsk {
  ask: ChildSignAsk;
  dependantId: string;
  dependantName: string;
  personaName: string;
  /** Unix ms. */
  receivedAt: number;
  /** A34: the guardian's answer is chosen and saved but has not reached the child — only "Send again" is offered. */
  unsent?: { verdict: ChildVerdictChoice };
}

export type ChildVerdictChoice = 'once' | 'always' | 'deny';

export interface ChildAskHistoryEntry {
  ask: ChildSignAsk;
  /** What is (or will be) sent; for an unsent `once`/`always` the side effects are re-run on "Send again". */
  verdict: ChildSignVerdict;
  /** The guardian's choice (absent on older rows ⇒ `verdict.verdict`). */
  chosen?: ChildVerdictChoice;
  /** False while the verdict has not been published; absent on older rows ⇒ sent. */
  sent?: boolean;
  /** Why the sent verdict differs from the choice, for the guardian. */
  reason?: ChildAskDecideReason;
}

export type ChildAskDecideReason =
  | 'device-unreachable' | 'ceiling-full' | 'paused' | 'expired' | 'publish-failed' | 'save-failed'
  | 'always-unavailable' | 'always-app-permission' | 'already-decided' | 'not-found' | 'locked';

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
   * matches); `extraOnce` (one entry, or several that must land together) is
   * added as approved-once first, and ALL of it removed again by the pusher
   * if the push fails.
   */
  pushCeiling(depId: string, extraOnce?: OnceEntry | OnceEntry[]): Promise<'ok' | 'failed'>;
  /** A34: give back the approved-once entries whose `once` verdict never reached the child. */
  dropOnce?(depId: string, entry: OnceEntry | OnceEntry[]): Promise<void>;
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
/** The NIP-59 seal: the answer to an approved app permission is sealed by the persona (D5). */
const SEAL_KIND = 13;
const HEX64 = /^[0-9a-f]{64}$/;

/** Drop a stored `alsoOpened`: only the push of the attempt that sends it may report it. */
function withoutAlsoOpened(v: ChildSignVerdict): ChildSignVerdict {
  if (v.alsoOpened === undefined) return v;
  const { alsoOpened: _a, ...rest } = v; void _a;
  return rest;
}

/**
 * Whether an Allow once also opens the seal (kind 13): My Signet's own
 * answer, which the child phone gift-wraps and seals as the same persona —
 * an app permission carrying a valid claim (D5), or a marked sign-in (Part B).
 * Both use the very predicate the card uses (`appPermissionAskDetails`,
 * `signInAskDetails`), so the seal opens only for an ask the guardian saw on
 * that card — never for one shown on the generic card. Evaluated on the live
 * ask (with its template), never on a slimmed history row.
 */
function sealsOwnAnswer(ask: ChildSignAsk): boolean {
  if (ask.method !== 'sign_event') return false;
  if (ask.scope === 'app-permission') return appPermissionAskDetails(ask) !== null;
  return signInAskDetails(ask) !== null;
}

interface DirectChild {
  dep: DependantIdentity;
  id: string;
  railPub: string;
  railPriv: string;
  client: string;
  relays: string[];
}

/**
 * Dependants whose own phone is paired straight to the Heartwood and fully bound.
 * The rail key must be DECRYPTED (64-hex): a record still carrying the at-rest
 * blob is not listed, so `bindingKey` changes (and the subscription is armed
 * with the real key) only once the record has been decrypted.
 */
export function directChildren(dependants: DependantIdentity[], fallbackRelays: string[]): DirectChild[] {
  const out: DirectChild[] = [];
  for (const dep of dependants) {
    const cd = dep.childDevice;
    const ep = dep.bunkerEndpoint;
    if (cd?.mode !== 'heartwood-direct' || !ep || !HEX64.test(ep.privateKey) || !HEX64.test(ep.publicKey ?? '')) continue;
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
/**
 * A5: the widened ceiling must list the new kind AND keep every kind it lists
 * now — the firmware holds at most 64, and the compiler would otherwise make
 * room by silently dropping an older rule's kind.
 */
const fits = (current: number[] | 'all', widened: number[] | 'all', kinds: number[]) =>
  widened === 'all' || (kinds.every(k => widened.includes(k)) && (current === 'all' || current.every(k => widened.includes(k))));

const isChoice = (v: unknown): v is ChildVerdictChoice => v === 'once' || v === 'always' || v === 'deny';
function isHistoryEntry(x: unknown): x is ChildAskHistoryEntry {
  if (!x || typeof x !== 'object') return false;
  const o = x as { ask?: { id?: unknown; expiresAt?: unknown }; verdict?: { id?: unknown; verdict?: unknown }; chosen?: unknown; sent?: unknown };
  return typeof o.ask?.id === 'string' && typeof o.verdict?.id === 'string' && o.ask.id === o.verdict.id
    && isChoice(o.verdict.verdict) && (o.chosen === undefined || isChoice(o.chosen))
    && (o.sent === undefined || typeof o.sent === 'boolean') && typeof o.ask.expiresAt === 'number';
}
const isSent = (e: ChildAskHistoryEntry) => e.sent !== false;
/** History keeps what was asked, not the event body (the row stays small). */
function slim(ask: ChildSignAsk): ChildSignAsk {
  const { template: _t, ...rest } = ask;
  void _t;
  return rest;
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
  /** A34: chosen-but-unsent verdicts, by ask id (live asks only). */
  const unsentRef = useRef(new Map<string, ChildAskHistoryEntry>());
  /** A35: verdicts the rail key has already published, by ask id. */
  const repliedRef = useRef(new Map<string, ChildSignVerdict>());
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
    unsentRef.current = new Map();
    repliedRef.current = new Map();
    if (!encryptionKey) return;
    let cancelled = false;
    loadChildAskHistory(encryptionKey)
      .then((raw) => {
        if (cancelled) return;
        const entries = raw.filter(isHistoryEntry).slice(0, CHILD_ASK_HISTORY_MAX);
        const nowS = Math.floor(now() / 1000);
        historyRef.current = entries;
        for (const e of entries) {
          // An unsent answer to a live ask waits for the ask to arrive again, with only "Send again".
          if (!isSent(e) && e.ask.expiresAt > nowS) unsentRef.current.set(e.ask.id, e);
          else seenRef.current.add(e.ask.id);
        }
        setHistory(entries);
        setHistoryLoaded(true);
      })
      .catch(() => { if (!cancelled) setHistoryLoaded(true); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encryptionKey, commitAsks]);

  /** Write the history row with `entry` first. True when it reached storage. */
  const recordHistory = async (entry: ChildAskHistoryEntry): Promise<boolean> => {
    const next = [entry, ...historyRef.current.filter(e => e.ask.id !== entry.ask.id)].slice(0, CHILD_ASK_HISTORY_MAX);
    historyRef.current = next;
    if (mountedRef.current) setHistory(next);
    const key = optsRef.current.encryptionKey;
    if (!key) return false;
    try { await saveChildAskHistory(next, key); return true; } catch { return false; /* kept in memory this session */ }
  };

  /** A35: the ask was answered by the rail key already (another guardian device). */
  const markAnswered = (id: string, verdict: ChildSignVerdict) => {
    seenRef.current.add(id);
    unsentRef.current.delete(id);
    const pending = asksRef.current.find(a => a.ask.id === id);
    const known = historyRef.current.find(e => e.ask.id === id);
    if (pending) commitAsks(asksRef.current.filter(a => a.ask.id !== id));
    const ask = pending ? slim(pending.ask) : known?.ask;
    if (ask) void recordHistory({ ask, verdict, chosen: verdict.verdict, sent: true });
  };

  // Subscriptions, one per direct-paired child; re-armed only when a binding changes.
  const children = useMemo(() => directChildren(opts.dependants, opts.relays), [opts.dependants, opts.relays]);
  const bindingKey = children.map(c => `${c.id}|${c.railPub}|${c.client}|${c.relays.join(',')}`).join(';');
  useEffect(() => {
    if (!encryptionKey || !historyLoaded) return;
    const unsubs: (() => void)[] = [];
    for (const c of children) {
      const since = Math.floor(now() / 1000) - CHILD_SIGN_ASK_TTL_S;
      unsubs.push(transport().subscribe(
        [
          { kinds: [30078], authors: [c.client], '#p': [c.railPub], since },
          // A35: replies the rail key has published (from any guardian device).
          { kinds: [30078], authors: [c.railPub], '#p': [c.client], since },
        ],
        c.relays,
        (ev) => { void (ev.pubkey === c.railPub ? onReplyEvent(c, ev) : onAskEvent(c, ev)); },
      ));
    }
    return () => { for (const u of unsubs) { try { u(); } catch { /* already closed */ } } };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindingKey, encryptionKey, historyLoaded]);

  const onReplyEvent = async (c: DirectChild, ev: NostrEvent) => {
    const verdict = await openRailVerdictEvent(ev, c.railPriv, { clientPubkey: c.client });
    if (!verdict || !mountedRef.current) return;
    const id = verdict.id;
    if (historyRef.current.some(e => e.ask.id === id && isSent(e))) return; // already answered (our own echo included)
    repliedRef.current.set(id, verdict);
    if (decidingRef.current.has(id)) return; // `decide` checks before it publishes
    markAnswered(id, verdict);
  };

  const onAskEvent = async (c: DirectChild, ev: NostrEvent) => {
    const nowS = Math.floor(now() / 1000);
    const dep = optsRef.current.dependants.find(d => d.id.toLowerCase() === c.id) ?? c.dep;
    const inventory = replyPersonas(dep);
    const ask = await openAskEvent(ev, c.railPriv, { clientPubkey: c.client, dependantId: c.id, personas: inventory.map(p => p.pubkey), nowS });
    if (!ask || !mountedRef.current || seenRef.current.has(ask.id)) return;
    const replied = repliedRef.current.get(ask.id);
    if (replied) {
      seenRef.current.add(ask.id);
      unsentRef.current.delete(ask.id);
      void recordHistory({ ask: slim(ask), verdict: replied, chosen: replied.verdict, sent: true });
      return;
    }
    if (asksRef.current.filter(a => a.dependantId === c.id).length >= CHILD_SIGN_ASK_LIVE_LIMIT) return;
    seenRef.current.add(ask.id);
    const unsent = unsentRef.current.get(ask.id);
    const pending: PendingChildAsk = {
      ask, dependantId: c.id, dependantName: dep.displayName,
      personaName: inventory.find(p => p.pubkey === ask.persona)?.name ?? dep.displayName,
      receivedAt: now(),
      ...(unsent ? { unsent: { verdict: unsent.chosen ?? unsent.verdict.verdict } } : {}),
    };
    commitAsks([...asksRef.current, pending]);
    if (!unsent) { try { optsRef.current.onNewAsk?.(pending); } catch { /* notification is best effort */ } }
  };

  // A37: an ask leaves the list the moment it expires (the child has already given up on it).
  useEffect(() => {
    if (asks.length === 0) return;
    const earliest = Math.min(...asks.map(a => a.ask.expiresAt));
    const id = setTimeout(() => {
      const nowS = Math.floor(now() / 1000);
      const live = asksRef.current.filter(a => a.ask.expiresAt > nowS);
      if (live.length !== asksRef.current.length) commitAsks(live);
    }, Math.max(0, Math.min(earliest * 1000 - now() + 50, 2 ** 31 - 1)));
    return () => clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asks, commitAsks]);

  const markUnsent = (id: string, verdict: ChildVerdictChoice) => {
    if (!asksRef.current.some(a => a.ask.id === id && a.unsent?.verdict !== verdict)) return;
    commitAsks(asksRef.current.map(a => (a.ask.id === id ? { ...a, unsent: { verdict } } : a)));
  };

  const decide = useCallback(async (id: string, verdict: ChildVerdictChoice, dopts?: { alwaysDeny?: boolean }): Promise<{ sent: boolean; reason?: ChildAskDecideReason }> => {
    if (decidingRef.current.has(id)) return { sent: false, reason: 'already-decided' };
    const pending = asksRef.current.find(a => a.ask.id === id);
    if (!pending) return { sent: false, reason: historyRef.current.some(e => e.ask.id === id && isSent(e)) ? 'already-decided' : 'not-found' };
    const ask = pending.ask;
    const nowS0 = Math.floor(now() / 1000);
    // A37: an expired ask is never answered — it just leaves the list.
    if (ask.expiresAt <= nowS0) {
      commitAsks(asksRef.current.filter(a => a.ask.id !== id));
      return { sent: false, reason: 'expired' };
    }
    const replied = repliedRef.current.get(id);
    if (replied) { markAnswered(id, replied); return { sent: false, reason: 'already-decided' }; }
    const o = optsRef.current;
    const key = o.encryptionKey;
    if (!key) return { sent: false, reason: 'locked' };
    const c = directChildren(o.dependants, o.relays).find(x => x.id === pending.dependantId);
    if (!c) return { sent: false, reason: 'not-found' };
    const dep = c.dep;
    const stored = unsentRef.current.get(id);
    // A34: once chosen, only the SAME verdict can be sent again.
    if (stored && (stored.chosen ?? stored.verdict.verdict) !== verdict) return { sent: false, reason: 'already-decided' };
    if (!stored && verdict === 'always' && dep.autonomyStage === 'full-control') return { sent: false, reason: 'always-unavailable' };
    // D5: a standing app permission is one decision per request — never "Always", at any stage.
    if (verdict === 'always' && ask.scope === 'app-permission') return { sent: false, reason: 'always-app-permission' };
    decidingRef.current.add(id);
    try {
      const nowMs = now();
      const nowS = Math.floor(nowMs / 1000);
      let entry: ChildAskHistoryEntry;
      if (stored) {
        entry = stored;
      } else {
        // A34: the choice is saved before anything else happens.
        entry = {
          ask: slim(ask), chosen: verdict, sent: false,
          verdict: { v: 1, id, verdict, decidedAt: nowS, ...(verdict === 'deny' && dopts?.alwaysDeny ? { alwaysDeny: true } : {}) },
        };
        if (!(await recordHistory(entry))) {
          historyRef.current = historyRef.current.filter(e => e.ask.id !== id);
          if (mountedRef.current) setHistory(historyRef.current);
          return { sent: false, reason: 'save-failed' };
        }
        unsentRef.current.set(id, entry);
        markUnsent(id, verdict);
      }

      // A47: "Send again" of a once/always that was converted to deny re-attempts the ORIGINAL choice;
      // only a second failure converts it again.
      const original = stored && (entry.chosen ?? entry.verdict.verdict) !== 'deny' && entry.verdict.verdict === 'deny';
      let out: ChildSignVerdict = original
        ? { v: 1, id, verdict: entry.chosen as ChildVerdictChoice, decidedAt: entry.verdict.decidedAt }
        : withoutAlsoOpened(entry.verdict); // reported again only by THIS attempt's successful push
      let reason: ChildAskDecideReason | undefined = original ? undefined : entry.reason;
      let onceAdded: OnceEntry[] | undefined;
      const refuse = (r: ChildAskDecideReason, wire?: ChildSignVerdict['reason']) => {
        reason = r;
        out = { v: 1, id, verdict: 'deny', decidedAt: entry.verdict.decidedAt, ...(wire ? { reason: wire } : {}) };
      };
      const scope = ask.scope ?? `kind:${ask.kind}`;
      const signs = ask.method === 'sign_event';

      if (out.verdict === 'deny') {
        if (out.alwaysDeny && !out.ruleId) {
          const rule: ChildRule = {
            id: childRuleId(c.id, ask.persona, scope, ask.target), dependantId: c.id, persona: ask.persona, scope, target: ask.target,
            decision: 'deny', label: ask.targetLabel, createdAt: nowMs, updatedAt: nowMs,
          };
          try { await saveChildRule(rule, key); o.onRulesChanged(); out = { ...out, ruleId: rule.id }; } catch {
            const { alwaysDeny: _a, ...plain } = out; void _a; out = plain; // a plain deny still goes
          }
        }
      } else {
        let rules: ChildRule[];
        try { rules = await listChildRules(c.id, key); } catch { return { sent: false, reason: 'publish-failed' }; }
        const onceFor = Object.entries(o.approvedOnceKinds ?? {}).filter(([k]) => k.toLowerCase() === c.id).flatMap(([, v]) => v);
        if (signs && dep.defaultSchedule?.paused === true) {
          refuse('paused');
        } else if (out.verdict === 'always') {
          const rule: ChildRule = {
            id: childRuleId(c.id, ask.persona, scope, ask.target), dependantId: c.id, persona: ask.persona, scope, target: ask.target,
            decision: 'allow', label: ask.targetLabel, createdAt: nowMs, updatedAt: nowMs,
          };
          // M6: on a marked sign-in the standing rule stays sign-in / 21236;
          // THIS answer's seal gets one approved-once entry (the Allow-once
          // window), pushed with the rule — both or neither — so the child
          // mints its seal pass for this one answer. Later sign-ins under the
          // rule have no verdict, so no pass.
          const sealOnce: OnceEntry | undefined = signs && sealsOwnAnswer(ask)
            ? { kind: SEAL_KIND, until: nowS + CHILD_ASK_ONCE_WINDOW_S } : undefined;
          const current = signs ? ceilingFor(dep, rules, onceFor, nowS) : 'all';
          // A5: the 64-kind ceiling must be able to hold it (and the seal entry).
          if (signs && !fits(current,
            ceilingFor(dep, [...rules.filter(r => r.id !== rule.id), rule], sealOnce ? [...onceFor, sealOnce] : onceFor, nowS),
            sealOnce ? [ask.kind, SEAL_KIND] : [ask.kind])) {
            refuse('ceiling-full');
          } else {
            try { await saveChildRule(rule, key); } catch { return { sent: false, reason: 'publish-failed' }; }
            o.onRulesChanged();
            out = { ...out, ruleId: rule.id };
            // A33: always push; the device no-ops when it already matches.
            if (signs && (await (sealOnce ? o.pushCeiling(c.id, sealOnce) : o.pushCeiling(c.id))) !== 'ok') {
              refuse('device-unreachable', 'device-unreachable');
            } else if (sealOnce) {
              onceAdded = [sealOnce];
              out = { ...out, alsoOpened: [SEAL_KIND] };
            }
          }
        } else if (signs) {
          // once. D5: My Signet's own answer to an app permission (the ask
          // carries a valid claim) is sealed (kind 13) by the same persona,
          // so its window opens for the seal too — same `until`, both in one
          // push or neither. The child's seal pass binds that seal to this
          // one answer. A claimless 30420 (an outside app) has no such
          // answer: only its own kind. Part B: so is My Signet's own
          // relay-mode sign-in (a marked 21236 ask); an unmarked one opens
          // only its own kind, as before.
          const until = nowS + CHILD_ASK_ONCE_WINDOW_S;
          const es: OnceEntry[] = sealsOwnAnswer(ask)
            ? [{ kind: ask.kind, until }, { kind: SEAL_KIND, until }]
            : [{ kind: ask.kind, until }];
          const current = ceilingFor(dep, rules, onceFor, nowS);
          if (!fits(current, ceilingFor(dep, rules, [...onceFor, ...es], nowS), es.map(e => e.kind))) refuse('ceiling-full');
          // A33: always push; the pusher adds the entries and removes them all again if the push fails.
          else if ((await o.pushCeiling(c.id, es.length === 1 ? es[0] : es)) !== 'ok') refuse('device-unreachable', 'device-unreachable');
          else {
            onceAdded = es;
            // Part B: the verdict says the seal was opened too — the child
            // mints its seal pass only on this (an older guardian never says it).
            const also = es.filter(e => e.kind !== ask.kind).map(e => e.kind);
            if (also.length > 0) out = { ...out, alsoOpened: also };
          }
        }
      }

      entry = { ...entry, verdict: out, sent: false, ...(reason ? { reason } : {}) };
      unsentRef.current.set(id, entry);
      await recordHistory(entry);

      const giveBackOnce = async () => {
        if (onceAdded && o.dropOnce) {
          try { await o.dropOnce(c.id, onceAdded.length === 1 ? onceAdded[0] : onceAdded); } catch { /* expires on its own */ }
        }
      };
      // A35: another guardian device answered while we were working — never a second answer.
      const repliedNow = repliedRef.current.get(id);
      if (repliedNow) { await giveBackOnce(); markAnswered(id, repliedNow); return { sent: false, reason: 'already-decided' }; }

      let ok = false;
      try {
        const ev = await buildVerdictEvent(out, c.railPriv, c.client);
        ok = (await transport().publish(ev, c.relays)).ok;
      } catch { ok = false; }
      if (!ok) {
        await giveBackOnce();
        return { sent: false, reason: 'publish-failed' };
      }
      unsentRef.current.delete(id);
      commitAsks(asksRef.current.filter(a => a.ask.id !== id));
      await recordHistory({ ...entry, sent: true });
      return { sent: true, ...(reason ? { reason } : {}) };
    } finally {
      decidingRef.current.delete(id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitAsks]);

  return { asks, decide, history };
}
