/**
 * Heartwood operator-key custody + the live kind-24134 management client
 * (family-bunker §11.1.4/9, C3 design §4–§5).
 *
 * Lifecycle mirrors `bunkerBackend` in App.tsx: on unlock (`enabled` +
 * `encryptionKey`) the encrypted credential is loaded from IDB
 * (`loadHeartwoodOperator`), a `HeartwoodMgmtClient` is started on the
 * credential's relays, and a best-effort `get_status` records the device's
 * capabilities. On lock the client is `stop()`ped (reply subscription
 * closed, in-flight requests rejected, operator key bytes zeroized) and
 * every piece of state is dropped — the encrypted row stays in IDB.
 *
 * `enabled` MUST be false on a paired-child install: the operator key
 * manages the FAMILY device and never belongs on the kid's phone. App.tsx
 * gates it on `signingMode !== 'paired-child'`.
 *
 * All pure logic (link/PIN/phrase resolution, feature-flag mapping) lives
 * in `lib/heartwood-operator-import.ts` / `lib/policy-push.ts` — this hook
 * only sequences storage + client lifecycle.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadHeartwoodOperator, saveHeartwoodOperator, deleteHeartwoodOperator } from '../lib/db';
import type { HeartwoodOperatorCredential } from '../lib/heartwood-operator';
import { HeartwoodMgmtClient, getStatus, type DeviceStatus } from '../lib/heartwood-mgmt';
import { resolveImportInput, resolvePhraseInput } from '../lib/heartwood-operator-import';
import { operatorFeatureFlags } from '../lib/policy-push';

export type OperatorImportOutcome =
  | { needsPin: true }
  | { imported: true }
  | { error: string };

export interface UseHeartwoodOperatorArgs {
  encryptionKey: string | null;
  /** False on the paired-child surface and while locked. */
  enabled: boolean;
}

export interface UseHeartwoodOperatorReturn {
  /** Decrypted credential (secret included — never render it). Null when none. */
  credential: HeartwoodOperatorCredential | null;
  /** Started client for the current credential, or null. */
  client: HeartwoodMgmtClient | null;
  /** Last `get_status`, or null when not (yet) fetched / failed. */
  status: DeviceStatus | null;
  statusError: string | null;
  /** True while the initial credential load is in flight. */
  loading: boolean;
  /** `null` = unverified (no/truncated status) — treat as available, surface as unverified. */
  canPush: boolean | null;
  canVerdict: boolean | null;
  /** Paste-a-link import. `{ needsPin }` when the link is PIN-protected and no PIN was given. */
  importLink: (text: string, pin?: string) => Promise<OperatorImportOutcome>;
  /** Recovery-phrase fallback: words + device npub/hex + relay URL(s). */
  importPhrase: (words: string, deviceInput: string, relaysText: string) => Promise<OperatorImportOutcome>;
  /** Delete the stored credential and stop the client. */
  forget: () => Promise<void>;
  /** Re-run `get_status` (best-effort). */
  refreshStatus: () => Promise<void>;
}

