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
import { loadBunkerSecret } from '../lib/db';
import { HeartwoodMgmtClient, listClients, updateClientPolicy } from '../lib/heartwood-mgmt';
import { runPolicyPush, type PolicyPushIo, type PolicyPushResult } from '../lib/policy-push';

export const POLICY_PUSH_DEBOUNCE_MS = 1_500;

export interface UsePolicyPushArgs {
  client: HeartwoodMgmtClient | null;
  /** Bunker mode + unlocked + not paired-child. */
  enabled: boolean;
  encryptionKey: string | null;
  signingMode: string | undefined;
  dependants: DependantIdentity[];
  /** Live grants INCLUDING tombstones (`grantsForSync`); null while loading. */
  grants: RememberedGrant[] | null;
}

export interface UsePolicyPushReturn {
  lastPushAt: number | null;
  lastResult: PolicyPushResult | null;
  pushing: boolean;
  /** Skip the debounce and run now (also runs on the next tick if a run is in flight). */
  pushNow: () => void;
  guardianClientPubkey: string | null;
}

export function usePolicyPush({ client, enabled, encryptionKey, signingMode, dependants, grants }: UsePolicyPushArgs): UsePolicyPushReturn {
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
  const inputsRef = useRef({ client, dependants, grants, guardianClientPubkey });
  inputsRef.current = { client, dependants, grants, guardianClientPubkey };

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
    const { client: c, dependants: deps, grants: gs, guardianClientPubkey: gcp } = inputsRef.current;
    if (!c || !c.isOpen || gs === null) return;
    runningRef.current = true;
    if (mountedRef.current) setPushing(true);
    const io: PolicyPushIo = {
      listClients: () => listClients(c),
      updateClientPolicy: (slot, policy) => updateClientPolicy(c, slot, policy),
    };
    try {
      const result = await runPolicyPush(io, {
        dependants: deps,
        grants: gs,
        guardianClientPubkey: gcp,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
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
    if (!enabled || !client || grants === null) {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      return;
    }
    schedule(POLICY_PUSH_DEBOUNCE_MS);
  }, [enabled, client, dependants, grants, guardianClientPubkey, schedule]);

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
