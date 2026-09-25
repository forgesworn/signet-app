/**
 * Every managed directory at once, for the family contacts manager.
 *
 * `useContactsV2` is deliberately one directory per mount, which is right for
 * the Contacts screen but wrong for a table with a column per family member —
 * six mounts would mean six independent loads and six independent clocks. This
 * hook reads the whole operation log once, reduces it, partitions the records
 * by `directoryId` and resolves each partition with ITS OWN context (its own
 * active guardians and its own `defaultChildCeiling`), so a ceiling set for
 * Sam never leaks into Lily's column.
 *
 * `applyOps` writes a batch under one advancing Lamport clock so the order the
 * user saw is the order the reducer sees — an `add` followed by a `vouch` for
 * the same contact must not be able to arrive the other way round. Each batch
 * runs as ONE task on a per-instance serial queue (`createSerialQueue`), the
 * same defence `useContactsV2` uses: without it, two overlapping `applyOps`
 * calls (a double-tap, or a call landing during a reload) would both read the
 * clock before either write lands, and their operations would collide. The
 * clock itself is seeded from the OBSERVED frontier, not just the in-memory
 * ref, because this hook and every single-directory `useContactsV2` instance
 * share one operation log: a batch that only bumped its own ref could hand out
 * a clock value already used by an operation this instance had not loaded yet.
 *
 * Each built operation is validated before it is persisted. A validation
 * failure throws immediately and stops the batch — but an EARLIER operation
 * in the same batch may already be saved, since each op is independently
 * valid and independently persisted; that is accepted (no partial-batch
 * rollback), not a bug. Whatever prefix of the batch DID persist is
 * published to React state in a `finally`, even on a mid-batch throw, so
 * `ops` (state) and `opsRef` (the clock's view of the log) never disagree —
 * a disagreement there would let the next `applyOps` call compute a clock
 * from a frontier state itself hadn't rendered yet.
 *
 * The queue is NOT re-entrant: never call `reload()` or `applyOps()` from
 * inside a queued task.
 *
 * Unlike `useContactsV2`, this hook never writes the `contactRecordsV2`
 * cache — nothing reads that cache for the cross-family view today, and the
 * per-record re-encrypt cost of six directories' worth of records on every
 * batch is not worth paying for a read nobody performs.
 *
 * `actorRole` on a persisted op is derived per request from the matching
 * `FamilyDirectoryRef.isOwner` (`'owner'` in the owner's own directory,
 * `'guardian'` everywhere else), NOT taken verbatim from the caller-supplied
 * `actor.actorRole` — `useContactsV2` does the same (it is mounted once per
 * directory, so its single `actor` is already directory-scoped; this hook
 * mounts once for every directory at once, so it must make that same choice
 * per operation). Behaviourally inert today — the implicit child ceiling
 * only reads `directoryIsDependant`, not `createdByActorRole` — but the role
 * is a persisted, append-only fact, so it must be right regardless.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContactAction, ContactCeilingTier, ContactOperation } from '../types';
import { listAllContactOperationsV2, saveContactOperationV2 } from '../lib/db';
import { applyOperations, validateOperation } from '../lib/contacts-v2-reducer';
import { frontierOf, nextClock } from '../lib/contacts-v2-clock';
import { resolveEffectiveDirectory } from '../lib/contacts-v2-effective';
import { buildOperation, type MutationActor } from '../lib/contacts-v2-mutations';
import { newOperationId } from '../lib/contacts-v2-ids';
import type { ManagerDirectory } from '../lib/contacts-v2-manager-rows';
import { contactsMutationQueue, type SerialQueue } from '../lib/contacts-v2-queue';

export interface FamilyDirectoryRef {
  directoryId: string;
  label: string;
  isOwner: boolean;
  activeGuardianPubkeys: string[];
  defaultChildCeiling: ContactCeilingTier;
}

export interface FamilyOpRequest {
  directoryId: string;
  contactId: string;
  action: ContactAction;
  value: unknown;
  itemId?: string;
  targetOperationId?: string;
}

export interface UseFamilyContactsV2Options {
  enabled: boolean;
  encryptionKey: string | null;
  actor: MutationActor | null;
  directories: FamilyDirectoryRef[];
  /** Fired after a batch has persisted at least one operation (ruling R3). */
  onMutated?: () => void;
}

