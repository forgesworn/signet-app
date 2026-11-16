/**
 * Guardian side of the child-direct ready check (`child-ready-check.ts`).
 *
 *   at the end of a pairing (`probeOnStart`), once per pairing:
 *     read `list_clients` → if the device does not list this phone's own
 *     natural person as approved, one harmless self-probe through the NP
 *     route (`nip44_encrypt` of a fixed text to itself, never published,
 *     never the master) so REMEMBER AS shows now, with the family at the
 *     device, instead of the first time the escalation inbox decrypts →
 *     read again.
 *   on any surface showing it: read on mount, then every `pollMs` while a
 *     press is owed, for `pollForMs` (the child's presses start from the
 *     child's phone; this phone only watches them land).
 *   "Finish now": the same as the end of a pairing, on demand.
 *
 * Readiness comes from `client_approvals` alone; a probe answer counts only
 * when the device does not report them. No NP route ⇒ "not confirmed", never
 * done. Reads run under the operator lock, like every other slot read that
 * must not interleave with a policy push. Nothing throws out of an effect.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DependantIdentity } from '../types';
import type { DeviceClientSlot } from '../lib/heartwood-mgmt-types';
import { listClients, type HeartwoodMgmtClient } from '../lib/heartwood-mgmt';
import { withOperatorLock } from '../lib/operator-lock';
import {
  expectedChildPersonas, guardianReadyRows, isApprovalChanged, owedPresses, type NpProbeState, type ReadyRow,
} from '../lib/child-ready-check';
import { APPROVAL_CHANGED_RETRIES, APPROVE_IDENTITY_PLAINTEXT } from './useChildDeviceLink';
import { CHILD_READY_COPY } from '../lib/child-ready-copy';

/** What App.tsx supplies on top of the pairing options. */
export interface ChildReadyCheckDeps {
  /** This phone's NIP-46 client pubkey (from the stored bunker secret); null when unknown. */
  guardianClientPubkey: string | null;
  /** The guardian's natural-person route (`npBunkerBackend`); null when it is not available. */
  npBackend: { nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> } | null;
}

export interface UseChildReadyCheckOpts extends ChildReadyCheckDeps {
  dependant: DependantIdentity | null;
  operator: HeartwoodMgmtClient | null;
  guardianNpPubkey: string;
  enabled: boolean;
  /** Send the natural-person probe without a tap: only at the end of a pairing. */
  probeOnStart: boolean;
  /** Before the first auto probe, so the pairing's policy push can settle (a change withdraws waiting cards). */
  startDelayMs?: number;
  pollMs?: number;
  pollForMs?: number;
}

export interface ChildReadyCheck {
  /** Empty until the device has been read. */
  rows: ReadyRow[];
  owed: number;
  /** The natural-person probe is waiting on the device. */
  probing: boolean;
  /** The device has been read at least once. */
  checked: boolean;
  /** Some "ready" rests on a probe answer or an unreported field (state only, never shown). */
  unverified: boolean;
  finishNow(): Promise<void>;
}

const HEX64 = /^[0-9a-f]{64}$/;
/** NP probe answers this session, by `client:np` (the fallback when the device does not report approvals). */
const npProbeMemory = new Map<string, NpProbeState>();
/** Pairings whose automatic NP probe has started, by `dep:client:slot`. */
const autoProbed = new Set<string>();

/** Tests only. */
export function resetChildReadyCheckMemory(): void {
  npProbeMemory.clear();
  autoProbed.clear();
}

