/**
 * Child side of a child-direct Heartwood pairing, after the handshake
 * (spec §4 step 6, §5.2; amendment A18).
 *
 *   rules     the guardian → child rules payload. The encrypted cache is read
 *             first, then the rules rail on the rail relay (authored by the
 *             rail key, `#p` = our client key). The newest `updatedAt` wins;
 *             an older event is ignored. No cache and no live payload ⇒ null,
 *             which the gate treats as "ask for everything" (fail closed).
 *   personas  the identity-approvals ceremony (the child half of the ready
 *             check, `child-ready-check.ts`): for every persona this phone may
 *             use, the BOUND persona first, `nip44_encrypt` AS that persona
 *             (to itself, a fixed plaintext) so the Heartwood asks REMEMBER AS
 *             once, at setup. The bound persona needs it too: the firmware's
 *             per-client consent gives a fresh slot no approval, not even for
 *             its binding, so it is shown as waiting until its probe returns.
 *             Runs one at a time, once per persona that has no recorded
 *             state, after the router is up — and again when a new persona
 *             appears (one added after pairing). A device that withdraws the
 *             card because a slot changed (`approval_changed`) is asked again,
 *             at most twice. A failed or timed-out persona waits for
 *             `retryApproval` / `finishNow`; it is never "approved".
 *             "Later" (`deferApproval`): a persona may be put off. The choice is
 *             stored on the paired-child record (`identityApprovals`, so it
 *             survives a restart) and the ceremony counts as finished once every
 *             persona is approved or deferred. A deferred persona is approved
 *             on first use: `ensureApproved(persona)` runs the same single
 *             self-probe (ALLOW AS on the Heartwood) before the request is
 *             routed, and the request proceeds only if it succeeds. "Approve
 *             now" is `retryApproval`.
 *
 *   unpaired  (spec §9.4, Review Focus 5) set by the guardian's
 *             `signet:child-unpaired:v1` notice (authored by the rail key,
 *             `p` = our client key, on the rail relay) or by the Heartwood
 *             answering "unauthorised" to UNPAIRED_STRIKES forwarded requests
 *             in a row ON THE BOUND PERSONA'S PRIMARY CONNECTION (A51: another
 *             persona's route says "unauthorised" after a persona revoke or
 *             ceiling drift while the slot is live; the firmware also says it
 *             for a single out-of-policy request, so one refusal is not
 *             enough). Clears the rules cache; the gate rejects every held ask.
 *
 * A51: the rules payload's `personas` (when present) limits which personas
 * the ceremony runs for; the bound persona is always kept.
 *
 * The guardian is the source of truth: when the newest rules payload carries
 * `approved` (the guardian's reading of the device for this phone's key), a
 * persona is approved only when listed there, "full" when absent and the slot
 * holds as many as the Heartwood can remember, and owed otherwise, whatever
 * this phone saved (a restored or cleared Heartwood shows as "Not ready" here,
 * with "Finish now"). A probe of this phone's that succeeded under that same
 * payload counts too (the press came after the guardian's reading). Without
 * `approved`, this phone's own probe answers stand.
 *
 * Paused (`defaultSchedule.paused`): the slot refuses everything, so no probe
 * is sent and nothing is owed; probes resume `UNPAUSE_SETTLE_MS` after the
 * pause ends (the guardian's policy push lags the rules payload).
 *
 * A legacy phone pairing (`mode` absent / 'phone') does nothing here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NostrEvent, NostrFilter } from 'signet-protocol';
import type { PairedChildRecord } from '../types';
import type { BunkerBackendRouter } from '../lib/bunker-router';
import { CHILD_RULES_WIRE_D_TAG, newerRulesPayload, openChildRulesEvent, type ChildRulesPayload } from '../lib/child-rules-wire';
import { CHILD_UNPAIRED_D_TAG, isUnpairedNotice } from '../lib/child-activity';
import { clearChildRulesCache, loadChildRulesCache, saveChildRulesCache } from '../lib/db';
import { observeStampedCalls } from '../lib/signing-backend';
import { childAllowedPersonas } from '../lib/child-bunker';
import { subscribeEvents } from '../lib/relay-service';
import {
  childEffectiveApproval, childReadyRows, isApprovalChanged, owedPresses, readySummary,
  type ChildEffectiveApproval, type ReadyRow, type ReadySummary,
} from '../lib/child-ready-check';

export const APPROVE_IDENTITY_PLAINTEXT = 'signet:approve-identity:v1';
/** Extra sends when the device withdrew a waiting card (`approval_changed`). */
export const APPROVAL_CHANGED_RETRIES = 2;
/** After a pause ends, before any probe: the guardian's policy push follows the rules payload. */
export const UNPAUSE_SETTLE_MS = 5_000;

