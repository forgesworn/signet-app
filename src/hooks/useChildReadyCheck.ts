/**
 * Guardian side of the child-direct ready check (`child-ready-check.ts`),
 * mounted ONCE in App for every direct dependant, so nothing depends on a
 * screen staying open.
 *
 *   one reading   `list_clients` (strict, under the operator lock) serves every
 *                 direct dependant. A failed read, a reply with no client list
 *                 or an empty list is "unknown", retried with backoff; the
 *                 last good reading is kept for the child (`approvedByDep`).
 *   after pairing (`pairedAt` within `autoProbeWindowMs`, no saved result for
 *                 that pairing yet): after `startDelayMs` (the mint's policy
 *                 push settles), read; if the device does not list this
 *                 phone's own natural person, save "owed" and THEN send one
 *                 harmless self-probe through the NP route (`nip44_encrypt` of
 *                 a fixed text to itself, never published, never the master),
 *                 so REMEMBER AS shows now, with the family at the device;
 *                 read again and save the outcome. Survives leaving the
 *                 screen, a lock (the saved "owed" stays) and a restart.
 *   saved result  encrypted, device-local, never synced (`childDirect:readyCheck`
 *                 row): the guardian row's outcome and the child's last
 *                 recorded identities, per pairing.
 *   paused        a paused child's slot refuses everything: no probe, no nag;
 *                 re-checked when the pause ends (that is a change of the
 *                 dependant, which re-runs the check).
 *   watching      `watch(dep)` (a surface showing the checklist) and every
 *                 check read again every `pollMs` for `pollForMs` while a
 *                 press is owed: the child's presses start from its phone.
 *
 * Nothing throws out of an effect. Retries are bounded.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DependantIdentity } from '../types';
import type { DeviceClientSlot } from '../lib/heartwood-mgmt-types';
import { listClients, type HeartwoodMgmtClient } from '../lib/heartwood-mgmt';
import { withOperatorLock } from '../lib/operator-lock';
import {
  approvedForChild, expectedChildPersonas, guardianOutcomeOf, guardianReadyRows, isApprovalChanged, owedPresses, readySummary,
  type NpProbeState, type ReadyRow, type ReadySummary,
} from '../lib/child-ready-check';
import { loadChildReadyRecords, updateChildReadyRecords, type ChildReadyRecord, type ChildReadyRecords } from '../lib/db';
import { APPROVAL_CHANGED_RETRIES, APPROVE_IDENTITY_PLAINTEXT } from './useChildDeviceLink';
import { CHILD_READY_COPY } from '../lib/child-ready-copy';

/** Where the saved results live (injectable for tests). */
export interface ChildReadyStore {
  load(encryptionKey: string): Promise<ChildReadyRecords>;
  update(fn: (current: ChildReadyRecords) => ChildReadyRecords | null, encryptionKey: string): Promise<void>;
}
const defaultStore: ChildReadyStore = { load: loadChildReadyRecords, update: updateChildReadyRecords };

export interface UseGuardianReadyChecksOpts {
  /** Unlocked, a guardian install (never a paired child). */
  enabled: boolean;
  dependants: readonly DependantIdentity[];
  operator: HeartwoodMgmtClient | null;
  /** This phone's NIP-46 client pubkey (from the stored bunker secret); null when unknown. */
  guardianClientPubkey: string | null;
  guardianNpPubkey: string;
  /** The guardian's natural-person route (`npBunkerBackend`); null when it is not available. */
  npBackend: { nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> } | null;
  encryptionKey: string | null;
  store?: ChildReadyStore;
  /** Before the automatic probe, so the pairing's policy push can settle (a change withdraws waiting cards). */
  startDelayMs?: number;
  pollMs?: number;
  pollForMs?: number;
  /** How long after `pairedAt` the automatic probe may still start (a later unlock). */
  autoProbeWindowMs?: number;
  /** Waits before each retry of a failed read; the list's length bounds the retries. */
  retryDelaysMs?: readonly number[];
}

export interface ChildReadyCheck {
  /** Empty until there is something to say (not read yet and nothing owed on record). */
  rows: ReadyRow[];
  summary: ReadySummary;
  owed: number;
  /** The natural-person probe is waiting on the device. */
  probing: boolean;
  /** The device has been asked at least once (the answer may have been unknown). */
  checked: boolean;
  paused: boolean;
  finishNow(): Promise<void>;
}

