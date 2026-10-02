import { useEffect, useRef, useState } from 'react';
import { vaultPurpose, vaultContentHash } from 'signet-protocol/experimental';
import type { VaultDataset } from 'signet-protocol/experimental';
import type { DecryptingSigningBackend } from '../lib/signing-backend';
import { syncPrivateVaultDataset } from '../lib/private-vault-sync';
import type { PrivateVaultDatasetAdapter, PrivateVaultSyncResult } from '../lib/private-vault-sync';
import { isVaultApprovalError } from '../lib/vault-approval';

export interface PrivateVaultHealth {
  phase: 'checking' | 'unsupported' | 'running' | 'idle';
  datasets: Record<string, PrivateVaultSyncResult>;
  /**
   * The signer refused a vault request (denied, card timed out, busy). No
   * automatic retry runs for the rest of this unlock — each would put the
   * same card back up — until `approveToken` changes.
   */
  needsApproval?: boolean;
}
export interface PrivateVaultJob { adapter: PrivateVaultDatasetAdapter; resolve(rotation: number): Promise<DecryptingSigningBackend> }

/**
 * Wrap a job so any signer refusal from its resolution or from the backend it
 * hands out is reported to `note` (and still thrown). private-vault-sync
 * swallows errors into a dataset state, so this is the only place the kind of
 * failure is still visible.
 */
function observeRefusals(job: PrivateVaultJob, note: (err: unknown) => void): PrivateVaultJob {
  const watch = (backend: DecryptingSigningBackend): DecryptingSigningBackend => new Proxy(backend, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        return out instanceof Promise ? out.catch((err: unknown) => { note(err); throw err; }) : out;
      };
    },
  });
  return { adapter: job.adapter, resolve: async rotation => {
    try { return watch(await job.resolve(rotation)); }
    catch (err) { note(err); throw err; }
  } };
}

/**
 * Longest a `paused` hold is honoured. A sign-in normally settles within
 * seconds; this only stops a request that lingers unanswered from starving
 * backups for the rest of the unlock.
 */
export const PRIVATE_VAULT_PAUSE_CAP_MS = 5 * 60_000;

/**
 * Which datasets a cycle visits. `full`: all (unlock, reconnect, relay change,
 * approveToken, `online`). `change`: those not verified this session or whose
 * local snapshot no longer hashes to the revision they verified. `retry`: those
 * not verified. Each kind's set contains the next one's, so pending requests
 * merge by taking the larger.
 */
type CycleKind = 'retry' | 'change' | 'full';
const CYCLE_RANK: Record<CycleKind, number> = { retry: 0, change: 1, full: 2 };

/**
 * One cycle at a time; mutations coalesce, offline failures retry without new
 * edits. A signer REFUSAL stops automatic retries for the unlock instead
 * (`needsApproval`); changing `approveToken` runs the jobs once more.
 */