type Approval = 'approved' | 'waiting' | 'failed' | 'deferred';

export interface ChildLinkTransport {
  subscribe(filters: NostrFilter[], relays: string[], onEvent: (ev: NostrEvent) => void): () => void;
}
const defaultTransport: ChildLinkTransport = {
  subscribe: (filters, relays, onEvent) => subscribeEvents(filters, relays, onEvent),
};

export interface UseChildDeviceLinkOpts {
  record: PairedChildRecord | null;
  encryptionKey: string | null;
  router: BunkerBackendRouter | null;
  onRecordUpdated(r: PairedChildRecord): Promise<void>;
  /** Non-dormant personas from the persona inventory (bound persona included or not). */
  inventoryPersonas?: { pubkey: string; name: string }[];
  /** A26: slots never addressed on this install (the dormant real identity). */
  withheldSlots?: string[];
  transport?: ChildLinkTransport;
}

export interface ChildDeviceLink {
  rules: ChildRulesPayload | null;
  /** Each persona's state as shown (the guardian's reading wins over this phone's saved answer). */
  personas: { pubkey: string; name: string; approval: ChildEffectiveApproval }[];
  /** Also "Approve now" for a deferred persona. */
  retryApproval(persona: string): Promise<void>;
  /** Put a pending persona off ("Later"); it is approved when first needed. */
  deferApproval(persona: string): void;
  /**
   * Resolves true when `persona` may be routed to the Heartwood: it is not
   * deferred, or its approval probe just succeeded. Awaits a probe already in
   * flight for that persona. Never skips `childGate`; callers run it first.
   */
  ensureApproved(persona: string): Promise<boolean>;
  /** Every persona is approved or deferred. */
  ceremonyFinished: boolean;
  /** The checklist: one row per persona (bound first), waiting / ready / skipped. */
  rows: ReadyRow[];
  /** Presses still owed: every persona waiting, failed or put off (0 while paused). */
  owed: number;
  /** Which notice to show (`readySummary`). */
  summary: ReadySummary;
  /** The guardian paused this child: no probe goes out. */
  paused: boolean;
  /** A probe is waiting on the Heartwood now. */
  probing: boolean;
  /** A probe succeeded in this session and everything is confirmed now ("Ready to use away from home"). */
  readyThisSession: boolean;
  /** "Finish now": ask again for every owed persona (A43: candidates only), one at a time. */
  finishNow(): Promise<void>;
  /** Set by the unpaired signal (Task 12). */
  unpaired: boolean;
}

const HEX64 = /^[0-9a-f]{64}$/;
/** Consecutive "unauthorised" answers to forwarded requests that mean the slot is gone. */
export const UNPAIRED_STRIKES = 3;

function isUnauthorised(err: unknown): boolean {
  const m = typeof err === 'string' ? err : err instanceof Error ? err.message : '';
  const t = m.trim().toLowerCase();
  return t === 'unauthorised' || t === 'unauthorized';
}

