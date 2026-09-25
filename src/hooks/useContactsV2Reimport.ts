import { listAllContactOperationsV2 } from '../lib/db';
/**
 * Re-run the Phase B legacy import after a legacy mutation.
 *
 * Phase B's `useContactsV2Import` runs once per unlock, which is right for the
 * cold path. This phase keeps the legacy write paths alive — `AddMember`
 * writes `contacts`, `KenAdd` / `VouchSomeone` write `ken`, and the v1 sync
 * rails merge remote rows in mid-session — so a row created after that first
 * pass would be invisible in v2 until the next unlock. This hook watches the
 * same arrays those surfaces re-read (`useContacts().members`,
 * `useKens().kens`) and re-runs `runContactsV2Import`, which is idempotent by
 * `contactImportSources` marker, so an unchanged run writes nothing.
 *
 * Runs are serialised and debounced; a failure is silent and retried on the
 * next change, exactly like the sync rails.
 *
 * M2: `ownerPubkeys` / `dependants` / `contacts` / `kens` are watched by
 * ARRAY IDENTITY, not deep equality — a re-run fires whenever any of these
 * references changes, full stop. Callers MUST pass reference-stable arrays
 * (React state that's only replaced when the underlying data actually
 * changes, or a `useMemo` keyed on the real inputs) — a fresh literal
 * (`[]`, `.map(...)`, a spread) rebuilt on every render looks like a
 * genuine change on EVERY render, including ones this hook's own `setRuns`
 * causes, and will spuriously re-trigger the debounced import forever.
 *
 * I1: a change landing while a run is already in flight is not dropped — it
 * coalesces into exactly one more run, fired from the in-flight run's own
 * completion (`finally`), using whatever the LATEST props are at that
 * moment (not whatever they were when the dropped attempt happened). Two
 * changes landing back-to-back mid-run still coalesce into that same one
 * extra run, not two.
 *
 * Fix round 2: a run already in flight when the caller stops (unmount, or
 * `enabled`/`encryptionKey` going false/null at lock) must not call
 * `setRuns` or `onImportedRef.current?.()` — the latter reaches all the way
 * out to `contactsV2.reload()` in App.tsx — after that happens. `aliveRef`
 * (below) tracks this: true only while a scheduled/in-flight run's "session"
 * is genuinely current. A ROUTINE dependency change (a new `contacts` array,
 * say) still re-arms it, so an in-flight run's completion and any coalesced
 * follow-up (I1) still fire normally in that case — only a real stop leaves
 * it false.
 */
import { useEffect, useRef, useState } from 'react';
import type { KenEntry } from '@forgesworn/kenspeckle';
import type { Contact } from '../types';
import {
  runContactsV2Import,
  type ImportDependantRef,
  type ImportIo,
} from '../lib/contacts-v2-import';
import {
  listContactImportSources,
  markContactImportSources,
  saveContactOperationsV2,
} from '../lib/db';

export const DEBOUNCE_MS = 400;

export interface UseContactsV2ReimportOptions {
  enabled: boolean;
  encryptionKey: string | null;
  deviceId: string | null;
  actorPubkey: string | null;
  ownerPubkeys: string[];
  dependants: ImportDependantRef[];
  /** Legacy rows to lift. Array identity change triggers a re-run — see M2 above. */
  contacts: Contact[];
  kens: KenEntry[];
  /** Called after a run that wrote at least one operation. */
  onImported?: () => void;
}

export function useContactsV2Reimport(opts: UseContactsV2ReimportOptions): { runs: number } {
  const [runs, setRuns] = useState(0);
  const inFlightRef = useRef(false);
  // I1: set when a run is requested while one is already in flight; the
  // in-flight run's own `finally` checks this and fires exactly one more
  // run rather than the request being silently dropped.
  const pendingRef = useRef(false);
  // Always the latest props, so a coalesced re-run (fired from a PREVIOUS
  // run's `finally`, not from the effect that requested it) picks up
  // whatever changed most recently rather than a stale closure.
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const onImportedRef = useRef(opts.onImported);
  onImportedRef.current = opts.onImported;
  // Fix round 2: true only while a scheduled/in-flight run's session is
  // genuinely current — set at the TOP of the debounce effect below (only
  // reached when enabled/encryptionKey/deviceId/actorPubkey are all
  // truthy), cleared by that same effect's cleanup. A routine dependency
  // change tears down the old effect and immediately sets up a new one in
  // the same commit, re-arming this to `true` before the in-flight run
  // completes — but a real stop (unmount, or the new render's guard clause
  // returning early because `enabled`/`encryptionKey` went false/null)
  // leaves it `false`, so a run finishing afterwards is silently dropped
  // instead of calling `setRuns` / `onImportedRef.current?.()` on a
  // hook instance that has gone away or is now locked.
  const aliveRef = useRef(false);

  const { enabled, encryptionKey, deviceId, actorPubkey, ownerPubkeys, dependants, contacts, kens } = opts;

  // Reassigned every render so it always closes over the latest refs above;
  // held in a ref (not called directly) so the debounce timer AND the
  // coalesced re-run from `finally` both always invoke the CURRENT version.
  const runOnceRef = useRef<() => void>(() => {});
  runOnceRef.current = () => {
    if (inFlightRef.current) {
      pendingRef.current = true;
      return;
    }
    const cur = optsRef.current;
    if (!cur.enabled || !cur.encryptionKey || !cur.deviceId || !cur.actorPubkey) return;
    const key = cur.encryptionKey;
    const device = cur.deviceId;
    const actor = cur.actorPubkey;
    inFlightRef.current = true;
    void (async () => {
      try {
        const io: ImportIo = {
          listExistingOps: () => listAllContactOperationsV2(key),
          listImportedSources: () => listContactImportSources(),
          // I3: one PBKDF2 derivation for the whole import batch instead of
          // one per operation.
          saveOps: (ops) => saveContactOperationsV2(ops, key),
          markSources: (sourceKeys, importedAt) => markContactImportSources(sourceKeys, importedAt),
        };
        const result = await runContactsV2Import({
          contacts: cur.contacts, kens: cur.kens, ownerPubkeys: cur.ownerPubkeys, dependants: cur.dependants,
          deviceId: device, actorPubkey: actor, now: Date.now(),
        }, io);
        // Fix round 2: don't touch state or fire the caller's callback for a
        // run whose session ended (unmount / lock) while it was in flight.
        if (aliveRef.current) {
          setRuns(n => n + 1);
          if (result.operations > 0) onImportedRef.current?.();
        }
      } catch {
        // Silent: the legacy stores remain authoritative and the next
        // change retries. Never surfaces, never throws out of the effect.
        if (aliveRef.current) setRuns(n => n + 1);
      } finally {
        inFlightRef.current = false;
        // I1: coalesce — fire exactly one more run for whatever landed
        // while this one was in flight, using the latest props at THIS
        // moment (via `runOnceRef.current`, reassigned every render).
        // Fix round 2: but only if the session is still alive — a pending
        // follow-up must not START after a real stop either.
        const shouldFollowUp = pendingRef.current && aliveRef.current;
        pendingRef.current = false;
        if (shouldFollowUp) runOnceRef.current();
      }
    })();
  };

  useEffect(() => {
    if (!enabled || !encryptionKey || !deviceId || !actorPubkey) return;
    aliveRef.current = true;
    const timer = setTimeout(() => { runOnceRef.current(); }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      aliveRef.current = false;
    };
  }, [enabled, encryptionKey, deviceId, actorPubkey, ownerPubkeys, dependants, contacts, kens]);

  return { runs };
}