/**
 * `reload()`'s outcome. Deliberately NOT a plain `ManagerDirectory[]` any
 * more: a bare empty array is ambiguous between "genuinely nothing here"
 * (disabled/locked, or a real empty directory) and "the read failed" (a
 * decrypt/IDB error) — and a caller planning a destructive action off an
 * empty-looking result (the independence ceremony's confirm-time gate,
 * the remove-dependant contacts-choice plan) must be able to tell those
 * apart and fail closed on the latter. `ok: true` covers BOTH the disabled/
 * locked early-out (directories: []) and a real successful load (populated
 * or genuinely empty); only a thrown read/decrypt error yields `ok: false`.
 */
export type FamilyReloadResult =
  | { ok: true; directories: ManagerDirectory[] }
  | { ok: false };

export interface UseFamilyContactsV2Result {
  directories: ManagerDirectory[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<FamilyReloadResult>;
  applyOps: (requests: FamilyOpRequest[]) => Promise<void>;
}

/**
 * Pure: reduce `ops` and resolve each `refs` entry against its own context.
 * Shared by the `directories` memo (over hook state, for render) and
 * `reload` (over the just-loaded ops and the CURRENT refs, for a caller that
 * needs the freshly loaded directories synchronously after an `await
 * reload()` — the memo alone is one render behind a state update).
 */
function resolveManagerDirectories(
  ops: ContactOperation[],
  refs: FamilyDirectoryRef[],
): ManagerDirectory[] {
  const records = [...applyOperations(ops).values()];
  return refs.map(ref => ({
    directoryId: ref.directoryId,
    label: ref.label,
    isOwner: ref.isOwner,
    contacts: resolveEffectiveDirectory(
      records.filter(r => r.directoryId === ref.directoryId),
      {
        activeGuardianPubkeys: ref.activeGuardianPubkeys,
        defaultChildCeiling: ref.defaultChildCeiling,
        directoryIsDependant: !ref.isOwner,
      },
    ),
  }));
}

export function useFamilyContactsV2(opts: UseFamilyContactsV2Options): UseFamilyContactsV2Result {
  const { enabled, encryptionKey, actor } = opts;
  const [ops, setOps] = useState<ContactOperation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const opsRef = useRef<ContactOperation[]>([]);
  const clockRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    // Re-arm on every mount: React StrictMode (dev, `src/main.tsx`) mounts →
    // cleans up → mounts again, so a cleanup-only effect would leave this
    // false forever after the first cleanup and silently drop every
    // `setOps`/`setLoading`/`setError` from then on — the hook would sit at
    // `loading: true` forever in `npm run dev` (see `usePolicyPush.ts` for
    // the same trap and fix).
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Lazy-init, not `useRef(createSerialQueue())` — that would build (and
  // discard) a fresh queue on every render; this one is built once.
  const queueRef = useRef<SerialQueue | null>(null);
  if (queueRef.current === null) queueRef.current = contactsMutationQueue;

  // Latest directories in a ref, read inside `applyOps` (a `useCallback` we
  // deliberately do NOT re-create on every `directories` array identity
  // change — see the `refKey` comment below) so the per-request actorRole
  // lookup always sees the current list, not a stale closure.
  const directoriesRef = useRef<FamilyDirectoryRef[]>(opts.directories);
  directoriesRef.current = opts.directories;
  const onMutatedRef = useRef(opts.onMutated);
  onMutatedRef.current = opts.onMutated;

  // `JSON.stringify`, not a delimiter-joined string: `label` is a dependant
  // display name (user-controlled) and can itself contain any separator we
  // might pick, which would let two distinct directory lists alias to the
  // same key.
  const refKey = JSON.stringify(opts.directories.map(d => [
    d.directoryId, d.label, d.isOwner, d.defaultChildCeiling, d.activeGuardianPubkeys,
  ]));

  const reload = useCallback(async (): Promise<FamilyReloadResult> => {
    return queueRef.current!.run(async () => {
      if (!enabled || !encryptionKey) {
        opsRef.current = [];
        clockRef.current = 0;
        if (mountedRef.current) {
          setOps([]);
          setLoading(false);
          setError(null);
        }
        // Disabled/locked is not a failure — there is nothing to read yet,
        // not a read that failed. `ok: true` with an empty list.
        return { ok: true, directories: [] };
      }
      if (mountedRef.current) setLoading(true);
      try {
        const all = await listAllContactOperationsV2(encryptionKey);
        opsRef.current = all;
        clockRef.current = frontierOf(all).maxClock;
        if (mountedRef.current) {
          setOps(all);
          setError(null);
        }
        // Resolved from the ops JUST loaded, against the CURRENT refs (not
        // `opts.directories`, which this callback would otherwise close
        // over stale — see `directoriesRef` above) — so a caller that
        // awaits `reload()` gets the fresh directories synchronously,
        // rather than one render behind the `directories` memo's own
        // state-driven recompute.
        return { ok: true, directories: resolveManagerDirectories(all, directoriesRef.current) };
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : 'Could not load family contacts.');
        }
        // A genuine read/decrypt failure — distinct from the disabled/
        // locked early-out above. Callers planning a destructive action off
        // this result must be able to tell the two apart.
        return { ok: false };
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    });
  }, [enabled, encryptionKey]);

  useEffect(() => { void reload(); }, [reload]);

  const directories = useMemo<ManagerDirectory[]>(
    () => resolveManagerDirectories(ops, opts.directories),
    // `refKey` stands in for the directory descriptors: they are rebuilt each
    // render by the caller, so array identity would re-resolve every time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ops, refKey],
  );

  const applyOps = useCallback(async (requests: FamilyOpRequest[]) => {
    if (!encryptionKey || !actor) throw new Error('contacts: cannot apply — contacts scope not ready');
    // Serialised with `reload` on the SAME queue, so a batch can never
    // interleave with an in-flight reload's read.
    return queueRef.current!.run(async () => {
      opsRef.current = await listAllContactOperationsV2(encryptionKey);
      const written: ContactOperation[] = [];
      try {
        for (const req of requests) {
          // The op's `actorRole` is derived from the MATCHING directory, not
          // taken verbatim off the caller-supplied `actor` — see the
          // docstring. No matching ref means the request names a directory
          // this instance was never given, which is as invalid as a bad
          // `value`.
          const ref = directoriesRef.current.find(d => d.directoryId === req.directoryId);
          if (!ref) {
            throw new Error(`contacts: cannot ${req.action} — invalid operation`);
          }
          const reqActor: MutationActor = { ...actor, actorRole: ref.isOwner ? 'owner' : 'guardian' };
          // Seed from the OBSERVED frontier, not just the ref bump, because
          // this hook and every single-directory `useContactsV2` share one
          // log.
          const clock = nextClock(clockRef.current, frontierOf(opsRef.current).maxClock);
          clockRef.current = clock;
          const op = buildOperation({
            directoryId: req.directoryId,
            contactId: req.contactId,
            action: req.action,
            value: req.value,
            clock,
            actor: reqActor,
            now: Date.now(),
            operationId: newOperationId(),
            ...(req.itemId ? { itemId: req.itemId } : {}),
            ...(req.targetOperationId ? { targetOperationId: req.targetOperationId } : {}),
          });
          if (!validateOperation(op)) {
            throw new Error(`contacts: cannot ${req.action} — invalid operation`);
          }
          await saveContactOperationV2(op, encryptionKey);
          written.push(op);
          opsRef.current = [...opsRef.current, op];
        }
      } finally {
        // Publish whatever prefix persisted, even on a mid-batch throw, so
        // state and `opsRef` never disagree (M1).
        if (written.length > 0) {
          if (mountedRef.current) setOps(prev => [...prev, ...written]);
          // M5/R3: whatever PREFIX persisted is durable and publishable,
          // even if the batch threw part-way through, and even if this
          // hook instance has since unmounted — `onMutated` isn't React
          // state, so it must not be gated behind `mountedRef`.
          onMutatedRef.current?.();
        }
      }
    });
  }, [encryptionKey, actor]);

  return { directories, loading, error, reload, applyOps };
}