export function useChildDeviceLink(opts: UseChildDeviceLinkOpts): ChildDeviceLink {
  const { encryptionKey, router, onRecordUpdated } = opts;
  const transport = opts.transport ?? defaultTransport;
  const direct = opts.record?.mode === 'heartwood-direct' ? opts.record : null;
  const depId = direct?.dependantPubkey ?? null;
  const clientPub = direct?.clientKeypair.publicKey ?? null;
  const clientPriv = direct?.clientKeypair.privateKey ?? null;
  const railPub = direct?.railPubkey ?? null;
  const railRelay = direct?.railRelay ?? null;
  const bound = direct?.personaPubkey ?? null;

  const recordRef = useRef(direct);
  recordRef.current = direct;
  const onUpdatedRef = useRef(onRecordUpdated);
  onUpdatedRef.current = onRecordUpdated;
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const routerRef = useRef(router);
  routerRef.current = router;

  // ── Rules ────────────────────────────────────────────────────────────────
  const [rules, setRules] = useState<ChildRulesPayload | null>(null);
  const rulesRef = useRef<ChildRulesPayload | null>(null);

  // ── Unpaired (§9.4) ──────────────────────────────────────────────────────
  const [unpaired, setUnpaired] = useState(false);
  const unpairedRef = useRef(false);
  const markUnpaired = useCallback(() => {
    if (unpairedRef.current) return;
    unpairedRef.current = true;
    setUnpaired(true);
    rulesRef.current = null;
    setRules(null);
    const id = recordRef.current?.dependantPubkey;
    if (id) void clearChildRulesCache(id).catch(() => { /* best effort */ });
  }, []);
  useEffect(() => {
    unpairedRef.current = false;
    setUnpaired(false);
    if (!clientPub || !bound) return;
    let strikes = 0;
    let confirming = false;
    let cancelled = false;
    const unobserve = observeStampedCalls((r) => {
      if (r.persona !== bound) return; // A51: only the bound primary connection
      if (r.ok) { strikes = 0; return; }
      if (!isUnauthorised(r.error)) return;
      if (++strikes < UNPAIRED_STRIKES || confirming) return;
      // A62: three refusals are only a suspicion. Confirm on the primary
      // (bound persona) connection; only an unauthorised answer there means
      // the slot is gone. Any other outcome (answer, timeout, no router,
      // network) resets the count.
      const rt = routerRef.current;
      if (!rt || rt.primaryClientPubkeyHex !== clientPub) { strikes = 0; return; }
      confirming = true;
      void rt.primary.request('get_public_key', [], 15_000).then(
        () => { strikes = 0; },
        (err) => {
          if (!cancelled && isUnauthorised(err)) markUnpaired();
          else strikes = 0;
        },
      ).finally(() => { confirming = false; });
    });
    return () => { cancelled = true; unobserve(); };
  }, [depId, clientPub, bound, markUnpaired]);

  // A51: the ceremony waits for the cached payload, whose `personas` may exclude one.
  const [cacheRead, setCacheRead] = useState(false);
  useEffect(() => {
    rulesRef.current = null;
    setRules(null);
    setCacheRead(false);
    if (!depId || !clientPub || !clientPriv || !railPub || !railRelay || !encryptionKey) return;
    let cancelled = false;
    const apply = (incoming: ChildRulesPayload | null): boolean => {
      if (cancelled || !incoming || unpairedRef.current) return false;
      const next = newerRulesPayload(rulesRef.current, incoming);
      if (next === rulesRef.current) return false;
      rulesRef.current = next;
      setRules(next);
      return true;
    };
    void loadChildRulesCache(depId, encryptionKey).then(apply).catch(() => { /* no cache ⇒ fail closed */ })
      .finally(() => { if (!cancelled) setCacheRead(true); });
    const unsubscribe = transportRef.current.subscribe(
      [
        { kinds: [30078], authors: [railPub], '#d': [CHILD_RULES_WIRE_D_TAG], '#p': [clientPub] },
        { kinds: [30078], authors: [railPub], '#d': [CHILD_UNPAIRED_D_TAG], '#p': [clientPub] },
      ],
      [railRelay],
      (ev) => {
        if (cancelled) return;
        if (ev?.tags?.some?.(t => t[0] === 'd' && t[1] === CHILD_UNPAIRED_D_TAG)) {
          if (isUnpairedNotice(ev, railPub, clientPub)) markUnpaired();
          return;
        }
        void openChildRulesEvent(ev, clientPriv, { railPubkey: railPub, dependantId: depId }).then((p) => {
          if (p && apply(p) && !unpairedRef.current) void saveChildRulesCache(depId, p, encryptionKey).catch(() => { /* next event retries */ });
        });
      },
    );
    return () => { cancelled = true; unsubscribe(); };
  }, [depId, clientPub, clientPriv, railPub, railRelay, encryptionKey, markUnpaired]);

  // ── Identity approvals ceremony ──────────────────────────────────────────
  const [approvals, setApprovals] = useState<Record<string, Approval>>({});
  const approvalsRef = useRef<Record<string, Approval>>({});
  const attempted = useRef(new Set<string>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const inflight = useRef(new Map<string, Promise<boolean>>());
  const [probingNow, setProbingNow] = useState<string | null>(null);
  const [probedOk, setProbedOk] = useState(false);
  /** Per persona: the `updatedAt` of the newest rules payload when its probe last succeeded (this session). */
  const approvedUnder = useRef(new Map<string, number>());
  const recordKey = direct ? `${direct.id}:${clientPub}` : '';

  useEffect(() => {
    const initial = { ...(recordRef.current?.identityApprovals ?? {}) };
    approvalsRef.current = initial;
    setApprovals(initial);
    attempted.current = new Set();
    inflight.current = new Map();
    approvedUnder.current = new Map();
    setProbedOk(false);
  }, [recordKey]);

  // ── Pause ────────────────────────────────────────────────────────────────
  const paused = rules?.defaultSchedule?.paused === true;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  // Set in the same render the pause ends (derived state), so the ceremony
  // effect of that render already sees the hold.
  const [prevPaused, setPrevPaused] = useState(paused);
  const [resumeHold, setResumeHold] = useState(false);
  if (prevPaused !== paused) {
    setPrevPaused(paused);
    if (prevPaused && !paused) setResumeHold(true);
  }
  const resumeHoldRef = useRef(false);
  resumeHoldRef.current = resumeHold;
  useEffect(() => {
    if (!resumeHold) return;
    const t = setTimeout(() => setResumeHold(false), UNPAUSE_SETTLE_MS);
    return () => clearTimeout(t);
  }, [resumeHold]);
  const probesHeld = () => pausedRef.current || resumeHoldRef.current;

  /** One persona's state as shown, from the refs (the guardian's reading first). */
  const effectiveOf = useCallback((persona: string): ChildEffectiveApproval => {
    const r = rulesRef.current;
    return childEffectiveApproval({
      persona,
      saved: approvalsRef.current[persona],
      approved: r?.approved,
      probedUnderCurrent: !!r && approvedUnder.current.get(persona) === r.updatedAt,
    });
  }, []);

  const allowedKey = rules?.personas ? rules.personas.join(',') : '*';
  const invKey = (opts.inventoryPersonas ?? []).map(p => `${p.pubkey}:${p.name}`).join(',');
  const withheldKey = (opts.withheldSlots ?? []).map(w => w.toLowerCase()).join(',');
  const candidates = useMemo(() => {
    if (!direct) return [];
    const out = new Map<string, string>();
    for (const p of direct.personas ?? []) if (HEX64.test(p.pubkey)) out.set(p.pubkey, p.name);
    for (const p of opts.inventoryPersonas ?? []) if (HEX64.test(p.pubkey)) out.set(p.pubkey, p.name);
    if (bound && !out.has(bound)) out.set(bound, direct.dependantName);
    for (const w of withheldKey ? withheldKey.split(',') : []) if (w !== bound) out.delete(w);
    const allowed = childAllowedPersonas([...out].map(([pubkey, name]) => ({ pubkey, name })), rules, bound);
    // The bound persona first: its press comes first, then each extra in turn.
    return [...allowed.filter(p => p.pubkey === bound), ...allowed.filter(p => p.pubkey !== bound)];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content, not identity
  }, [recordKey, bound, invKey, direct?.personas, withheldKey, allowedKey]);

  const setApproval = useCallback((persona: string, state: Approval) => {
    const next = { ...approvalsRef.current, [persona]: state };
    approvalsRef.current = next;
    setApprovals(next);
    const rec = recordRef.current;
    if (rec && state !== 'waiting') void onUpdatedRef.current({ ...rec, identityApprovals: next }).catch(() => { /* re-run next start */ });
  }, []);

  /** `force` is an explicit "Approve now" / first use: it overrides a deferral. */
  const approve = useCallback((persona: string, force = false): Promise<boolean> => {
    const run = queue.current.then(async (): Promise<boolean> => {
      if (!force && approvalsRef.current[persona] === 'deferred') return false;
      const r = routerRef.current;
      const current = !!r && r.primaryClientPubkeyHex === recordRef.current?.clientKeypair.publicKey;
      const backend = current ? r.backendFor(persona) : null;
      if (!backend) { setApproval(persona, 'failed'); return false; }
      setApproval(persona, 'waiting');
      setProbingNow(persona);
      try {
        // Never published: a NIP-46 request to the Heartwood, and the answer is dropped.
        for (let attempt = 0; ; attempt++) {
          try {
            await backend.nip44Encrypt(persona, APPROVE_IDENTITY_PLAINTEXT);
            break;
          } catch (err) {
            if (attempt < APPROVAL_CHANGED_RETRIES && isApprovalChanged(err)) continue;
            throw err;
          }
        }
        approvedUnder.current.set(persona, rulesRef.current?.updatedAt ?? 0);
        setApproval(persona, 'approved');
        setProbedOk(true);
        return true;
      } catch {
        // "Later" pressed while the probe was in flight: keep the deferral.
        if (!force && approvalsRef.current[persona] === 'deferred') return false;
        setApproval(persona, 'failed');
        return false;
      } finally {
        setProbingNow(cur => (cur === persona ? null : cur));
      }
    });
    queue.current = run.then(() => {}, () => {});
    inflight.current.set(persona, run);
    void run.then(() => { if (inflight.current.get(persona) === run) inflight.current.delete(persona); });
    return run;
  }, [setApproval]);

  // A27: after a re-pair the previous router may still be up for a render or
  // two; only a router riding THIS record's client key may run the ceremony.
  const routerCurrent = !!router && !!clientPub && router.primaryClientPubkeyHex === clientPub;

  // Never while paused (the slot refuses everything) nor straight after: a
  // persona not tried yet waits, so the pause ending starts it.
  useEffect(() => {
    if (!router || !bound || !routerCurrent || !cacheRead || paused || resumeHold) return;
    for (const { pubkey } of candidates) {
      if (attempted.current.has(pubkey)) continue;
      const state = approvalsRef.current[pubkey];
      if (state === 'approved' || state === 'failed' || state === 'deferred') continue;
      // Already confirmed by the guardian's reading, or past what the Heartwood can remember.
      const shown = effectiveOf(pubkey);
      if (shown === 'approved' || shown === 'full') continue;
      attempted.current.add(pubkey);
      void approve(pubkey);
    }
  }, [router, routerCurrent, bound, candidates, approve, cacheRead, paused, resumeHold, effectiveOf, rules]);

  // A43: only a persona the ceremony itself would ask for (never a withheld
  // dormant real identity, never a pubkey this pairing does not list).
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const retryApproval = useCallback(async (persona: string) => {
    if (!HEX64.test(persona)) return;
    if (!candidatesRef.current.some(c => c.pubkey === persona)) return;
    if (probesHeld()) return;
    attempted.current.add(persona);
    await approve(persona, true);
  }, [approve]);

  const finishNow = useCallback(async () => {
    if (probesHeld()) return;
    // What is owed as shown: a saved "approved" the guardian's reading does not list is owed again.
    const owedNow = candidatesRef.current.map(c => c.pubkey).filter((pk) => {
      const shown = effectiveOf(pk);
      return shown !== 'approved' && shown !== 'full';
    });
    // A probe already running for a persona is waited for, not repeated.
    await Promise.all(owedNow.map(pk => inflight.current.get(pk) ?? retryApproval(pk)));
  }, [retryApproval, effectiveOf]);

  const deferApproval = useCallback((persona: string) => {
    if (!HEX64.test(persona)) return;
    if (!candidatesRef.current.some(c => c.pubkey === persona)) return;
    if (effectiveOf(persona) === 'approved') return;
    attempted.current.add(persona);
    setApproval(persona, 'deferred');
  }, [setApproval, effectiveOf]);

  const ensureApproved = useCallback((persona: string): Promise<boolean> => {
    const p = (persona ?? '').toLowerCase();
    const running = inflight.current.get(p);
    if (running) return running;
    if (effectiveOf(p) !== 'deferred') return Promise.resolve(true);
    // Paused: the slot refuses it anyway; no probe.
    if (probesHeld()) return Promise.resolve(false);
    attempted.current.add(p);
    return approve(p, true);
  }, [approve, effectiveOf]);

  // The bound persona is waiting like any other until its own probe returns.
  // `approvals` and `rules` are read through refs by `effectiveOf`; they say when to recompute.
  const personas = useMemo(() => candidates.map(({ pubkey, name }) => ({ pubkey, name, approval: effectiveOf(pubkey) })),
    [candidates, approvals, rules, effectiveOf]); // eslint-disable-line react-hooks/exhaustive-deps

  const ceremonyFinished = personas.every(p => p.approval === 'approved' || p.approval === 'deferred' || p.approval === 'full');
  const rows = useMemo(() => childReadyRows(personas, new Set(probingNow ? [probingNow] : [])), [personas, probingNow]);
  const summary = readySummary(rows, { paused });
  const owed = paused ? 0 : owedPresses(rows);

  return {
    rules, personas, retryApproval, deferApproval, ensureApproved, ceremonyFinished, unpaired,
    rows, owed, summary, paused, probing: probingNow !== null,
    readyThisSession: probedOk && summary.kind === 'ready', finishNow,
  };
}