export interface GuardianReadyChecks {
  /** Null when the dependant is not paired straight to the Heartwood. */
  forDependant(depId: string): ChildReadyCheck | null;
  /** A surface is showing the checklist: read now and watch for presses for a while. */
  watch(depId: string): void;
  /** The child's recorded identities per dependant id, for the rules payload (`approved`). Stable while unchanged. */
  approvedByDep: Readonly<Record<string, string[]>>;
  /** Saved results have been read (or failed to): the rules publisher waits for this. */
  loaded: boolean;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function pairingKeyOf(dep: DependantIdentity): string {
  const cd = dep.childDevice;
  if (cd?.mode !== 'heartwood-direct') return '';
  return `${dep.id}:${cd.clientPubkey}:${cd.slotIndex}:${cd.secretFingerprint}`.toLowerCase();
}

const isPaused = (dep: DependantIdentity) => dep.defaultSchedule?.paused === true;

function sameRecord(a: ChildReadyRecord | undefined, b: ChildReadyRecord): boolean {
  return !!a && a.pairing === b.pairing && a.guardian === b.guardian
    && JSON.stringify(a.approved ?? null) === JSON.stringify(b.approved ?? null);
}

export function useGuardianReadyChecks(o: UseGuardianReadyChecksOpts): GuardianReadyChecks {
  const store = o.store ?? defaultStore;
  const startDelayMs = o.startDelayMs ?? 3_000;
  const pollMs = o.pollMs ?? 8_000;
  const pollForMs = o.pollForMs ?? 3 * 60_000;
  const autoProbeWindowMs = o.autoProbeWindowMs ?? 30 * 60_000;
  const retryDelaysMs = o.retryDelaysMs ?? [5_000, 15_000, 60_000, 180_000];

  const optsRef = useRef(o);
  optsRef.current = o;
  const storeRef = useRef(store);
  storeRef.current = store;

  const enabled = o.enabled && !!o.encryptionKey;
  const direct = useMemo(() => o.dependants.filter(d => d.childDevice?.mode === 'heartwood-direct'), [o.dependants]);
  const directRef = useRef(direct);
  directRef.current = direct;
  // Everything that should trigger a fresh look: each pairing, its personas, its pause.
  const directKey = direct.map(d => `${pairingKeyOf(d)}|${expectedChildPersonas(d).map(p => p.pubkey).join(',')}|${isPaused(d) ? 'p' : ''}|${d.childDevice?.pairedAt ?? 0}`).join(';');
  const memoryKey = `${(o.guardianClientPubkey ?? '').toLowerCase()}:${(o.guardianNpPubkey || '').toLowerCase()}`;

  // ── Saved results ─────────────────────────────────────────────────────────
  const [records, setRecords] = useState<ChildReadyRecords | null>(null);
  const recordsRef = useRef<ChildReadyRecords | null>(null);
  useEffect(() => {
    recordsRef.current = null;
    setRecords(null);
    const key = o.encryptionKey;
    if (!enabled || !key) return;
    let cancelled = false;
    void storeRef.current.load(key).then(
      (r) => { if (!cancelled) { recordsRef.current = r; setRecords(r); } },
      () => { if (!cancelled) { recordsRef.current = {}; setRecords({}); } },
    );
    return () => { cancelled = true; };
  }, [enabled, o.encryptionKey]);

  const recordFor = useCallback((dep: DependantIdentity): ChildReadyRecord | undefined => {
    const r = recordsRef.current?.[dep.id.toLowerCase()];
    return r && r.pairing === pairingKeyOf(dep) ? r : undefined;
  }, []);

  /** Save these records (merged over the stored row), pruning any dependant no longer paired this way. */
  const saveRecords = useCallback(async (changes: Record<string, ChildReadyRecord>) => {
    const key = optsRef.current.encryptionKey;
    if (!key || Object.keys(changes).length === 0) return;
    const live = new Map(directRef.current.map(d => [d.id.toLowerCase(), pairingKeyOf(d)]));
    const merged: ChildReadyRecords = { ...(recordsRef.current ?? {}), ...changes };
    for (const [id, r] of Object.entries(merged)) if (live.get(id) !== r.pairing) delete merged[id];
    recordsRef.current = merged;
    setRecords(merged);
    try {
      await storeRef.current.update((cur) => {
        const next: ChildReadyRecords = { ...cur, ...changes };
        for (const [id, r] of Object.entries(next)) if (live.get(id) !== r.pairing) delete next[id];
        return next;
      }, key);
    } catch { /* kept in memory; written again with the next change */ }
  }, []);

  // ── The device reading ───────────────────────────────────────────────────
  const [reading, setReading] = useState<DeviceClientSlot[] | null>(null);
  const readingRef = useRef<DeviceClientSlot[] | null>(null);
  const [lastFailed, setLastFailed] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [npProbe, setNpProbeState] = useState<NpProbeState>('none');
  const npProbeRef = useRef<NpProbeState>('none');
  const [pollUntil, setPollUntil] = useState(0);
  const genRef = useRef(0);
  const readRef = useRef<Promise<DeviceClientSlot[] | null> | null>(null);
  const probeRef = useRef<Promise<void> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryIdx = useRef(0);
  const autoRunning = useRef(false);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Pairings whose automatic probe has had a good first reading this session (never looped). */
  const autoTried = useRef(new Set<string>());
  const scheduleAutoRef = useRef<() => void>(() => {});

  const setNpProbe = useCallback((s: NpProbeState) => { npProbeRef.current = s; setNpProbeState(s); }, []);

  // Locked, another operator, another phone key: start over.
  const hasOperator = !!o.operator;
  useEffect(() => {
    genRef.current++;
    readingRef.current = null;
    setReading(null);
    setLastFailed(false);
    setAttempted(false);
    setPollUntil(0);
    readRef.current = null;
    probeRef.current = null;
    autoRunning.current = false;
    // A check cut short here (a lock) may start again; a saved result still stops it.
    autoTried.current = new Set();
    retryIdx.current = 0;
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; }
    if (autoTimer.current) { clearTimeout(autoTimer.current); autoTimer.current = null; }
    setNpProbe('none');
  }, [enabled, o.operator, memoryKey, setNpProbe]);
  useEffect(() => () => {
    genRef.current++;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    if (autoTimer.current) clearTimeout(autoTimer.current);
  }, []);

