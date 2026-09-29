/**
 * Guardian → child rules rail publisher (child-direct, spec §5.2). For every
 * dependant whose own phone is paired straight to the Heartwood, publish
 * `signet:child-rules:v1` (authored by the rail key, sealed to the child's
 * client key) on the rail relay whenever that dependant's rules, stage,
 * schedule or ceiling change. Debounce 1 s, no jitter (single recipient;
 * latency matters more than timing privacy here). A payload identical to the
 * last one this session published for that dependant is not re-sent.
 *
 * Never throws out of an effect.
 */
import { useEffect, useRef } from 'react';
import type { NostrEvent } from 'signet-protocol';
import type { DependantIdentity } from '../types';
import type { ChildRule } from '../types/child-rules';
import { buildChildRulesEvent, type ChildRulesPayload } from '../lib/child-rules-wire';
import { compileChildDirectPolicy } from '../lib/policy-compiler';
import { resolveAuditVisibility } from '../lib/audit-visibility';
import { publishEvent } from '../lib/relay-service';
import { isValidRelayUrl } from '../lib/relay-url';
import { earliestChildExpiryMs } from './usePolicyPush';
import { disconnectedAppsFromRules } from '../lib/child-permissions';
import { replyPersonas } from '../lib/child-device-pairing';
import { isLiveRule } from '../lib/child-rules';

export const CHILD_RULES_PUBLISH_DEBOUNCE_MS = 1_000;
const HEX64 = /^[0-9a-f]{64}$/;

export interface UseChildRulesPublisherArgs {
  enabled: boolean;
  dependants: DependantIdentity[];
  /** All child rules INCLUDING tombstones; null while loading (nothing is sent). */
  childRules: ChildRule[] | null;
  approvedOnceKinds?: Record<string, { kind: number; until: number }[]>;
  relayUrl: string;
  publish?: (ev: NostrEvent, relays: string[]) => Promise<{ ok: boolean; message: string }>;
}

/** The payload for one direct-paired dependant, without `updatedAt`. */
export function childRulesPayloadFor(
  dep: DependantIdentity,
  rules: ChildRule[],
  approvedOnce: { kind: number; until: number }[],
  nowMs: number,
): Omit<ChildRulesPayload, 'updatedAt'> | null {
  const cd = dep.childDevice;
  if (cd?.mode !== 'heartwood-direct') return null;
  const id = dep.id.toLowerCase();
  const mine = rules.filter(r => r.dependantId.toLowerCase() === id);
  const policy = compileChildDirectPolicy({
    stage: dep.autonomyStage,
    paused: dep.defaultSchedule?.paused === true,
    rules: mine,
    approvedOnceKinds: approvedOnce,
    boundPersona: cd.boundPersona,
    auditVisible: resolveAuditVisibility(dep.autonomyStage, dep.auditVisibility),
    nowSeconds: Math.floor(nowMs / 1000),
  });
  const live = mine
    .filter(r => isLiveRule(r, nowMs))
    .map(r => ({ ...r, dependantId: id }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    v: 1,
    dependantId: id,
    stage: dep.autonomyStage,
    ...(dep.defaultSchedule ? { defaultSchedule: dep.defaultSchedule } : {}),
    ceilingKinds: policy.allowedKinds,
    rules: live,
    // Blocked apps (spec §9.3): derived from the live `*`-scope app deny rules, so it syncs with the rules.
    disconnectedApps: disconnectedAppsFromRules(live, nowMs),
    // A51: the personas the phone may use — the reply's list, minus those removed from it.
    personas: replyPersonas(dep).map(p => p.pubkey),
  };
}

function hashFor(p: Omit<ChildRulesPayload, 'updatedAt'>, client: string): string {
  const rules = p.rules.map(({ lastUsedAt: _u, ...r }) => { void _u; return r; });
  return JSON.stringify([client, { ...p, rules }]);
}

export function useChildRulesPublisher({ enabled, dependants, childRules, approvedOnceKinds, relayUrl, publish }: UseChildRulesPublisherArgs): void {
  const lastRef = useRef(new Map<string, string>());
  const inputsRef = useRef({ dependants, childRules, approvedOnceKinds, relayUrl, publish });
  inputsRef.current = { dependants, childRules, approvedOnceKinds, relayUrl, publish };
  const runningRef = useRef(false);
  const queuedRef = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) lastRef.current.clear();
  }, [enabled]);

  // Stable runner reading the latest inputs through refs; a change landing
  // mid-run queues exactly one follow-up.
  const runRef = useRef<() => Promise<void>>(async () => {});
  runRef.current = async () => {
    if (runningRef.current) { queuedRef.current = true; return; }
    runningRef.current = true;
    try {
      const { dependants: deps, childRules: rules, approvedOnceKinds: once, relayUrl: relay, publish: pub } = inputsRef.current;
      if (!rules) return;
      const send = pub ?? ((ev: NostrEvent, relays: string[]) => publishEvent(ev, { relays }));
      for (const dep of deps) {
        if (!enabledRef.current) return;
        const cd = dep.childDevice;
        const ep = dep.bunkerEndpoint;
        if (cd?.mode !== 'heartwood-direct' || !ep?.privateKey || !HEX64.test(cd.clientPubkey)
          || ep.authorizedClientPubkey !== cd.clientPubkey) continue;
        const nowMs = Date.now();
        const onceFor = Object.entries(once ?? {}).filter(([k]) => k.toLowerCase() === dep.id.toLowerCase()).flatMap(([, v]) => v);
        const body = childRulesPayloadFor(dep, rules, onceFor, nowMs);
        if (!body) continue;
        const h = hashFor(body, cd.clientPubkey);
        if (lastRef.current.get(dep.id) === h) continue;
        try {
          const ev = await buildChildRulesEvent({ ...body, updatedAt: nowMs }, ep.privateKey, cd.clientPubkey, Math.floor(nowMs / 1000));
          // A25: the relay agreed at pairing; older records fall back to the guardian's relay.
          const target = cd.railRelay && isValidRelayUrl(cd.railRelay) ? cd.railRelay : relay;
          const r = await send(ev, [target]);
          if (r.ok) lastRef.current.set(dep.id, h);
        } catch { /* one dependant must not block the others; retried on the next change */ }
      }
    } finally {
      runningRef.current = false;
      if (queuedRef.current && enabledRef.current) { queuedRef.current = false; void runRef.current(); }
    }
  };

  useEffect(() => {
    if (!enabled || childRules === null) return;
    const id = setTimeout(() => { void runRef.current(); }, CHILD_RULES_PUBLISH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [enabled, dependants, childRules, approvedOnceKinds, relayUrl]);

  // A21: republish just after the earliest approved-once / rule expiry, so the
  // child's copy narrows when the guardian's does.
  useEffect(() => {
    if (!enabled || childRules === null) return;
    const at = earliestChildExpiryMs(approvedOnceKinds, childRules, Date.now());
    if (at === null) return;
    const id = setTimeout(() => { void runRef.current(); }, Math.min(at - Date.now() + 1_000, 2 ** 31 - 1));
    return () => clearTimeout(id);
  }, [enabled, childRules, approvedOnceKinds]);
}