export function useHeartwoodOperator({ encryptionKey, enabled }: UseHeartwoodOperatorArgs): UseHeartwoodOperatorReturn {
  const [credential, setCredential] = useState<HeartwoodOperatorCredential | null>(null);
  const [client, setClient] = useState<HeartwoodMgmtClient | null>(null);
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // The live client, independent of render timing, so lock/forget/replace
  // can always reach the instance that actually holds the subscription.
  const clientRef = useRef<HeartwoodMgmtClient | null>(null);
  // Bumped on every lock/disable/forget so a slow load or status probe
  // from a previous session can't resurrect state after teardown.
  const genRef = useRef(0);

  const teardown = useCallback(() => {
    genRef.current++;
    const c = clientRef.current;
    clientRef.current = null;
    if (c) { try { c.stop(); } catch { /* already stopped */ } }
    setClient(null);
    setCredential(null);
    setStatus(null);
    setStatusError(null);
    setLoading(false);
  }, []);

  const probeStatus = useCallback(async (c: HeartwoodMgmtClient, gen: number) => {
    try {
      const s = await getStatus(c);
      // Ignore a late reply after lock (client is stopped so requests reject
      // anyway; the gen check covers the race between resolve and stop).
      if (genRef.current !== gen) return;
      setStatus(s);
      setStatusError(null);
    } catch (e) {
      if (genRef.current !== gen) return;
      setStatus(null);
      setStatusError(e instanceof Error ? e.message : 'status unavailable');
    }
  }, []);

  /** Start a client for `cred`, replacing any previous one. */
  const activate = useCallback((cred: HeartwoodOperatorCredential, gen: number) => {
    const prev = clientRef.current;
    if (prev) { try { prev.stop(); } catch { /* already stopped */ } }
    let c: HeartwoodMgmtClient;
    try {
      c = new HeartwoodMgmtClient({ skHex: cred.skHex, deviceHex: cred.deviceHex, relays: cred.relays });
      c.start();
    } catch (e) {
      clientRef.current = null;
      setClient(null);
      setStatusError(e instanceof Error ? e.message : 'could not start the operator channel');
      return;
    }
    clientRef.current = c;
    setClient(c);
    setStatus(null);
    setStatusError(null);
    void probeStatus(c, gen);
  }, [probeStatus]);

  // Load on unlock; tear down on lock/disable.
  useEffect(() => {
    if (!enabled || !encryptionKey) {
      teardown();
      return;
    }
    const gen = ++genRef.current;
    let cancelled = false;
    setLoading(true);
    loadHeartwoodOperator(encryptionKey)
      .then((cred) => {
        if (cancelled || genRef.current !== gen) return;
        setLoading(false);
        if (!cred) { setCredential(null); return; }
        setCredential(cred);
        activate(cred, gen);
      })
      .catch(() => {
        if (cancelled || genRef.current !== gen) return;
        setLoading(false);
        setCredential(null);
      });
    return () => { cancelled = true; };
  }, [enabled, encryptionKey, teardown, activate]);

  // Unmount safety — nothing else will stop the socket.
  useEffect(() => () => {
    const c = clientRef.current;
    clientRef.current = null;
    if (c) { try { c.stop(); } catch { /* already stopped */ } }
  }, []);

  const persistAndActivate = useCallback(async (cred: HeartwoodOperatorCredential): Promise<OperatorImportOutcome> => {
    if (!enabled || !encryptionKey) return { error: 'Unlock first.' };
    try {
      await saveHeartwoodOperator(cred, encryptionKey);
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Could not save the operator key.' };
    }
    setCredential(cred);
    activate(cred, genRef.current);
    return { imported: true };
  }, [enabled, encryptionKey, activate]);

  const importLink = useCallback(async (text: string, pin?: string): Promise<OperatorImportOutcome> => {
    const r = resolveImportInput(text, pin);
    if (r.kind === 'needs-pin') return { needsPin: true };
    if (r.kind === 'error') return { error: r.message };
    return persistAndActivate(r.cred);
  }, [persistAndActivate]);

  const importPhrase = useCallback(async (words: string, deviceInput: string, relaysText: string): Promise<OperatorImportOutcome> => {
    const r = resolvePhraseInput(words, deviceInput, relaysText);
    if (r.kind === 'error') return { error: r.message };
    return persistAndActivate(r.cred);
  }, [persistAndActivate]);

  const forget = useCallback(async () => {
    try { await deleteHeartwoodOperator(); } catch { /* best-effort — state is dropped regardless */ }
    teardown();
  }, [teardown]);

  const refreshStatus = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    await probeStatus(c, genRef.current);
  }, [probeStatus]);

  const flags = operatorFeatureFlags(status);

  return {
    credential,
    client,
    status,
    statusError,
    loading,
    canPush: flags.canPush,
    canVerdict: flags.canVerdict,
    importLink,
    importPhrase,
    forget,
    refreshStatus,
  };
}