  /** Save what a good reading says for every direct dependant that already has a result (or is past its automatic probe). */
  const persistReading = useCallback(async (slots: DeviceClientSlot[], dueIds: ReadonlySet<string>) => {
    const opts = optsRef.current;
    const changes: Record<string, ChildReadyRecord> = {};
    for (const dep of directRef.current) {
      const id = dep.id.toLowerCase();
      // A pairing still waiting for its automatic probe gets its first result from that probe.
      if (dueIds.has(id)) continue;
      const rows = guardianReadyRows({
        dependant: dep, slots, guardianClientPubkey: opts.guardianClientPubkey, guardianNpPubkey: opts.guardianNpPubkey,
        npProbe: npProbeRef.current, guardianRowName: CHILD_READY_COPY.guardianRow, savedGuardian: recordFor(dep)?.guardian,
      });
      if (!rows) continue;
      const guardian = guardianOutcomeOf(rows, npProbeRef.current) ?? 'unknown';
      const approved = approvedForChild(dep, slots);
      const rec: ChildReadyRecord = { pairing: pairingKeyOf(dep), guardian, ...(approved ? { approved } : {}), at: Date.now() };
      if (!sameRecord(recordFor(dep), rec)) changes[id] = rec;
    }
    await saveRecords(changes);
  }, [recordFor, saveRecords]);

  const isDue = useCallback((dep: DependantIdentity): boolean => {
    if (recordFor(dep) || autoTried.current.has(pairingKeyOf(dep))) return false;
    const at = dep.childDevice?.pairedAt ?? 0;
    return Date.now() - at <= autoProbeWindowMs;
  }, [recordFor, autoProbeWindowMs]);

