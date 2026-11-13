/**
 * App glue for `lib/signer-relay-recovery.ts`: find the Heartwood on other
 * relays when the owner-mode signer link goes deaf, with no tap.
 *
 * The trigger means "THIS unlock's reconnect failed". Three things keep a
 * stale `'unavailable'` (from before a lock, or from a superseded attempt)
 * from starting a recovery:
 *   - a generation bumped on every lock and unlock; a recovery belongs to one
 *     generation, and a status only counts if it CHANGED during the current
 *     one (the status can be left over from before the lock);
 *   - a live status ref, re-checked inside the recovery right before the
 *     write and again before the retry;
 *   - a lock aborts the run (probes closed, no write) and resets the
 *     once-per-unlock flag.
 *
 * Runs once per unlock. The banner's Retry re-arms it (`onManualRetry`), but
 * never while a run is going.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  recoverSignerLink, newRecoveryGuard,
  type RecoveryGuard, type OperatorChannel,
} from '../lib/signer-relay-recovery';
import { createBunkerProbe } from '../lib/signer-relay-probe';
import { getPreferencesWithRawBunkerUri, loadBunkerSecret, swapBunkerUriIfUnchanged } from '../lib/db';
import { encryptSecret } from '../lib/crypto-store';
import { defaultRelays } from '../lib/relay-service';
import { getStatus as mgmtGetStatus, getNetworkConfig as mgmtGetNetworkConfig, type HeartwoodMgmtClient } from '../lib/heartwood-mgmt';

export type SignerStatus = 'connected' | 'connecting' | 'unavailable' | null;

/** The slice of `useHeartwoodOperator` the recovery reads. */
export interface RecoveryOperatorState {
  loading: boolean;
  credential: { deviceHex: string; relays: string[] } | null;
  client: HeartwoodMgmtClient | null;
}

export interface UseSignerLinkRecoveryArgs {
  signerStatus: SignerStatus;
  signingMode: string | undefined;
  encryptionKey: string | null;
  operator: RecoveryOperatorState;
  reloadPreferences: (key?: string) => Promise<void>;
  /** The existing reconnect (`handleRetryConnect`, via its ref). */
  retryConnect: () => Promise<void>;
}

export interface UseSignerLinkRecoveryReturn {
  /** True while a recovery is running (banner copy; Retry is disabled). */
  searching: boolean;
  /** The banner's Retry: re-arms the recovery, then reconnects. Ignored while
   *  a recovery is running. */
  onManualRetry: () => void;
}

export const OPERATOR_WAIT_MS = 10_000;
const OPERATOR_POLL_MS = 250;
const OPERATOR_READ_TIMEOUT_MS = 8_000;

/** Wait up to `OPERATOR_WAIT_MS` for the operator client to come up; never
 *  longer. Stops (and clears its timer) the moment `signal` aborts. */
function waitForOperator(
  signal: AbortSignal,
  read: () => RecoveryOperatorState,
): Promise<OperatorChannel | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (v: OperatorChannel | null) => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(v);
    };
    const onAbort = () => finish(null);
    const poll = () => {
      timer = undefined;
      const op = read();
      if (!op.loading && !op.credential) return finish(null);
      if (op.client && op.credential) {
        const client = op.client;
        return finish({
          deviceHex: op.credential.deviceHex,
          credentialRelays: op.credential.relays,
          getStatus: () => mgmtGetStatus(client, { timeoutMs: OPERATOR_READ_TIMEOUT_MS }),
          getNetworkConfig: () => mgmtGetNetworkConfig(client, { timeoutMs: OPERATOR_READ_TIMEOUT_MS }),
        });
      }
      if (Date.now() - started >= OPERATOR_WAIT_MS) return finish(null);
      timer = setTimeout(poll, OPERATOR_POLL_MS);
    };
    if (signal.aborted) return finish(null);
    signal.addEventListener('abort', onAbort, { once: true });
    poll();
  });
}

export function useSignerLinkRecovery(args: UseSignerLinkRecoveryArgs): UseSignerLinkRecoveryReturn {
  const { signerStatus, signingMode, encryptionKey } = args;
  const [searching, setSearching] = useState(false);

  // Live values for the long-running recovery (re-read, never captured).
  const statusRef = useRef(signerStatus);
  statusRef.current = signerStatus;
  const keyRef = useRef(encryptionKey);
  keyRef.current = encryptionKey;
  const operatorRef = useRef(args.operator);
  operatorRef.current = args.operator;
  const reloadRef = useRef(args.reloadPreferences);
  reloadRef.current = args.reloadPreferences;
  const retryRef = useRef(args.retryConnect);
  retryRef.current = args.retryConnect;

  const guardRef = useRef<RecoveryGuard>(newRecoveryGuard());
  const abortRef = useRef<AbortController | null>(null);
  const genRef = useRef(0);
  // The generation in which `signerStatus` last CHANGED. A status that did not
  // change since the current unlock began is a leftover, never a trigger.
  const statusGenRef = useRef(-1);

  // Every lock and unlock starts a new generation; a lock also aborts any run
  // in flight (probes closed, no write) and forgets the once-per-unlock flag.
  useEffect(() => {
    genRef.current++;
    if (encryptionKey) return;
    abortRef.current?.abort();
    abortRef.current = null;
    guardRef.current = newRecoveryGuard();
  }, [encryptionKey]);

  useEffect(() => { statusGenRef.current = genRef.current; }, [signerStatus]);

  // Unmount: stop the operator wait and any recovery (no write, no retry).
  useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => {
    if (signerStatus !== 'unavailable') return;
    if (signingMode !== 'bunker') return;
    if (!encryptionKey) return;
    if (statusGenRef.current !== genRef.current) return;
    if (!abortRef.current || abortRef.current.signal.aborted) abortRef.current = new AbortController();
    const key = encryptionKey;
    void recoverSignerLink({
      signingMode,
      getSignerStatus: () => statusRef.current,
      startKey: key,
      currentKey: () => keyRef.current,
      unlockGeneration: () => genRef.current,
      signal: abortRef.current.signal,
      loadPreferences: () => getPreferencesWithRawBunkerUri(key),
      loadClientSecret: () => loadBunkerSecret(key),
      getOperator: (signal) => waitForOperator(signal, () => operatorRef.current),
      defaultRelays: () => defaultRelays().map(r => r.url),
      probeOne: createBunkerProbe,
      encryptUri: (uri, k) => encryptSecret(uri, k),
      swapBunkerUri: swapBunkerUriIfUnchanged,
      reloadPreferences: (k) => reloadRef.current(k),
      retry: () => retryRef.current(),
      onRunning: setSearching,
    }, guardRef.current);
  }, [signerStatus, signingMode, encryptionKey]);

  const onManualRetry = useCallback(() => {
    if (guardRef.current.running) return;
    guardRef.current.done = false;
    void retryRef.current();
  }, []);

  return { searching, onManualRetry };
}