export function useChildReadyCheck(o: UseChildReadyCheckOpts): ChildReadyCheck {
  const startDelayMs = o.startDelayMs ?? 3_000;
  const pollMs = o.pollMs ?? 8_000;
  const pollForMs = o.pollForMs ?? 3 * 60_000;
  const dep = o.enabled && o.dependant?.childDevice?.mode === 'heartwood-direct' ? o.dependant : null;
  const cd = dep?.childDevice ?? null;
  const pairingKey = dep && cd ? `${dep.id}:${cd.clientPubkey}:${cd.slotIndex}:${cd.secretFingerprint}` : '';
  const personasKey = dep ? expectedChildPersonas(dep).map(p => p.pubkey).join(',') : '';
  const np = (o.guardianNpPubkey || '').toLowerCase();
  const memoryKey = `${(o.guardianClientPubkey ?? '').toLowerCase()}:${np}`;

  const optsRef = useRef(o);
  optsRef.current = o;
  const depRef = useRef(dep);
  depRef.current = dep;

  const [slots, setSlots] = useState<DeviceClientSlot[] | null>(null);
  const [npProbe, setNpProbeState] = useState<NpProbeState>(() => npProbeMemory.get(memoryKey) ?? 'none');
  const npProbeRef = useRef(npProbe);
  useEffect(() => {
    const remembered = npProbeMemory.get(memoryKey) ?? 'none';
    npProbeRef.current = remembered;
    setNpProbeState(remembered);
  }, [memoryKey]);
  const setNpProbe = useCallback((s: NpProbeState) => {
    npProbeRef.current = s;
    npProbeMemory.set(memoryKey, s);
    setNpProbeState(s);
  }, [memoryKey]);

  const [pollUntil, setPollUntil] = useState(0);
  const readRef = useRef<Promise<DeviceClientSlot[] | null> | null>(null);
  const probeRef = useRef<Promise<void> | null>(null);

  const read = useCallback((): Promise<DeviceClientSlot[] | null> => {
    if (readRef.current) return readRef.current;
    const op = optsRef.current.operator;
    if (!op) return Promise.resolve(null);
    const run = withOperatorLock(op, () => listClients(op))
      .then((out) => { setSlots(out); return out; }, () => null)
      .finally(() => { if (readRef.current === run) readRef.current = null; });
    readRef.current = run;
    return run;
  }, []);

  const rowsFor = useCallback((s: DeviceClientSlot[] | null, probe: NpProbeState): ReadyRow[] | null => {
    const d = depRef.current;
    if (!s || !d) return null;
    return guardianReadyRows({
      dependant: d, slots: s, guardianClientPubkey: optsRef.current.guardianClientPubkey,
      guardianNpPubkey: optsRef.current.guardianNpPubkey, npProbe: probe, guardianRowName: CHILD_READY_COPY.guardianRow,
    });
  }, []);

  const probeNp = useCallback((): Promise<void> => {
    if (probeRef.current) return probeRef.current;
    const target = (optsRef.current.guardianNpPubkey || '').toLowerCase();
    if (!HEX64.test(target)) return Promise.resolve();
    const backend = optsRef.current.npBackend;
    if (!backend) { setNpProbe('no-route'); return Promise.resolve(); }
    setNpProbe('probing');
    const run = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          // A NIP-46 request to the Heartwood only: never published, the answer is dropped.
          await backend.nip44Encrypt(target, APPROVE_IDENTITY_PLAINTEXT);
          setNpProbe('ok');
          return;
        } catch (err) {
          if (attempt < APPROVAL_CHANGED_RETRIES && isApprovalChanged(err)) continue;
          setNpProbe('failed');
          return;
        }
      }
    })().finally(() => { probeRef.current = null; });
    probeRef.current = run;
    return run;
  }, [setNpProbe]);

  /** Read; if asked, probe the NP when the device does not list it as ready; read again. */
  const runCheck = useCallback(async (probe: boolean) => {
    const first = await read();
    if (probe) {
      const rows = rowsFor(first, npProbeRef.current);
      const npRow = rows?.find(r => r.who === 'guardian');
      // The child's phone is not on the device: nothing to get ready.
      const childGone = first !== null && rows === null;
      if (!childGone && npRow?.state !== 'ready') {
        await probeNp();
        await read();
      }
    }
    setPollUntil(Date.now() + pollForMs);
  }, [read, rowsFor, probeNp, pollForMs]);

  // Mount / a new pairing / a persona added: read (and, once per pairing, probe).
  const hasOperator = !!o.operator;
  useEffect(() => {
    if (!pairingKey || !hasOperator) return;
    let cancelled = false;
    const wantProbe = optsRef.current.probeOnStart && !autoProbed.has(pairingKey);
    const timer = setTimeout(() => {
      if (cancelled) return;
      if (wantProbe) autoProbed.add(pairingKey);
      void runCheck(wantProbe).catch(() => { /* never out of an effect */ });
    }, wantProbe ? startDelayMs : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pairingKey, personasKey, hasOperator, o.probeOnStart, runCheck, startDelayMs]);

  const rows = useMemo(() => rowsFor(slots, npProbe) ?? [], [rowsFor, slots, npProbe, pairingKey, personasKey]); // eslint-disable-line react-hooks/exhaustive-deps -- rows read the latest dependant through depRef
  const owed = owedPresses(rows);

  // Watch the child's presses land while something is owed.
  useEffect(() => {
    if (!pairingKey || !hasOperator || owed === 0) return;
    if (Date.now() >= pollUntil) return;
    const timer = setInterval(() => {
      if (Date.now() >= pollUntil) { clearInterval(timer); return; }
      void read();
    }, pollMs);
    return () => clearInterval(timer);
  }, [pairingKey, hasOperator, owed, pollUntil, pollMs, read]);

  const finishNow = useCallback(async () => {
    try { await runCheck(true); } catch { /* shown as still owed */ }
  }, [runCheck]);

  return {
    rows,
    owed,
    probing: npProbe === 'probing',
    checked: slots !== null,
    unverified: rows.some(r => r.state === 'ready' && !r.verified),
    finishNow,
  };
}
