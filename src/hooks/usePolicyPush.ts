/**
 * C3 policy push (family-bunker §11.1.4/9): whenever the family state that
 * feeds the compiler changes — dependants (stage, default schedule, audit
 * visibility, petition opt-in, personas), remembered grants (incl.
 * tombstones), or the operator client itself becoming available — debounce
 * 1.5 s and run one push (`lib/policy-push.ts` `runPolicyPush`): list the
 * device's client slots, compile every family slot's policy, send
 * `update_client` for each slot that differs. Runs are serialised; a change
 * landing mid-run queues exactly one follow-up.
 *
 * `guardianClientPubkey` — the app's own NIP-46 client pubkey, i.e. how the
 * compiler recognises the guardian's OWN slot in `list_clients` — is
 * derived HERE from the stored `bunkerSecret` (loaded with the unlock key,
 * bytes zeroized after `getPublicKey`), so the secret never threads through
 * App state. Null in any non-bunker signing mode.
 *
 * Never throws out of an effect: every failure lands in `lastResult.errors`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { DependantIdentity } from '../types';
import type { RememberedGrant } from '../types/grants';
import type { ChildRule } from '../types/child-rules';
import { listPendingChildRevokes, loadBunkerSecret, removePendingChildRevoke } from '../lib/db';
import { HeartwoodMgmtClient, listClients, revokeClient, updateClientPolicy } from '../lib/heartwood-mgmt';
import { retryPendingChildRevokes } from '../lib/child-device-pairing';
import { runPolicyPushLocked, type PolicyPushIo, type PolicyPushResult } from '../lib/policy-push';

export const POLICY_PUSH_DEBOUNCE_MS = 1_500;
/** setTimeout's ceiling (~24.8 days); a later expiry re-arms on the next input change. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * A21: the earliest future moment (unix ms) the child-direct ceiling changes on
 * its own — an approved-once `until` (unix seconds) or a live ChildRule's
 * `expiresAt` (ms). Null when nothing is due.
 */
export function earliestChildExpiryMs(
  approvedOnceKinds: Record<string, { kind: number; until: number }[]> | undefined,
  childRules: ChildRule[] | null | undefined,
  nowMs: number,
): number | null {
  let earliest = Infinity;
  for (const list of Object.values(approvedOnceKinds ?? {})) {
    for (const a of list) { const ms = a.until * 1000; if (ms > nowMs && ms < earliest) earliest = ms; }
  }
  for (const r of childRules ?? []) {
    if (typeof r.tombstonedAt === 'number' && r.tombstonedAt > 0) continue;
    if (typeof r.expiresAt === 'number' && r.expiresAt > nowMs && r.expiresAt < earliest) earliest = r.expiresAt;
  }
  return Number.isFinite(earliest) ? earliest : null;
}

export interface UsePolicyPushArgs {
  client: HeartwoodMgmtClient | null;
  /** Bunker mode + unlocked + not paired-child. */
  enabled: boolean;
  encryptionKey: string | null;
  signingMode: string | undefined;
  dependants: DependantIdentity[];
  /** Live grants INCLUDING tombstones (`grantsForSync`); null while loading. */
  grants: RememberedGrant[] | null;
  /** Child-direct rules, all dependants, INCLUDING tombstones; null/absent ⇒ none yet. */
  childRules?: ChildRule[] | null;
  /** Approved-once kinds per dependant id (`until` unix seconds); a push re-runs at the earliest expiry. Null while loading (A38: nothing is pushed). */
  approvedOnceKinds?: Record<string, { kind: number; until: number }[]> | null;
  /** A31: the CURRENT approved-once state (a ref read), taken inside the operator lock; null while loading. */
  getApprovedOnce?: () => Record<string, { kind: number; until: number }[]> | null;
  /** A31: a fresh read of every child rule (incl. tombstones), taken inside the operator lock. */
  loadChildRules?: () => Promise<ChildRule[]>;
}

export interface UsePolicyPushReturn {
  lastPushAt: number | null;
  lastResult: PolicyPushResult | null;
  pushing: boolean;
  /** Skip the debounce and run now (also runs on the next tick if a run is in flight). */
  pushNow: () => void;
  guardianClientPubkey: string | null;
}