export function usePrivateVaults(options: {
  sessionKey: string | null;
  ownerPubkey: string | null;
  encryptionKey: string | null;
  supported: boolean;
  ready: boolean;
  migrationReady?: boolean;
  changeToken: string;
  /** Bump to re-run once after `needsApproval` (the user is at the device). */
  approveToken?: number;
  /**
   * Hold new device work while something more urgent owns the signer (a
   * sign-in). A dataset already in flight finishes; no further one starts
   * until the hold lifts (or `PRIVATE_VAULT_PAUSE_CAP_MS` passes), and the
   * cycle then runs promptly rather than sitting out a backoff armed before.
   */
  paused?: boolean;
  relays: { read: string[]; write: string[] };
  jobs(isCurrent: () => boolean): Promise<PrivateVaultJob[]>;
  onMerged(): void;
  onHealth?(health: PrivateVaultHealth): void;
}) {
  const [health, setHealth] = useState<PrivateVaultHealth>({ phase: 'checking', datasets: {} });
  const opts = useRef(options); opts.current = options;
  const kick = useRef<((kind?: CycleKind) => void) | null>(null);
  const session = `${options.sessionKey ?? ''}:${options.encryptionKey ?? ''}`;
  const currentSession = useRef(session); currentSession.current = session;
  const relayKey = JSON.stringify(options.relays);
  // The session that hit a refusal. Survives effect re-runs (relay edits,
  // `ready` flapping) so they don't quietly retry; cleared on lock and when
  // `approveToken` moves.
  const stoppedSession = useRef<string | null>(null);
  const seenApproveToken = useRef(options.approveToken ?? 0);
  const pausedSince = useRef<number | null>(null);
  if (options.paused && pausedSince.current === null) pausedSince.current = Date.now();
  if (!options.paused) pausedSince.current = null;
  const isPaused = () => pausedSince.current !== null && Date.now() - pausedSince.current < PRIVATE_VAULT_PAUSE_CAP_MS;

  useEffect(() => {
    if (!options.sessionKey || !options.encryptionKey) stoppedSession.current = null;
    if ((options.approveToken ?? 0) !== seenApproveToken.current) {
      seenApproveToken.current = options.approveToken ?? 0;
      stoppedSession.current = null;
    }
    const stopped = stoppedSession.current === session;
    const initial: PrivateVaultHealth = stopped ? { phase: 'idle', datasets: {}, needsApproval: true }
      : { phase: options.supported ? 'checking' : 'unsupported', datasets: {} };
    setHealth(initial); opts.current.onHealth?.(initial);
    if (!options.sessionKey || !options.encryptionKey || !options.ownerPubkey || !options.supported || !options.ready) return;
    if (stopped) return;
    let cancelled = false, running = false, dirty = false, failures = 0, refused = false, held = false;
    let wanted: CycleKind | null = 'full';
    const want = (kind: CycleKind) => { if (!wanted || CYCLE_RANK[kind] > CYCLE_RANK[wanted]) wanted = kind; };
    const noteRefusal = (err: unknown) => { if (isVaultApprovalError(err)) refused = true; };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest = initial;
    const valid = () => !cancelled && currentSession.current === session;
    // Per-purpose revision last verified in this effect run; a full cycle re-establishes them.
    const verifiedRevisions = new Map<string, string>();
    // Datasets a held cycle never reached: the next cycle runs them whatever its kind.
    const forced = new Set<string>();
    const needsSync = async (job: PrivateVaultJob, kind: CycleKind): Promise<boolean> => {
      const purpose = vaultPurpose(job.adapter.dataset);
      if (kind === 'full' || forced.has(purpose) || latest.datasets[purpose]?.state !== 'verified') return true;
      if (kind === 'retry') return false;
      const revision = verifiedRevisions.get(purpose);
      if (!revision) return true;
      try { return vaultContentHash(await job.adapter.snapshot()) !== revision; } catch { return true; }
    };
    const emit = (next: PrivateVaultHealth) => {
      if (!valid()) return;
      latest = next; setHealth(next); opts.current.onHealth?.(next);
    };
    const schedule = (delay: number, kind?: CycleKind) => {
      if (!valid()) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { if (kind) want(kind); void run(); }, delay);
    };
    const run = async () => {
      if (!valid()) return;
      if (running) { dirty = true; return; }
      // Held: the un-pause (or the cap) kicks a fresh cycle.
      if (isPaused()) return;
      const kind = wanted ?? 'retry';
      running = true; dirty = false; held = false; wanted = null;
      emit({ ...latest, phase: 'running' });
      try {
        let merged = false;
        const jobs = (await opts.current.jobs(valid)).map(job => observeRefusals(job, noteRefusal));
        for (const [index, job] of jobs.entries()) {
          if (!valid()) return;
          // One refusal is enough: every further dataset would only queue
          // more cards on a device that has just said no.
          if (refused) break;
          // Device-free: snapshots read only local storage.
          if (!await needsSync(job, kind)) continue;
          if (!valid()) return;
          // A sign-in took the device: leave the rest for when it is done.
          // A change/retry set is recomputed next time; a full one is not, so
          // its unreached datasets are carried over.
          if (isPaused()) {
            held = true;
            if (kind === 'full') for (const rest of jobs.slice(index)) forced.add(vaultPurpose(rest.adapter.dataset));
            want(kind === 'full' ? 'change' : kind);
            break;
          }
          const result = await syncPrivateVaultDataset({ adapter: job.adapter, resolve: job.resolve,
            ownerPubkey: options.ownerPubkey!, encryptionKey: options.encryptionKey!,
            relays: opts.current.relays, allowInitialPublish: opts.current.migrationReady, isCurrent: valid, now: Math.floor(Date.now() / 1000) });
          if (!valid()) return;
          merged ||= !!result.merged;
          const purpose = vaultPurpose(job.adapter.dataset);
          forced.delete(purpose);
          if (result.state === 'verified' && result.revision) verifiedRevisions.set(purpose, result.revision);
          else verifiedRevisions.delete(purpose);
          // Once canonical, an offline retry must never re-enable legacy writes.
          const canonical = result.canonical || latest.datasets[purpose]?.canonical;
          emit({ phase: 'running', datasets: { ...latest.datasets, [purpose]: { ...result, canonical } } });
        }
        if (valid() && merged) opts.current.onMerged();
        failures = Object.values(latest.datasets).some(d => d.state !== 'verified') ? failures + 1 : 0;
      } catch (err) { noteRefusal(err); failures++; }
      finally {
        running = false;
        if (refused && valid()) {
          // Stop: no timer, and kicks are ignored until the user approves.
          stoppedSession.current = session;
          emit({ ...latest, phase: 'idle', needsApproval: true });
        } else {
          emit({ ...latest, phase: 'idle' });
          // Held part-way: no timer — the un-pause kicks the next cycle. All
          // verified: nothing to retry, so no timer — edits and `online` kick.
          if (!held && dirty) schedule(1000);
          else if (!held && failures) schedule(Math.min(300000, 30000 * 2 ** Math.min(failures, 4)), 'retry');
        }
      }
    };
    kick.current = (kind: CycleKind = 'change') => {
      if (stoppedSession.current === session) return;
      want(kind);
      if (running) dirty = true; else schedule(1000);
    };
    const online = () => kick.current?.('full');
    window.addEventListener('online', online);
    void run();
    return () => {
      cancelled = true; kick.current = null;
      if (timer) clearTimeout(timer);
      window.removeEventListener('online', online);
    };
  }, [session, options.supported, options.ready, relayKey, options.ownerPubkey, options.approveToken]);

  // Un-pause (or the cap running out) kicks a cycle at once, replacing any
  // long backoff armed before the hold. Only on a real transition, so mount
  // does not double-run.
  const wasPaused = useRef(!!options.paused);
  useEffect(() => {
    const was = wasPaused.current;
    wasPaused.current = !!options.paused;
    if (!options.paused) { if (was) kick.current?.(); return; }
    const cap = setTimeout(() => kick.current?.(), PRIVATE_VAULT_PAUSE_CAP_MS + 50);
    return () => clearTimeout(cap);
  }, [options.paused]);

  const lastChangeToken = useRef(options.changeToken);
  useEffect(() => {
    if (lastChangeToken.current === options.changeToken) return;
    lastChangeToken.current = options.changeToken;
    kick.current?.();
  }, [options.changeToken]);
  return health;
}

export function legacyVaultWriteAllowed(health: PrivateVaultHealth, dataset: VaultDataset): boolean {
  if (health.phase === 'checking' || health.phase === 'unsupported') return false;
  const status = health.datasets[vaultPurpose(dataset)];
  return !!status && !status.canonical && status.state !== 'unusable' && status.state !== 'unavailable' && status.state !== 'waiting-legacy';
}