  const read = useCallback((): Promise<DeviceClientSlot[] | null> => {
    if (readRef.current) return readRef.current;
    const op = optsRef.current.operator;
    if (!op) return Promise.resolve(null);
    const gen = genRef.current;
    const run = withOperatorLock(op, async () => {
      const out = await listClients(op, { strict: true });
      // No slot at all cannot be this family's device answering: say nothing about it.
      if (out.length === 0) throw new Error('list_clients reply had no slots');
      return out;
    }).then(
      (out) => {
        if (gen !== genRef.current) return null;
        readingRef.current = out;
        setReading(out);
        setLastFailed(false);
        setAttempted(true);
        retryIdx.current = 0;
        const due = new Set(directRef.current.filter(d => isDue(d)).map(d => d.id.toLowerCase()));
        void persistReading(out, due).catch(() => { /* written again on the next reading */ });
        // A fresh pairing whose automatic probe could not read the device yet: now it can.
        if (due.size > 0) scheduleAutoRef.current();
        return out;
      },
      () => {
        if (gen !== genRef.current) return null;
        setLastFailed(true);
        setAttempted(true);
        // Bounded backoff; the next change or check starts a fresh series.
        if (!retryTimer.current && retryIdx.current < retryDelaysMs.length) {
          const wait = retryDelaysMs[retryIdx.current++];
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            if (gen === genRef.current) void read();
          }, wait);
        }
        return null;
      },
    ).finally(() => { if (readRef.current === run) readRef.current = null; });
    readRef.current = run;
    return run;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- retry delays are read once per mount
  }, [persistReading, isDue]);

  const probeNp = useCallback((): Promise<void> => {
    if (probeRef.current) return probeRef.current;
    const target = (optsRef.current.guardianNpPubkey || '').toLowerCase();
    if (!HEX64.test(target)) return Promise.resolve();
    const backend = optsRef.current.npBackend;
    if (!backend) { setNpProbe('no-route'); return Promise.resolve(); }
    const gen = genRef.current;
    setNpProbe('probing');
    const run = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          // A NIP-46 request to the Heartwood only: never published, the answer is dropped.
          await backend.nip44Encrypt(target, APPROVE_IDENTITY_PLAINTEXT);
          if (gen === genRef.current) setNpProbe('ok');
          return;
        } catch (err) {
          if (attempt < APPROVAL_CHANGED_RETRIES && isApprovalChanged(err)) continue;
          if (gen === genRef.current) setNpProbe('failed');
          return;
        }
      }
    })().finally(() => { probeRef.current = null; });
    probeRef.current = run;
    return run;
  }, [setNpProbe]);

  /**
   * Read; then, when asked and nobody is paused, probe the natural person if
   * the device does not list it (owed, or not reported); read again; save.
   * `deps` get their result saved (owed first, before the probe goes out).
   */
  const check = useCallback(async (deps: DependantIdentity[], probe: boolean) => {
    const gen = genRef.current;
    const first = await read();
    if (gen !== genRef.current) return;
    // A good first reading settles the automatic probe for these pairings,
    // whatever it finds; never for a paused one (its check waits for the pause to end).
    if (first && probe) for (const d of deps) if (!isPaused(d)) autoTried.current.add(pairingKeyOf(d));
    if (first && probe) {
      const opts = optsRef.current;
      const live = deps.filter(d => !isPaused(d));
      const before: Record<string, ChildReadyRecord> = {};
      let wantProbe = false;
      for (const dep of live) {
        const rows = guardianReadyRows({
          dependant: dep, slots: first, guardianClientPubkey: opts.guardianClientPubkey, guardianNpPubkey: opts.guardianNpPubkey,
          npProbe: npProbeRef.current, guardianRowName: CHILD_READY_COPY.guardianRow, savedGuardian: recordFor(dep)?.guardian,
        });
        if (!rows) continue; // the child's phone is not on the device: nothing to get ready
        const g = rows.find(r => r.who === 'guardian');
        if (g && (g.state === 'waiting' || g.state === 'unknown')) {
          wantProbe = true;
          const approved = approvedForChild(dep, first);
          before[dep.id.toLowerCase()] = { pairing: pairingKeyOf(dep), guardian: g.state === 'waiting' ? 'owed' : 'unknown', ...(approved ? { approved } : {}), at: Date.now() };
        }
      }
      if (wantProbe) {
        // Saved BEFORE the press is asked for: a lock or a restart mid-probe leaves it owed, never forgotten.
        await saveRecords(before);
        await probeNp();
        if (gen !== genRef.current) return;
        const second = await read();
        if (gen !== genRef.current) return;
        if (second) await persistReading(second, new Set());
      } else {
        await persistReading(first, new Set());
      }
    }
    if (gen === genRef.current) setPollUntil(Date.now() + pollForMs);
  }, [read, probeNp, recordFor, saveRecords, persistReading, pollForMs]);

  // The automatic probe for fresh pairings, once each: after `startDelayMs`,
  // never while paused, never twice at once.
  scheduleAutoRef.current = () => {
    if (autoTimer.current || autoRunning.current) return;
    if (!optsRef.current.operator || recordsRef.current === null) return;
    if (!directRef.current.some(d => isDue(d) && !isPaused(d))) return;
    const gen = genRef.current;
    autoTimer.current = setTimeout(() => {
      autoTimer.current = null;
      if (gen !== genRef.current) return;
      const due = directRef.current.filter(d => isDue(d) && !isPaused(d));
      if (due.length === 0) return;
      autoRunning.current = true;
      void check(due, true).catch(() => { /* never out of an effect */ }).finally(() => { autoRunning.current = false; });
    }, startDelayMs);
  };

  // A new look whenever the set of pairings, their personas or a pause
  // changes, and when the operator channel comes up: the automatic probe when
  // one is due, else a plain read.
  const loaded = records !== null;
  useEffect(() => {
    if (!enabled || !hasOperator || !loaded || directRef.current.length === 0) return;
    retryIdx.current = 0;
    if (directRef.current.some(d => isDue(d) && !isPaused(d))) scheduleAutoRef.current();
    else void read();
  }, [enabled, hasOperator, loaded, directKey, read, isDue]);

  // ── Per dependant ────────────────────────────────────────────────────────
  const uiSlots = lastFailed ? null : reading;
  const rowsFor = useCallback((dep: DependantIdentity): ReadyRow[] => {
    const opts = optsRef.current;
    const saved = recordFor(dep)?.guardian;
    const rows = guardianReadyRows({
      dependant: dep, slots: uiSlots, guardianClientPubkey: opts.guardianClientPubkey, guardianNpPubkey: opts.guardianNpPubkey,
      npProbe, guardianRowName: CHILD_READY_COPY.guardianRow, savedGuardian: saved,
    });
    if (!rows) return [];
    // Nothing asked yet and nothing owed on record: say nothing rather than "unknown" for a moment.
    if (!attempted && npProbe !== 'probing' && saved !== 'owed' && saved !== 'no-route') return [];
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `records` makes `recordFor` current
  }, [uiSlots, npProbe, attempted, recordFor, records, memoryKey]);

  // Watch for presses while something is owed.
  const anyOwed = enabled && direct.some(d => !isPaused(d) && owedPresses(rowsFor(d)) > 0);
  useEffect(() => {
    if (!enabled || !hasOperator || !anyOwed) return;
    if (Date.now() >= pollUntil) return;
    const timer = setInterval(() => {
      if (Date.now() >= pollUntil) { clearInterval(timer); return; }
      void read();
    }, pollMs);
    return () => clearInterval(timer);
  }, [enabled, hasOperator, anyOwed, pollUntil, pollMs, read]);

  const finishFor = useCallback(async (depId: string) => {
    const dep = directRef.current.find(d => d.id === depId);
    if (!dep) return;
    retryIdx.current = 0;
    try { await check([dep], !isPaused(dep)); } catch { /* shown as still owed */ }
  }, [check]);

  const watch = useCallback((depId: string) => {
    if (!directRef.current.some(d => d.id === depId)) return;
    retryIdx.current = 0;
    void read();
    setPollUntil(Date.now() + pollForMs);
  }, [read, pollForMs]);

  const forDependant = useCallback((depId: string): ChildReadyCheck | null => {
    const dep = direct.find(d => d.id === depId);
    if (!dep || !enabled) return null;
    const rows = rowsFor(dep);
    const paused = isPaused(dep);
    return {
      rows,
      summary: readySummary(rows, { paused }),
      owed: paused ? 0 : owedPresses(rows),
      probing: npProbe === 'probing',
      checked: attempted,
      paused,
      finishNow: () => finishFor(dep.id),
    };
  }, [direct, enabled, rowsFor, npProbe, attempted, finishFor]);

  // For the rules payload: the last good reading (a failed read does not take it away), else the saved one.
  const approvedJson = JSON.stringify(direct.map((dep) => {
    const approved = reading ? approvedForChild(dep, reading) : recordFor(dep)?.approved;
    return [dep.id, approved ?? null];
  }).filter(([, a]) => a !== null));
  const approvedByDep = useMemo(() => Object.fromEntries(JSON.parse(approvedJson) as [string, string[]][]), [approvedJson]);

  return { forDependant, watch, approvedByDep, loaded: !enabled || loaded };
}