export function usePolicyPush({ client, enabled, encryptionKey, signingMode, dependants, grants, childRules, approvedOnceKinds, getApprovedOnce, loadChildRules }: UsePolicyPushArgs): UsePolicyPushReturn {
  const [lastPushAt, setLastPushAt] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<PolicyPushResult | null>(null);
  const [pushing, setPushing] = useState(false);
  const [guardianClientPubkey, setGuardianClientPubkey] = useState<string | null>(null);

  // Guardian client pubkey — bunker mode only.
  useEffect(() => {
    if (!enabled || !encryptionKey || signingMode !== 'bunker') {
      setGuardianClientPubkey(null);
      return;
    }
    let cancelled = false;
    loadBunkerSecret(encryptionKey)
      .then((secret) => {
        if (cancelled) return;
        if (!secret || !/^[0-9a-f]{64}$/i.test(secret)) { setGuardianClientPubkey(null); return; }
        const bytes = hexToBytes(secret.toLowerCase());
        try {
          setGuardianClientPubkey(getPublicKey(bytes));
        } catch {
          setGuardianClientPubkey(null);
        } finally {
          bytes.fill(0);
        }
      })
      .catch(() => { if (!cancelled) setGuardianClientPubkey(null); });
    return () => { cancelled = true; };
  }, [enabled, encryptionKey, signingMode]);

  // Latest inputs in refs so the debounced runner reads fresh values
  // without re-arming on every render.
  const inputsRef = useRef({ client, dependants, grants, guardianClientPubkey, childRules, approvedOnceKinds, encryptionKey, getApprovedOnce, loadChildRules });
  inputsRef.current = { client, dependants, grants, guardianClientPubkey, childRules, approvedOnceKinds, encryptionKey, getApprovedOnce, loadChildRules };

  const runningRef = useRef(false);
  const queuedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    // Re-arm on every mount: React StrictMode (dev) mounts → cleans up →
    // mounts again, so a cleanup-only effect would leave this false forever
    // and silently drop every setState after the first run.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const runOnce = useCallback(async () => {
    if (runningRef.current) { queuedRef.current = true; return; }
    const { client: c, encryptionKey: key } = inputsRef.current;
    // Rules / approved-once still loading: a child-direct ceiling compiled without them would narrow, then widen.
    if (!c || !c.isOpen || inputsRef.current.grants === null || inputsRef.current.childRules === null || inputsRef.current.approvedOnceKinds === null) return;
    runningRef.current = true;
    if (mountedRef.current) setPushing(true);
    const io: PolicyPushIo = {
      listClients: () => listClients(c),
      updateClientPolicy: (slot, policy) => updateClientPolicy(c, slot, policy),
    };
    try {
      // A31: pending revokes, then list → compile → update_client, all under
      // the operator lock, compiling from reads taken inside it.
      const result = await runPolicyPushLocked({
        lockKey: c,
        io,
        // A24: child-direct slots whose removal-time revoke did not land.
        before: key ? () => retryPendingChildRevokes({
          list: () => listPendingChildRevokes(key),
          revoke: (r) => revokeClient(c, { slotIndex: r.slotIndex, secretFingerprint: r.secretFingerprint }),
          remove: (r) => removePendingChildRevoke(r, key),
          listClients: () => listClients(c),
        }) : undefined,
        read: async () => {
          const cur = inputsRef.current;
          const once = cur.getApprovedOnce ? cur.getApprovedOnce() : cur.approvedOnceKinds;
          const rules = cur.loadChildRules ? await cur.loadChildRules() : cur.childRules;
          if (cur.grants === null || rules === null || once === null) return null;
          return {
            dependants: cur.dependants,
            grants: cur.grants,
            guardianClientPubkey: cur.guardianClientPubkey,
            nowSeconds: Math.floor(Date.now() / 1000),
            childRules: rules ?? [],
            approvedOnceKinds: once ?? {},
          };
        },
      });
      if (result === null) return;
      if (mountedRef.current) {
        setLastResult(result);
        setLastPushAt(Date.now());
      }
    } catch (e) {
      // runPolicyPush never throws by contract; belt-and-braces so the
      // effect can't leak a rejection.
      if (mountedRef.current) {
        setLastResult({ pushed: 0, unchanged: 0, untouched: 0, warnings: [], errors: [e instanceof Error ? e.message : String(e)] });
        setLastPushAt(Date.now());
      }
    } finally {
      runningRef.current = false;
      if (mountedRef.current) setPushing(false);
      if (queuedRef.current) {
        queuedRef.current = false;
        // A change landed mid-run — one follow-up, not a storm.
        void Promise.resolve().then(runOnce);
      }
    }
  }, []);

  const schedule = useCallback((delayMs: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void runOnce();
    }, delayMs);
  }, [runOnce]);

  // Debounced trigger on any input change (client becoming available included).
  useEffect(() => {
    if (!enabled || !client || grants === null || childRules === null || approvedOnceKinds === null) {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      return;
    }
    schedule(POLICY_PUSH_DEBOUNCE_MS);
  }, [enabled, client, dependants, grants, guardianClientPubkey, childRules, approvedOnceKinds, schedule]);

  // Spec §6 / A21: an approved-once kind leaves the ceiling when its window
  // ends, and an expiring child rule narrows it — recompile just after the
  // earliest of the two.
  useEffect(() => {
    if (!enabled || !client || grants === null) return;
    const at = earliestChildExpiryMs(approvedOnceKinds ?? undefined, childRules, Date.now());
    if (at === null) return;
    const id = setTimeout(() => schedule(0), Math.min(at - Date.now() + 1_000, MAX_TIMER_MS));
    return () => clearTimeout(id);
  }, [enabled, client, grants, approvedOnceKinds, childRules, schedule]);

  // Drop stale results when the client goes away (lock / forget).
  useEffect(() => {
    if (!client) { setLastResult(null); setLastPushAt(null); setPushing(false); }
  }, [client]);

  const pushNow = useCallback(() => {
    if (!enabled || !inputsRef.current.client) return;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    void runOnce();
  }, [enabled, runOnce]);

  return useMemo(() => ({ lastPushAt, lastResult, pushing, pushNow, guardianClientPubkey }), [lastPushAt, lastResult, pushing, pushNow, guardianClientPubkey]);
}
